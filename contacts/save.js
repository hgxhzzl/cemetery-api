const express = require('express');
const router = express.Router();
const public = require('../public');
const pool = require('../database');
module.exports = router;

// 新建墓位联系人:插入一条联系人记录;联系人与墓位下葬状态无关,不改墓位状态 20260909 新增,
router.post('/insert', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 重名判断:同一墓位下已存在同名活动联系人则拒绝提交 20260913 新增
  const contactsName = String(req.body.contacts || '').trim();
  try {
    const dupRows = await pool.query(
      'select idContacts from ' + req.data.dataBase + '.contacts where idRoom = ? and trim(contacts) = ? and isDeleted = 0 limit 1',
      [idRoom, contactsName],
    );
    if (dupRows.length > 0) {
      return res.status(400).json({ error: '该墓位已存在同名联系人"' + contactsName + '"，请勿重复提交!' });
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  req.body.table = req.data.dataBase + '.contacts';
  req.body.operator = req.data.userName;
  // idContacts 为自增主键,新建时剔除,由数据库自增 20260909 新增
  delete req.body.idContacts;

  const statement = public.getInsertStatement(req.body);
  // 新增后同步墓位 room.contacts 聚合字段(全部活动联系人空格分隔) 20260913 新增,
  return public.Transaction([statement, public.getRoomContactsSyncSql(req.data.dataBase, idRoom)], res);
});

// 修改墓位联系人:按 idContacts 更新选中的联系人记录;联系人与墓位下葬状态无关,不改墓位状态 20260909 新增,
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idContacts = public.parseNumericParam(req.body.idContacts);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idContacts === null) {
    return res.status(400).json({ error: 'idContacts参数错误!' });
  }
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 重名判断:同一墓位下其他活动联系人已存在同名则拒绝(排除自身) 20260913 新增
  const contactsName = String(req.body.contacts || '').trim();
  try {
    const dupRows = await pool.query(
      'select idContacts from ' + req.data.dataBase + '.contacts where idRoom = ? and trim(contacts) = ? and isDeleted = 0 and idContacts <> ? limit 1',
      [idRoom, contactsName, idContacts],
    );
    if (dupRows.length > 0) {
      return res.status(400).json({ error: '该墓位已存在同名联系人"' + contactsName + '"，请勿重复提交!' });
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  req.body.table = req.data.dataBase + '.contacts';
  req.body.operator = req.data.userName;
  req.body.idfield = 'idContacts';
  req.body.idvalue = idContacts;
  // idContacts 作为 where 条件,从 SET 子句剔除 20260909 新增
  delete req.body.idContacts;

  const statement = public.getUpdateByIdStatement(req.body);
  // 修改后同步墓位 room.contacts 聚合字段(全部活动联系人空格分隔) 20260913 新增,
  return public.Transaction([statement, public.getRoomContactsSyncSql(req.data.dataBase, idRoom)], res);
});
