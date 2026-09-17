const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

const allowedPowerFields = new Set([
  'useMenu',
  'useCreate',
  'useModify',
  'useDelete',
  'useExamine',
  'useFinish',
  'usePower',
]);

router.post('/insert', async (req, res) => {
  
  req.body.table = "gm_data_000.operator";
  req.body.operator = req.data.userName;
  req.body.dataBaseName = req.data.dataBase;
  // 初始密码统一哈希存储,不再明文落库 20260915 安全改造,
  req.body.password = await public.hashPassword(req.body.phone);
  req.body.isAccount = 0;

  delete req.body.idOperator;

  public.normalizeBodyDates(req.body);
  // joinDate 是 date 类型,只保留日期部分 20260915 清理,
  if (typeof req.body.joinDate === 'string' && req.body.joinDate.length > 10) {
    req.body.joinDate = req.body.joinDate.slice(0, 10);
  }
 
  // 参数化insert避免bcrypt哈希进入SQL文本被normalizeSql误替换 20260916 修复,
  const statement = public.getInsertStatement(req.body);
  try {
    const results = await pool.query(statement.sql, statement.params);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
router.post('/update', async (req, res) => {
  const idOperator = public.parseNumericParam(req.body.idOperator);
  if (idOperator === null) {
    return res.status(400).json({ error: 'idOperator参数错误!' });
  }

  // 目标操作员租户归属校验:非平台管理员仅可改本租户操作员;结果同时供 account 同步使用 20260917 越权收口,
  let targetDataBase = req.data.dataBase;
  try {
    const targetRows = await pool.query(
      'SELECT dataBaseName FROM gm_data_000.operator WHERE idOperator = ?',
      [idOperator],
    );
    if (!Array.isArray(targetRows) || targetRows.length === 0) {
      return res.status(404).json({ error: '数据不存在!' });
    }
    targetDataBase = targetRows[0].dataBaseName;
    if (!rbac.isPlatformAdmin(req) && targetDataBase !== req.data.dataBase) {
      return res.status(403).json({ error: '无权限:仅可操作本租户操作员!' });
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  const sqlList = [];
  req.body.table = "gm_data_000.operator";
  req.body.operator = req.data.userName;
  //处理id
  req.body.idfield ="idOperator";
  req.body.idvalue = idOperator;
  delete req.body.idOperator;

  public.normalizeBodyDates(req.body);
  // joinDate 是 date 类型,只保留日期部分 20260915 清理,
  if (typeof req.body.joinDate === 'string' && req.body.joinDate.length > 10) {
    req.body.joinDate = req.body.joinDate.slice(0, 10);
  }

  // 密码字段若随更新提交,统一哈希后再落库 20260915 安全改造,
  // 已是bcrypt哈希时跳过,防止前端回填的旧哈希被二次哈希导致登录失效 20260916 修复,
  if (req.body.password !== undefined && req.body.password !== '' && !public.isBcryptHash(req.body.password)) {
    req.body.password = await public.hashPassword(req.body.password);
  }

  //如果是账户则更新账户信息表,兼容前端传字符串"1"的情况
  if (Number(req.body.isAccount) === 1) {  
    // 用目标操作员所属租户同步 account,避免平台管理员跨租户操作时误改本租户账户 20260917 修复,
    const dataBaseName = targetDataBase;
    const accountUpdate = {
      operator: req.data.userName,
    };

    if (req.body.name !== undefined) {
      accountUpdate.head = req.body.name;
    }
    if (req.body.phone !== undefined) {
      accountUpdate.phone = req.body.phone;
    }

    const accountFields = Object.keys(accountUpdate);
    if (accountFields.length > 1) {
      // 收口到公共参数化 helper,避免手写 SET 子句 20260915 收口,
      sqlList.push(public.getUpdateByConditionStatement({
        table: 'gm_data_000.account',
        condition: { sql: 'dataBaseName = ?', params: [dataBaseName] },
        ...accountUpdate,
      }));
    }
  }
  const statement = public.getUpdateByIdStatement(req.body);
  sqlList.push(statement);
  return public.Transaction(sqlList,res);
});

router.post('/password', async (req, res) => {
  const idOperator = public.parseNumericParam(req.body.idOperator);
  if (idOperator === null) {
    return res.status(400).json({ error: 'idOperator参数错误!' });
  }

  // 先取出存储密码再比对:bcrypt哈希优先,兼容存量明文 20260915 安全改造,
  const sqlCheck = 'SELECT idOperator, dataBaseName, isAccount, password FROM gm_data_000.operator WHERE idOperator = ?';
  try {
    const results = await pool.query(sqlCheck, [idOperator]);
    if (results.length === 0) {
      res.status(200).json({ code: 0, data: 0});
      return;
    }

    const operatorInfo = results[0];
    // 租户归属校验在密码比对之前,避免对他人密码作跨租户暴力验证 20260917 越权收口,
    if (!rbac.isPlatformAdmin(req) && operatorInfo.dataBaseName !== req.data.dataBase) {
      return res.status(403).json({ error: '无权限:仅可操作本租户操作员!' });
    }
    const valid = await public.verifyPassword(req.body.oldPassword, operatorInfo.password);
    if (!valid) {
      res.status(200).json({ code: 0, data: 0});
      return;
    }

    const hashedNew = await public.hashPassword(req.body.newPassword);
    const sqlList = [];
    const operatorUpdate = {
      idvalue: idOperator,
      idfield:  'idOperator',
      table: 'gm_data_000.operator',
      password: hashedNew,
      operator: req.data.userName,
    };
    sqlList.push(public.getUpdateByIdStatement(operatorUpdate));

    if (operatorInfo.isAccount === 1) {
      sqlList.push({
        sql: 'update gm_data_000.account set password = ?, operator = ?, modifyDate = ? where dataBaseName = ?',
        params: [hashedNew, req.data.userName, public.getCurrentDateTime(), operatorInfo.dataBaseName],
      });
    }

    await pool.withTransaction(sqlList);
    return res.status(200).json({ code: 0, data: 1 });
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});

router.post('/power', async (req, res) => {
  const idPower = public.parseNumericParam(req.body.idPower);
  if (idPower === null) {
    return res.status(400).json({ error: 'idPower参数错误!' });
  }

  const field = req.body.field;
  if (!allowedPowerFields.has(field)) {
    return res.status(400).json({ error: 'field参数错误!' });
  }

  // 非平台管理员仅可切换本租户操作员的权限 20260917 越权收口,
  const tenantSql = rbac.isPlatformAdmin(req)
    ? 'where idPower = ?'
    : 'where idPower = ? and idOperator in (select idOperator from gm_data_000.operator where dataBaseName = ?)';
  const sqlParams = rbac.isPlatformAdmin(req) ? [idPower] : [idPower, req.data.dataBase];
  const sql = `update gm_data_000.operator_power
    set ${field} = case when ${field} = 1 then 0 else 1 end
    ${tenantSql}`;
  try {
    const results = await pool.query(sql, sqlParams);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
})
