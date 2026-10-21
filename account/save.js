const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
const loginState = require('../loginState');
// 库名形态口径与登录/验签闸门同源(20261021 审查修复二轮 P0-1),
const tenant = require('../tenant');
module.exports = router;

// 全局管理接口:账户增删改与建库仅平台管理员可操作 20260917 越权收口,
router.use(rbac.requirePlatformAdmin);

router.post('/insert', async (req, res) => {

  public.normalizeBodyDates(req.body);
  // 库名形态与登录/验签闸门同源(20261021 审查修复二轮 P0-1):account.dataBaseName 就是租户身份的源头,
  // 写入一个不合法的名字既可能让该租户永远登录不了,也可能成为后续拼库名的载体,因此在入口直接拒,
  if (!tenant.isValidNameShape(req.body.dataBaseName)) {
    return res.status(400).json({ error: 'dataBaseName 不合法:仅允许小写字母开头的字母/数字/下划线(2-32 位)' });
  }
  const sqlList = [];
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
  const accountPassword = await public.hashPassword(submittedPassword || initialPassword);
  let json ={};
  json.table ="gm_data_000.operator";
  json.phone = req.body.phone;
  json.name = req.body.head;
  json.password = accountPassword;
  json.isAccount = 1;
  json.useStatus =req.body.useStatus
  json.operator = req.data.userName;
  json.dataBaseName=req.body.dataBaseName;

  // account 表同步存哈希密码,避免明文落库;无提交值时也要写入随机生成的哈希 20260915 安全改造, 20261021 审查修复 中E 调整,
  req.body.password = accountPassword;

  // 参数化insert避免bcrypt哈希进入SQL文本被normalizeSql误替换 20260916 修复,
  let sqlOperator = public.getInsertStatement(json);
  sqlList.push(sqlOperator);

  // 新账户默认菜单权限:基础设置(102100)仅可见,操作人员(102104)全权限 20260916 新增,
  // 先捕获刚插入 operator 的自增ID到用户变量,避免后续 operator_power 自增主键覆盖 LAST_INSERT_ID,
  sqlList.push('set @newOperatorId = LAST_INSERT_ID()');
  const defaultPowerMenus = [
    { idMenu: '102100', useCreate: 0, useModify: 0, useDelete: 0, usePower: 0 },
    { idMenu: '102104', useCreate: 1, useModify: 1, useDelete: 1, usePower: 1 },
  ];
  defaultPowerMenus.forEach((menu) => {
    sqlList.push({
      sql: 'insert into gm_data_000.operator_power (idOperator, idMenu, useMenu, useCreate, useModify, useDelete, useExamine, useFinish, usePower) values (@newOperatorId, ?, 1, ?, ?, ?, 0, 0, ?)',
      params: [menu.idMenu, menu.useCreate, menu.useModify, menu.useDelete, menu.usePower],
    });
  });

  req.body.table ="gm_data_000.account";
  req.body.operator = req.data.userName;
  delete req.body.idAccount;
 
  // 参数化insert避免bcrypt哈希进入SQL文本被normalizeSql误替换 20260916 修复,
  let sqlAccount = public.getInsertStatement(req.body);
  sqlList.push(sqlAccount);

  // 随机生成的初始口令仅在成功响应里回显一次(库中只存哈希,事后取不回) 20261021 审查修复 中E,
  return public.Transaction(sqlList, res, initialPassword ? { data: { initialPassword } } : {});
});
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idAccount = public.parseNumericParam(req.body.idAccount);
  if (idAccount === null) {
    return res.status(400).json({ error: 'idAccount参数错误!' });
  }

  const accountUpdate = { ...req.body };
  // 密码修改统一哈希存储,避免明文落库 20260915 安全改造,
  // 已是哈希值(bcrypt 存量或 scrypt 新版)时跳过,防止二次哈希导致登录失效 20260916 修复, 20261021 审查修复二轮 P1-6 调整,
  let passwordUpdated = false;
  if (accountUpdate.password !== undefined && accountUpdate.password !== '' && !public.looksHashed(accountUpdate.password)) {
    accountUpdate.password = await public.hashPassword(accountUpdate.password);
    passwordUpdated = true;
  }
  accountUpdate.table = "gm_data_000.account";
  accountUpdate.operator = req.data.userName;
  accountUpdate.idfield = "idAccount";
  accountUpdate.idvalue = idAccount;
  delete accountUpdate.idAccount;
  // 参数化update避免bcrypt哈希进入SQL文本被normalizeSql误替换 20260916 修复,
  const sqlList = [public.getUpdateByIdStatement(accountUpdate)];

  // 账户口令被真正改动时作废它名下的活跃登录态:登录态以 operator.phone 为键,
  // 改完密码不让旧 token 继续有效 20261021 审查修复 P0-3,
  // 20261021 审查修复二轮 P2-22:同样排到 commit 之后,避免事务回滚了却把人踢下线,
  const onCommitted = () => {
    if (!passwordUpdated || !req.body.dataBaseName) {
      return;
    }
    (async () => {
      const phoneRows = await pool.query(
        'SELECT phone FROM gm_data_000.operator WHERE dataBaseName = ? AND isAccount = 1',
        [req.body.dataBaseName],
      );
      for (const row of phoneRows || []) {
        await loginState.deleteActiveLogin(row.phone);
      }
    })().catch((error) => {
      console.error('revoke login session failed:', error);
    });
  };

  if (req.body.dataBaseName) {
    const operatorUpdate = {
      operator: req.data.userName,
    };

    if (req.body.head !== undefined) {
      operatorUpdate.name = req.body.head;
    }
    if (req.body.phone !== undefined) {
      operatorUpdate.phone = req.body.phone;
    }
    if (req.body.password !== undefined && req.body.password !== '' && !public.looksHashed(req.body.password)) {
      // 密码修改统一哈希存储 20260915 安全改造,
      operatorUpdate.password = await public.hashPassword(req.body.password);
    }
    if (req.body.useStatus !== undefined) {
      operatorUpdate.useStatus = req.body.useStatus;
    }

    const operatorFields = Object.keys(operatorUpdate);
    if (operatorFields.length > 1) {
      // 收口到公共参数化 helper,避免手写 SET 子句 20260915 收口,
      sqlList.push(public.getUpdateByConditionStatement({
        table: 'gm_data_000.operator',
        condition: { sql: 'dataBaseName = ? and isAccount = ?', params: [req.body.dataBaseName, 1] },
        ...operatorUpdate,
      }));
    }
  }

  return public.Transaction(sqlList,res, { onCommitted });

});

router.post('/createDataBase', async (req, res) => {
  const dataBaseName = req.body.dataBaseName;
  // 库名形态统一走租户闸门同一口径(20261021 审查修复二轮 P0-1):本接口新建的库最终要能登录,
  // 因此不允许出现“建得出库但闸门不认”的名字(如带大写/非法字符),
  if (!tenant.isValidNameShape(dataBaseName)) {
    return res.status(400).json({ error: '库名不合法:仅允许小写字母开头的字母/数字/下划线(2-32 位)' });
  }

  if (dataBaseName === 'gm_data_000') {
    return res.status(200).json({ code: 0 });
  }

  // 已存在同名库时拒绝创建,避免 DROP 误删业务数据 20260917 收口,
  try {
    const existing = await pool.query(
      'SELECT COUNT(*) AS cnt FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?',
      [dataBaseName],
    );
    if (existing.length > 0 && Number(existing[0].cnt) > 0) {
      return res.status(409).json({ error: '数据库已存在,禁止重复创建!' });
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  // 全局表(仅存在于模板库,业务库不复制);contract/device 均为全局表,业务库不复制 20260926 修正,
  const globalTables = ['account', 'account_power', 'menu', 'operator',
     'operator_power', 'login_session', 'contract','device'];

  // 从 information_schema 动态读取模板库实有表/视图,替代手写 tableDefinitions 清单,
  // 新增业务表无需再手动维护,由模板库结构自动同步 20260917 动态对齐,
  let templateTables = [];
  let templateViews = [];
  try {
    const tableRows = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'gm_data_000' AND table_type = 'BASE TABLE'",
    );
    templateTables = tableRows.map((row) => String(row.table_name).toLowerCase());
    const viewRows = await pool.query(
      "SELECT table_name FROM information_schema.views WHERE table_schema = 'gm_data_000'",
    );
    templateViews = viewRows.map((row) => String(row.table_name).toLowerCase());
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  // 校验模板库全局表齐备,缺失说明 gm_data_000 结构异常,仅告警不阻断 20260917 新增,
  const missingGlobal = globalTables.filter((name) => !templateTables.includes(name));
  if (missingGlobal.length > 0) {
    console.warn('[createDataBase] gm_data_000 缺失全局表:', missingGlobal.join(', '));
  }

  // 业务表 = 模板库基础表 - 全局表 20260917 动态对齐,
  const businessTables = templateTables.filter((name) => !globalTables.includes(name));

  const sqlList = [];
  sqlList.push(`CREATE DATABASE ${dataBaseName} CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);

  businessTables.forEach((name) => {
    sqlList.push(`CREATE TABLE ${dataBaseName}.${name} LIKE gm_data_000.${name}`);
  });

  // 业务视图动态复制:按模板库 SHOW CREATE VIEW 提取选择部分,替代手写 CREATE VIEW,
  // 视图定义中未限定的表名会按创建时连接的默认库(gm_data_000)固化,必须显式改写为本库表名;
  // 否则新租户库视图仍指向模板库数据(gm_data_002.v_region_park 曾因此错查 gm_data_000.room) 20260919 修复,
  for (const viewName of templateViews) {
    try {
      const createRows = await pool.query('SHOW CREATE VIEW `gm_data_000`.`' + viewName + '`');
      const createView = String(createRows[0]['Create View'] || '');
      const match = createView.match(/VIEW `[^`]+` AS (.+)$/s);
      if (!match) {
        console.warn('[createDataBase] 视图定义解析失败:', viewName);
        continue;
      }
      // 视图引用的业务表加目标库前缀,避免未限定表名被固化到连接默认库 20260919 修复,
      const selectPart = match[1].replace(/`room`/g, '`' + dataBaseName + '`.`room`');
      sqlList.push(`CREATE VIEW ${dataBaseName}.${viewName} AS ${selectPart}`);
    } catch (error) {
      console.warn('[createDataBase] 读取视图定义失败:', viewName, error.message);
    }
  }
  if (templateViews.length === 0) {
    console.warn('[createDataBase] gm_data_000 无视图,业务库将不含视图');
  }

  return public.Transaction(sqlList,res);
});

