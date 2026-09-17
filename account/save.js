const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

// 全局管理接口:账户增删改与建库仅平台管理员可操作 20260917 越权收口,
router.use(rbac.requirePlatformAdmin);

router.post('/insert', async (req, res) => {

  public.normalizeBodyDates(req.body);
  const sqlList = [];
  // 初始密码统一哈希存储,不再明文落库 20260915 安全改造,
  const accountPassword = await public.hashPassword(req.body.password || req.body.phone);
  let json ={};
  json.table ="gm_data_000.operator";
  json.phone = req.body.phone;
  json.name = req.body.head;
  json.password = accountPassword;
  json.isAccount = 1;
  json.useStatus =req.body.useStatus
  json.operator = req.data.userName;
  json.dataBaseName=req.body.dataBaseName;

  // account 表同步存哈希密码,避免明文落库 20260915 安全改造,
  if (req.body.password !== undefined) {
    req.body.password = accountPassword;
  }

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
  
  return public.Transaction(sqlList,res);
});
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idAccount = public.parseNumericParam(req.body.idAccount);
  if (idAccount === null) {
    return res.status(400).json({ error: 'idAccount参数错误!' });
  }

  const accountUpdate = { ...req.body };
  // 密码修改统一哈希存储,避免明文落库 20260915 安全改造,
  // 已是bcrypt哈希时跳过,防止二次哈希导致登录失效 20260916 修复,
  if (accountUpdate.password !== undefined && accountUpdate.password !== '' && !public.isBcryptHash(accountUpdate.password)) {
    accountUpdate.password = await public.hashPassword(accountUpdate.password);
  }
  accountUpdate.table = "gm_data_000.account";
  accountUpdate.operator = req.data.userName;
  accountUpdate.idfield = "idAccount";
  accountUpdate.idvalue = idAccount;
  delete accountUpdate.idAccount;
  // 参数化update避免bcrypt哈希进入SQL文本被normalizeSql误替换 20260916 修复,
  const sqlList = [public.getUpdateByIdStatement(accountUpdate)];

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
    if (req.body.password !== undefined && req.body.password !== '' && !public.isBcryptHash(req.body.password)) {
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

  return public.Transaction(sqlList,res);

});

router.post('/createDataBase', async (req, res) => {
  const dataBaseName = req.body.dataBaseName;
  if (!dataBaseName || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(dataBaseName)) {
    return res.status(400).json({ error: 'Invalid database name' });
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

  // 全局表(仅存在于模板库,业务库不复制);contract 为每租户业务表,业务库复制 20260917 修正,
  const globalTables = ['account', 'account_power', 'menu', 'operator', 'operator_power', 'login_session'];

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
  // 视图定义中未限定的表名按所属库(业务库)自动解析,新增/修改模板视图无需再改代码 20260917 视图动态化,
  for (const viewName of templateViews) {
    try {
      const createRows = await pool.query('SHOW CREATE VIEW `gm_data_000`.`' + viewName + '`');
      const createView = String(createRows[0]['Create View'] || '');
      const match = createView.match(/VIEW `[^`]+` AS (.+)$/s);
      if (!match) {
        console.warn('[createDataBase] 视图定义解析失败:', viewName);
        continue;
      }
      sqlList.push(`CREATE VIEW ${dataBaseName}.${viewName} AS ${match[1]}`);
    } catch (error) {
      console.warn('[createDataBase] 读取视图定义失败:', viewName, error.message);
    }
  }
  if (templateViews.length === 0) {
    console.warn('[createDataBase] gm_data_000 无视图,业务库将不含视图');
  }

  return public.Transaction(sqlList,res);
});

