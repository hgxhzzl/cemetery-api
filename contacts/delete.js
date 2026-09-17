const express = require('express');
const router = express.Router();
const public = require('../public');
module.exports = router;

// 删除墓位联系人:软删除选中的联系人记录(按 idContacts 置 isDeleted=1);
// 联系人与墓位下葬状态无关,删除后不回置墓位状态(区别于墓区下葬删除) 20260909 新增,
router.get('/', async (req, res) => {
  const idContacts = public.parseNumericParam(req.query.idContacts);
  if (idContacts === null) {
    return res.status(400).json({ error: 'idContacts参数错误!' });
  }
  // 前端已带 idRoom,用于软删除后同步墓位 room.contacts 20260913 新增
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 软删除选中的联系人记录(idContacts 已校验为纯数字,拼接安全)
  const json = {
    table: req.data.dataBase + '.contacts',
    idfield: 'idContacts',
    idvalue: idContacts,
    isDeleted: 1,
    operator: req.data.userName,
  };
  const statement = public.getUpdateByIdStatement(json);
  // 软删除后同步墓位 room.contacts 聚合字段(全部活动联系人空格分隔) 20260913 新增,
  return public.Transaction([statement, public.getRoomContactsSyncSql(req.data.dataBase, idRoom)], res);
});

