const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

router.get('/', async (req, res) => {
  const idContract = public.parseNumericParam(req.query.idContract);
  if (idContract === null) {
    return res.status(400).json({ error: 'idContract参数错误!' });
  }

  let body = {};
  // 合同改为全局共享,表固定 gm_data_000.contract 20260926 修正,
  body.table = "gm_data_000.contract";
  body.operator = req.data.userName;
  body.idfield ="idContract";
  body.idvalue = idContract;
  body.isDeleted = 1;

  const statement = public.getDeleteByIdSql(body);

  try {
    const results = await pool.query(statement.sql, statement.params);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
