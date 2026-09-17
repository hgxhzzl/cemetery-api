const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 墓区预定登记:插入预定记录并将墓位销售状态置为预定,事务保证两表一致 20260902 新增,
router.post('/insert', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  req.body.table = req.data.dataBase + '.reserve';
  req.body.operator = req.data.userName;

  delete req.body.idReserve;

  const reserveStatement = public.getInsertStatement(req.body);
  let sqlList = [];
  sqlList.push(reserveStatement);
  let json = {};
  json.table = req.data.dataBase + '.room';
  json.operator = req.data.userName;
  json.idfield = 'idRoom';
  json.idvalue = idRoom;
  json.saleStatus = 'statusType.saleStatusEnum.reserve';
  json.reserveStatus = 'statusType.reserveStatusEnum.reserved';
  const sqlRoom = public.getUpdateByIdStatement(json);
  sqlList.push(sqlRoom);

  return public.Transaction(sqlList, res);
});

// 修改预定:仅更新预定记录的联系人/电话/备注等字段,墓位状态不变 20260907 新增,
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idReserve = public.parseNumericParam(req.body.idReserve);
  if (idReserve === null) {
    return res.status(400).json({ error: 'idReserve参数错误!' });
  }

  req.body.table = req.data.dataBase + '.reserve';
  req.body.operator = req.data.userName;
  req.body.idfield = 'idReserve';
  req.body.idvalue = idReserve;
  delete req.body.idReserve;
  // 墓位不变,无需更新外键 idRoom
  delete req.body.idRoom;

  const statement = public.getUpdateByIdStatement(req.body);
  try {
    const results = await pool.query(statement.sql, statement.params);
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
