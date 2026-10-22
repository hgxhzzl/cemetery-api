const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 下葬登记页(菜单 103103)已于三轮下线,本前缀只保留墓位业务详情聚合的按墓位取数;
// 旧 /room(按区域/园区拉全部墓位供下葬页卡片判定)随登记页一并移除,墓位列表统一走 /api/room-query,
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
