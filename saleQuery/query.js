const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 墓区销售查询：sale 关联 room 逐条返回销售单，支持区域/园区/时间段过滤与服务端分页 20260911 修改,
router.get('/list', async (req, res) => {
    const conditions = ['s.isDeleted = 0'];
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

    const startDate = String(req.query.startDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(startDate)) {
        conditions.push('s.createDate >= ?');
        params.push(`${startDate.slice(0, 10)} 00:00:00`);
    }

    const endDate = String(req.query.endDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(endDate)) {
        conditions.push('s.createDate <= ?');
        params.push(`${endDate.slice(0, 10)} 23:59:59`);
    }

    // 分页参数：current 从 1 起，pageSize 限制 1-100 防止恶意大页 20260911 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const whereSql = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) AS total, COALESCE(SUM(s.realPrice), 0) AS totalAmount
    FROM ${req.data.dataBase}.sale s JOIN ${req.data.dataBase}.room r ON s.idRoom = r.idRoom
    WHERE ${whereSql}`;

    try {
        const countResults = await pool.query(countSql, params);
        const total = countResults[0].total;
        // 金额合计：SUM 可能返回 DECIMAL 字符串，统一转 Number 供前端千分位格式化 20260913 新增
        const totalAmount = Number(countResults[0].totalAmount) || 0;

        const dataSql = `SELECT s.idSale, s.idRoom, r.region, r.park, r.xyNumber, r.price, s.realPrice, s.payer, s.payerPhone, s.createDate
    FROM ${req.data.dataBase}.sale s JOIN ${req.data.dataBase}.room r ON s.idRoom = r.idRoom
    WHERE ${whereSql}
    ORDER BY s.createDate DESC, s.idSale DESC
    LIMIT ? OFFSET ?`;

        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        // 分页结果：list 当前页数据，total 总记录数供前端分页组件使用 20260911 新增
        return res.json({ code: 0, data: { list: results, total, totalAmount } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
