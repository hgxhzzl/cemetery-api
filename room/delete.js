const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

router.get('/', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  let body = {};
  body.table = req.data.dataBase+".room";
  body.operator = req.data.userName;
  body.idfield ="idRoom";
  body.idvalue = idRoom;
  body.isDeleted = 1;

  const statement = public.getDeleteByIdSql(body);

  try {
    const results = await pool.query(statement.sql, statement.params);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
