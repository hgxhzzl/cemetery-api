const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 下葬列表:返回该区域(园区可选)全部墓位(去掉已售/未下葬满过滤,与墓位管理页 /room/room 一致,避免已满/未售墓位被误显示为空位 20260908 修改),供卡片按下葬状态判定 新建/修改/删除;
// 取消预定/核对/完成三阶段的 reserve/examine/finish 派生列 20260907 修改,
router.get('/room', async (req, res) => {
  const park = String(req.query.park || '').trim();
  const region = String(req.query.region || '').trim();
  const table = req.data.dataBase + '.room';

  const conditions = ['isDeleted = 0', 'region = ?'];
  const params = [region];
  // 区域三级菜单进入时仅传区域不传园区,园区参数可选,为空时查该区域全部墓位 20260917 参数化,
  if (park) {
    conditions.push('park = ?');
    params.push(park);
  }
  const sql = `select * from ${table} where ${conditions.join(' AND ')} order by yNum asc, xNum asc`;

  try {
    const results = await pool.query(sql, params);
    return public.respondList(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});

// 按墓位查询全部活动下葬记录(供"多次下葬"的修改/删除选择);取消 isFinish='0' 过滤 20260907 修改,
router.get('/', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  const sql = `SELECT * FROM ${req.data.dataBase}.buried WHERE isDeleted = 0 AND idRoom = ? ORDER BY idBuried DESC`;
  try {
    const results = await pool.query(sql, [idRoom]);
    return public.respondList(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
