const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 墓位列表:返回该区域(园区可选)全部墓位,与墓区下葬页 /room 口径一致,供卡片按下葬状态判定 新建/修改/删除;
// 管理费收款锚定首次下葬,故沿用下葬页墓位查询(去掉已售/未下葬满过滤,避免已满/未售墓位被误显示为空位) 20260909 新增,
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

// 按墓位查询全部活动管理费收款记录(供"多次收款"的修改/删除选择),按 idAdminfee DESC,[0] 为最新 20260909 新增,
router.get('/', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  const sql = `SELECT * FROM ${req.data.dataBase}.adminfee WHERE isDeleted = 0 AND idRoom = ? ORDER BY idAdminfee DESC`;
  try {
    const results = await pool.query(sql, [idRoom]);
    return public.respondList(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
