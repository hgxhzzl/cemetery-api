const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 按墓位查询当前活动业务记录,用于表单回填:代码独立但数据表复用原有表——
// type=sale 查 sale 表并 LEFT JOIN buried(条件同 idSale)带出安葬者/下葬日期/安葬者身份证号/逝者关系,
//   有对应 buried 记录则带入,无则为空;主键 idSale 别名 idBusiness 供前端判定新建/修改;
// type=reserve 查 reserve 表(liaison/liaisonPhone 映射为 payer/payerPhone),
// 默认查 graveplotbusiness 本业务表 20260923 修改,
router.get('/get-by-room', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }
  const type = req.query.type;

  let sql;
  if (type === 'sale') {
    sql = `SELECT s.*, b.deceased, b.burialDate, b.deceasedIDCard, b.deceasedRelation, s.idSale AS idBusiness
      FROM ${req.data.dataBase}.sale s
      LEFT JOIN ${req.data.dataBase}.buried b ON b.idSale = s.idSale AND b.isDeleted = 0
      WHERE s.idRoom = ? AND s.isDeleted = 0`;
  } else if (type === 'buried') {
    // 下葬形态:查 buried 表全部活动记录(倒序,前端取最新一条回填),主键别名 idBusiness 20260923 新增,
    sql = `SELECT *, idBuried AS idBusiness FROM ${req.data.dataBase}.buried WHERE idRoom = ? AND isDeleted = 0 ORDER BY idBuried DESC`;
  } else if (type === 'reserve') {
    sql = `SELECT idReserve AS idBusiness, idRoom, liaison AS payer, liaisonPhone AS payerPhone, remark, createDate
      FROM ${req.data.dataBase}.reserve WHERE idRoom = ? AND isDeleted = 0`;
  } else {
    sql = `SELECT * FROM ${req.data.dataBase}.graveplotbusiness WHERE idRoom = ? AND isDeleted = 0`;
  }
  try {
    const results = await pool.query(sql, [idRoom]);
    return public.respondList(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});

// 下葬形态联系人选择页数据:按墓位查全部活动联系人记录(倒序),本模块独立实现不复用 contacts 模块路由 20260923 新增,
router.get('/contacts-list', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  const sql = `SELECT * FROM ${req.data.dataBase}.contacts WHERE isDeleted = 0 AND idRoom = ? ORDER BY idContacts DESC`;
  try {
    const results = await pool.query(sql, [idRoom]);
    return public.respondList(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});

// 墓位列表(带预定人)：本页独立于 room/canSale 接口，LEFT JOIN 活动预定记录带出预定人 liaison，
// 有预定显示人名、无预定为 NULL(前端显示"无") 20260923 新增,
// 本页预定形态改写 reserve 表(复用原有数据表)后，卡片预定人即时反映，恢复纯 reserve 联查 20260923 修改,
router.get('/room-list', async (req, res) => {
  const conditions = ['r.isDeleted = 0', 'r.region = ?'];
  const params = [req.query.region];
  if (req.query.park) {
    conditions.push('r.park = ?');
    params.push(req.query.park);
  }
  // 子查询按 idRoom 去重活动预定记录(一穴多条历史预定仅取活动的一条)，MAX 兜底防重复行放大
  const sql = `SELECT r.*, rv.reserver FROM ${req.data.dataBase}.room r
    LEFT JOIN (SELECT idRoom, MAX(liaison) AS reserver FROM ${req.data.dataBase}.reserve WHERE isDeleted = 0 GROUP BY idRoom) rv
    ON rv.idRoom = r.idRoom
    WHERE ${conditions.join(' AND ')}`;
  try {
    const results = await pool.query(sql, params);
    return public.respondList(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
