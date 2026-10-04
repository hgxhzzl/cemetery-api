const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

// 全局管理接口:账户删除仅平台管理员可操作 20260917 越权收口,
router.use(rbac.requirePlatformAdmin);

// 账户删除:事务内物理删除 account、该租户全部 operator、account_power、operator_power 四表记录 20260916 修改,20261004 调整为按 dataBaseName 删除全部操作员,
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

    // 账户删除意味着该租户下全部操作员都要删除,operator_power 通过子查询按 dataBaseName 匹配全部操作员ID,
    // 四表同事务物理删除:操作员菜单权限、全部操作员、账户菜单权限、账户,
    const sqlList = [];
    sqlList.push({
      sql: `DELETE FROM gm_data_000.operator_power WHERE idOperator IN (
        SELECT idOperator FROM gm_data_000.operator WHERE dataBaseName = ?
      )`,
      params: [dataBaseName],
    });
    sqlList.push({
      sql: 'DELETE FROM gm_data_000.operator WHERE dataBaseName = ?',
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
