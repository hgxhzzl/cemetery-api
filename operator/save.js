const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
const loginState = require('../loginState');
module.exports = router;

// 菜单总开关(useMenu)单字段翻转白名单:旧的 useCreate/useModify/useDelete/useExamine/useFinish/usePower
// 布尔列已迁移到功能权限矩阵(powerConfig 白名单,经 /operatorPower-save/config 整块写入),此处不再受理 20261023,
const allowedPowerFields = new Set(['useMenu']);

// 修改操作员的可写列白名单:只收业务字段,body 里其余字段一律不落库 20261021 审查修复 中F,
// (table/operator/idfield/idvalue 是语句构造元信息,不在此列但也不能被剔除)
const allowedOperatorUpdateFields = new Set([
  'name',
  'phone',
  'duties',
  'team',
  'useStatus',
  'region',
  'joinDate',
  'isMaintenance',
  'termYears',
  'password',
]);
// 提权列:isAccount=1 就是平台管理员、dataBaseName 决定租户归属,只能由平台管理员修改 20261021 审查修复 中F,
const privilegedOperatorFields = new Set(['isAccount', 'dataBaseName']);
// 语句构造元信息:由本接口自己赋值,不参与白名单判定(createDate/modifyDate 不在此列,客户端提交一律剔除)
const statementMetaFields = new Set(['table', 'operator', 'idfield', 'idvalue']);

router.post('/insert', async (req, res) => {
  
  req.body.table = "gm_data_000.operator";
  req.body.operator = req.data.userName;
  req.body.dataBaseName = req.data.dataBase;
  // 初始口令不再取手机号(登录名就是手机号,等于口令公开):提交值须过强度校验,缺省时服务端随机生成并一次性回显 20261021 审查修复 中E,
  const submittedPassword = req.body.password === undefined || req.body.password === null ? '' : String(req.body.password);
  let initialPassword = '';
  if (submittedPassword !== '') {
    const passwordError = public.validateSubmittedPassword(submittedPassword, req.body.phone);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
    }
  } else {
    initialPassword = public.generateInitialPassword();
  }
  // 初始密码统一哈希存储,不再明文落库 20260915 安全改造,
  req.body.password = await public.hashPassword(submittedPassword || initialPassword);
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
    // 随机生成的初始口令仅在成功响应里回显一次(库中只存哈希,事后取不回) 20261021 审查修复 中E,
    return public.respondAffectedRows(res, results, initialPassword ? { data: { initialPassword } } : {});
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
  // isAccount 一并取出:是否为账户操作员以库中事实为准,不信客户端提交值 20261021 审查修复 中F,
  // phone 也取出:改密时需据此作废该操作员的活跃登录态 20261021 审查修复 P0-3,
  let targetDataBase = req.data.dataBase;
  let targetIsAccount = false;
  let targetPhone = '';
  try {
    const targetRows = await pool.query(
      'SELECT dataBaseName, isAccount, phone FROM gm_data_000.operator WHERE idOperator = ?',
      [idOperator],
    );
    if (!Array.isArray(targetRows) || targetRows.length === 0) {
      return res.status(404).json({ error: '数据不存在!' });
    }
    targetDataBase = targetRows[0].dataBaseName;
    targetIsAccount = Number(targetRows[0].isAccount) === 1;
    targetPhone = targetRows[0].phone;
    if (!rbac.isPlatformAdmin(req) && targetDataBase !== req.data.dataBase) {
      return res.status(403).json({ error: '无权限:仅可操作本租户操作员!' });
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  // 列白名单过滤:非平台管理员提交的提权列直接丢弃,其余非白名单列也不原样落库 20261021 审查修复 中F,
  // (否则操作员自己就能把 isAccount 改成 1 拿到平台管理员身份,或把 dataBaseName 改到其他租户)
  const canWritePrivilegedFields = rbac.isPlatformAdmin(req);
  Object.keys(req.body).forEach((key) => {
    if (statementMetaFields.has(key)) {
      return;
    }
    if (privilegedOperatorFields.has(key)) {
      if (!canWritePrivilegedFields) {
        delete req.body[key];
      }
      return;
    }
    if (!allowedOperatorUpdateFields.has(key)) {
      delete req.body[key];
    }
  });

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
  // 已是哈希值(bcrypt 存量或 scrypt 新版)时跳过,防止前端回填的旧哈希被二次哈希导致登录失效 20260916 修复, 20261021 审查修复二轮 P1-6 调整,
  let passwordUpdated = false;
  if (req.body.password !== undefined && req.body.password !== '' && !public.looksHashed(req.body.password)) {
    req.body.password = await public.hashPassword(req.body.password);
    passwordUpdated = true;
  }

  //如果是账户则更新账户信息表:按库中 isAccount 事实判定,不采用客户端提交值 20261021 审查修复 中F 调整,
  if (targetIsAccount) {  
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

  // 口令在本次更新里被真正改动时作废该操作员的活跃登录态:旧 token 不应在到期前继续可用 20261021 审查修复 P0-3,
  // 20261021 审查修复二轮 P2-22:撤销动作从“事务前”排到“commit 后”——旧写法在写库事务提交前就删了会话,
  // 事务一旦回滚(口令没改成)人却被踢下线,且下一行还要靠它自己的 try 兜底,现与守卫缓存作废合并到同一个回调里,
  function onCommitted() {
    // 区域/提权列变更后作废守卫缓存,不等 30s TTL 自然过期(审查修复 20261021 P2 性能),
    rbac.invalidateAuthCaches();
    if (passwordUpdated && targetPhone) {
      loginState.deleteActiveLogin(targetPhone).catch((error) => {
        console.error('revoke login session failed:', error);
      });
    }
  }

  return public.Transaction(sqlList, res, { onCommitted });
});

router.post('/password', async (req, res) => {
  const idOperator = public.parseNumericParam(req.body.idOperator);
  if (idOperator === null) {
    return res.status(400).json({ error: 'idOperator参数错误!' });
  }

  // 先取出存储密码再比对:bcrypt哈希优先,兼容存量明文 20260915 安全改造,
  // phone 一并取出供新口令强度校验(不得等于登录手机号)复用,避免多一次回查 20261021 审查修复 中E,
  const sqlCheck = 'SELECT idOperator, dataBaseName, isAccount, password, phone FROM gm_data_000.operator WHERE idOperator = ?';
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
    // 新口令强度校验:不得少于 6 位、不得与登录手机号相同(与新建同口径) 20261021 审查修复 中E,
    const passwordError = public.validateSubmittedPassword(req.body.newPassword, operatorInfo.phone);
    if (passwordError) {
      return res.status(400).json({ error: passwordError });
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
    // 改密成功后立刻作废服务端登录态,迫使持旧 token 的会话重新登录(前端据此回到登录页) 20261021 审查修复 P0-3,
    try {
      await loginState.deleteActiveLogin(operatorInfo.phone);
    } catch (error) {
      console.error('revoke login session failed:', error);
    }
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
    rbac.invalidateAuthCaches();
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
})
