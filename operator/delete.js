const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

router.get('/', async (req, res) => {
  const idOperator = public.parseNumericParam(req.query.idOperator);
  if (idOperator === null) {
    return res.status(400).json({ error: 'idOperator参数错误!' });
  }

  let body = {};
  body.table = "gm_data_000.operator";
  body.operator = req.data.userName;
  body.idfield ="idOperator";
  body.idvalue = idOperator;
  body.isDeleted = 1;

  const statement = public.getDeleteByIdSql(body);

  try {
    // 非平台管理员仅可软删本租户操作员,防止跨租户禁用他人账号 20260917 越权收口,
    if (!rbac.isPlatformAdmin(req)) {
      const targetRows = await pool.query(
        'SELECT dataBaseName FROM gm_data_000.operator WHERE idOperator = ?',
        [idOperator],
      );
      if (!Array.isArray(targetRows) || targetRows.length === 0) {
        return res.status(404).json({ error: '数据不存在!' });
      }
      if (targetRows[0].dataBaseName !== req.data.dataBase) {
        return res.status(403).json({ error: '无权限:仅可操作本租户操作员!' });
      }
    }
    const results = await pool.query(statement.sql, statement.params);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
