const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

// 全局管理接口:账户删除仅平台管理员可操作 20260917 越权收口,
router.use(rbac.requirePlatformAdmin);

// 账户删除:事务内物理删除 account、operator(isAccount=1)、account_power、operator_power 四表记录 20260916 修改,
router.get('/', async (req, res) => {
  const idAccount = public.parseNumericParam(req.query.idAccount);
  if (idAccount === null) {
    return res.status(400).json({ error: 'idAccount参数错误!' });
  }

  try {
    // 先取账户的 dataBaseName,作为 operator 与 account_power 的关联键,
    const accountRows = await pool.query(
      'SELECT dataBaseName FROM gm_data_000.account WHERE idAccount = ? AND isDeleted = 0',
      [idAccount],
    );
    if (!Array.isArray(accountRows) || accountRows.length === 0) {
      return res.status(404).json({ code: 0, affectedRows: 0 });
    }

    const dataBaseName = accountRows[0].dataBaseName;

    // operator_power 通过 idOperator 关联,先查出账户对应操作员ID 20260916 修改,
    const operatorRows = await pool.query(
      'SELECT idOperator FROM gm_data_000.operator WHERE dataBaseName = ? AND isAccount = 1',
      [dataBaseName],
    );
    const idOperator = Array.isArray(operatorRows) && operatorRows.length > 0 ? operatorRows[0].idOperator : null;

    // 四表同事务物理删除:操作员菜单权限、对应登录操作员、账户菜单权限、账户,
    const sqlList = [];
    if (idOperator !== null) {
      sqlList.push({
        sql: 'DELETE FROM gm_data_000.operator_power WHERE idOperator = ?',
        params: [idOperator],
      });
    }
    sqlList.push({
      sql: 'DELETE FROM gm_data_000.operator WHERE dataBaseName = ? AND isAccount = 1',
      params: [dataBaseName],
    });
    sqlList.push({
      sql: 'DELETE FROM gm_data_000.account_power WHERE dataBaseName = ?',
      params: [dataBaseName],
    });
    sqlList.push({
      sql: 'DELETE FROM gm_data_000.account WHERE idAccount = ?',
      params: [idAccount],
    });

    const result = await pool.withTransaction(sqlList);
    return public.respondTransaction(res, result);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
