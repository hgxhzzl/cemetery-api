const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 墓位迁出记录列表：transfer_out 关联 room 逐条返回迁出记录，支持区域/园区/迁出时间段过滤与服务端分页 20260916 新增
router.get('/list', async (req, res) => {
    const conditions = ['t.isDeleted = 0'];
    const params = [];

    const region = String(req.query.region || '').trim();
    if (region) {
        conditions.push('r.region = ?');
        params.push(region);
    }

    const park = String(req.query.park || '').trim();
    if (park) {
        conditions.push('r.park = ?');
        params.push(park);
    }

    // 时间段按迁出日期 transferOutDate 过滤 20260916 新增
    const startDate = String(req.query.startDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(startDate)) {
        conditions.push('t.transferOutDate >= ?');
        params.push(`${startDate.slice(0, 10)} 00:00:00`);
    }

    const endDate = String(req.query.endDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(endDate)) {
        conditions.push('t.transferOutDate <= ?');
        params.push(`${endDate.slice(0, 10)} 23:59:59`);
    }

    // 分页参数：current 从 1 起，pageSize 限制 1-100 防止恶意大页 20260916 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const whereSql = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) AS total
    FROM ${req.data.dataBase}.transfer_out t JOIN ${req.data.dataBase}.room r ON t.idRoom = r.idRoom
    WHERE ${whereSql}`;

    try {
        const countResults = await pool.query(countSql, params);
        const total = countResults[0].total;

        const dataSql = `SELECT t.idTransfer, t.idRoom, r.region, r.park, r.xyNumber, t.transferOutDate, t.destination, t.reason, t.contacts, t.contactsphone, t.operator, t.createDate
    FROM ${req.data.dataBase}.transfer_out t JOIN ${req.data.dataBase}.room r ON t.idRoom = r.idRoom
    WHERE ${whereSql}
    ORDER BY t.transferOutDate DESC, t.idTransfer DESC
    LIMIT ? OFFSET ?`;

        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        // 分页结果：list 当前页数据，total 总记录数供前端滚动加载使用 20260916 新增
        return res.json({ code: 0, data: { list: results, total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

// 墓位列表：返回该区域(园区可选)全部活动墓位，供卡片按迁出状态判定 新建/修改/删除 20260916 修改,
// 区域三级菜单进入时仅传区域不传园区，园区参数可选，为空时查该区域全部墓位；
// 区域为空(如查询统计下 105105 墓位迁出查询入口无 meta.region)时查全部区域墓位，兼容全区域查询视图
router.get('/room', async (req, res) => {
  const park = String(req.query.park || '').trim();
  const region = String(req.query.region || '').trim();
  const table = req.data.dataBase + '.room';

  const conditions = ['isDeleted = 0'];
  const params = [];
  if (region) {
    conditions.push('region = ?');
    params.push(region);
  }
  // 园区参数可选,为空时查该区域全部墓位;区域为空时查全部区域墓位,兼容全区域查询视图 20260917 参数化,
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

// 按墓位查询全部活动迁出记录(供迁出记录的修改/删除选择) 20260916 新增,
router.get('/', async (req, res) => {
  const idRoom = public.parseNumericParam(req.query.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  const sql = `SELECT * FROM ${req.data.dataBase}.transfer_out WHERE isDeleted = 0 AND idRoom = ? ORDER BY idTransfer DESC`;
  try {
    const results = await pool.query(sql, [idRoom]);
    return public.respondList(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});
