const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 取消/删除预定:软删除该墓位的活动预定记录,并把墓位状态回置为未销售/未预定,事务保证两表一致 20260907 新增,
router.get('/', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 软删除该墓位的活动预定记录(idRoom 已校验为纯数字,参数化传递)
  const reserveJson = {
    table: req.data.dataBase + '.reserve',
    condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
    isDeleted: 1,
    operator: req.data.userName,
  };
  const sqlReserve = public.getUpdateByConditionStatement(reserveJson);

  // 墓位状态回置:未销售 + 未预定,与预定登记时的置位互为逆操作
  const roomJson = {
    table: req.data.dataBase + '.room',
    operator: req.data.userName,
    idfield: 'idRoom',
    idvalue: idRoom,
    saleStatus: 'statusType.saleStatusEnum.unsold',
    reserveStatus: 'statusType.reserveStatusEnum.unreserved',
  };
  const sqlRoom = public.getUpdateByIdStatement(roomJson);

  return public.Transaction([sqlReserve, sqlRoom], res);
});

