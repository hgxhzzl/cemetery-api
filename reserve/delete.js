const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 取消/删除预定:软删除该墓位的活动预定记录,并把墓位预定状态回置为未预定、清空预定限期副本,事务保证多表一致 20260907 新增,
// 20261011 修正:不再回置 saleStatus——预定登记不动销售状态,取消自然也不动(否则会误把已销售墓位置成未销售),
router.post('/', async (req, res) => {
  const idRoom = public.parseNumericParam(public.readParam(req, 'idRoom'));
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
  const sqlReserve = public.getSoftDeleteByConditionStatement(reserveJson);

  // 墓位状态回置:只回预定状态,与置已预定互为逆操作(销售状态归销售/取消销售流程管) 20261011 修正,
  const roomJson = {
    table: req.data.dataBase + '.room',
    operator: req.data.userName,
    idfield: 'idRoom',
    idvalue: idRoom,
    reserveStatus: 'statusType.reserveStatusEnum.unreserved',
  };
  const sqlRoom = public.getUpdateByIdStatement(roomJson);

  // 墓位限期副本随预定一同清空:软删后已无活动预定记录,同步语句自然回 NULL 20261011 新增,
  const sqlReservationSync = public.getRoomReservationExpireSyncSql(req.data.dataBase, idRoom);

  return public.Transaction([sqlReserve, sqlRoom, sqlReservationSync], res);
});

