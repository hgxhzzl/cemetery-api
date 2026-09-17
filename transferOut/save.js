const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 新建迁出:插入一条迁出记录并把墓位迁出状态直接置为已迁出,事务保证两表一致 20260916 新增,
router.post('/insert', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  req.body.table = req.data.dataBase + '.transfer_out';
  req.body.operator = req.data.userName;
  delete req.body.idTransfer;

  const sqlList = [];
  sqlList.push(public.getInsertStatement(req.body));

  // 迁出登记同步更新墓位迁出状态为已迁出 20260916 新增,
  const json = {};
  json.table = req.data.dataBase + '.room';
  json.operator = req.data.userName;
  json.idfield = 'idRoom';
  json.idvalue = idRoom;
  json.transferOutStatus = 'statusType.transferOutStatusEnum.out';
  sqlList.push(public.getUpdateByIdStatement(json));

  return public.Transaction(sqlList, res);
});

// 修改迁出:按 idTransfer 更新选中的迁出记录,墓位保持已迁出 20260916 新增,
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idTransfer = public.parseNumericParam(req.body.idTransfer);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idTransfer === null) {
    return res.status(400).json({ error: 'idTransfer参数错误!' });
  }
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  const sqlList = [];
  req.body.table = req.data.dataBase + '.transfer_out';
  req.body.operator = req.data.userName;
  req.body.idfield = 'idTransfer';
  req.body.idvalue = idTransfer;
  delete req.body.idTransfer;

  sqlList.push(public.getUpdateByIdStatement(req.body));

  // 修改不改变迁出状态,墓位保持已迁出 20260916 新增,
  const json = {};
  json.table = req.data.dataBase + '.room';
  json.operator = req.data.userName;
  json.idfield = 'idRoom';
  json.idvalue = idRoom;
  json.transferOutStatus = 'statusType.transferOutStatusEnum.out';
  sqlList.push(public.getUpdateByIdStatement(json));

  return public.Transaction(sqlList, res);
});
