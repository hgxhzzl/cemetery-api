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
  body.table = req.data.dataBase+".contract";
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
