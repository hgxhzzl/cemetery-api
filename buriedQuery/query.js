const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 墓区下葬查询：buried 关联 room 逐条返回下葬记录，支持区域/园区/下葬时间段过滤与服务端分页 20260912 新增
router.get('/list', async (req, res) => {
    const conditions = ['b.isDeleted = 0'];
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

    // 时间段按下葬日期 burialDate 过滤：下葬查询关注实际下葬时间而非录入时间 20260912 新增
    const startDate = String(req.query.startDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(startDate)) {
        conditions.push('b.burialDate >= ?');
        params.push(`${startDate.slice(0, 10)} 00:00:00`);
    }

    const endDate = String(req.query.endDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(endDate)) {
        conditions.push('b.burialDate <= ?');
        params.push(`${endDate.slice(0, 10)} 23:59:59`);
    }

    // 分页参数：current 从 1 起，pageSize 限制 1-100 防止恶意大页 20260912 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const whereSql = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) AS total
    FROM ${req.data.dataBase}.buried b JOIN ${req.data.dataBase}.room r ON b.idRoom = r.idRoom
    WHERE ${whereSql}`;

    try {
        const countResults = await pool.query(countSql, params);
        const total = countResults[0].total;

        const dataSql = `SELECT b.idBuried, b.idRoom, r.region, r.park, r.xyNumber, b.deceased, b.deceasedIDCard, b.burialDate, b.contacts, b.contactsphone, b.remark, b.operator, b.createDate
    FROM ${req.data.dataBase}.buried b JOIN ${req.data.dataBase}.room r ON b.idRoom = r.idRoom
    WHERE ${whereSql}
    ORDER BY b.burialDate DESC, b.idBuried DESC
    LIMIT ? OFFSET ?`;

        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        // 分页结果：list 当前页数据，total 总记录数供前端滚动加载使用 20260912 新增
        return res.json({ code: 0, data: { list: results, total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
