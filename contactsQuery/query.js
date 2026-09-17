const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 墓位联系查询：contacts 关联 room 逐条返回联系人记录，支持关键词多字段模糊查询与服务端分页 20260913 新增
router.get('/list', async (req, res) => {
    const conditions = ['c.isDeleted = 0'];
    const params = [];

    // 关键词模糊查询：区域/园区/墓区编号/联系人/联系人电话/身份证号任一字段包含即命中 20260913 新增
    const keyword = String(req.query.keyword || '').trim();
    if (keyword) {
        conditions.push(
            '(r.region LIKE ? OR r.park LIKE ? OR r.xyNumber LIKE ? OR c.contacts LIKE ? OR c.contactsPhone LIKE ? OR c.contactsIDCard LIKE ?)',
        );
        const like = `%${keyword}%`;
        params.push(like, like, like, like, like, like);
    }

    // 分页参数：current 从 1 起，pageSize 限制 1-100 防止恶意大页 20260913 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const whereSql = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) AS total
    FROM ${req.data.dataBase}.contacts c JOIN ${req.data.dataBase}.room r ON c.idRoom = r.idRoom
    WHERE ${whereSql}`;

    try {
        const countResults = await pool.query(countSql, params);
        const total = countResults[0].total;

        const dataSql = `SELECT c.idContacts, c.idRoom, r.region, r.park, r.xyNumber, c.contacts, c.contactsPhone, c.contactsIDCard, c.remark, c.operator, c.createDate
    FROM ${req.data.dataBase}.contacts c JOIN ${req.data.dataBase}.room r ON c.idRoom = r.idRoom
    WHERE ${whereSql}
    ORDER BY c.createDate DESC, c.idContacts DESC
    LIMIT ? OFFSET ?`;

        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        // 分页结果：list 当前页数据，total 总记录数供前端滚动加载使用 20260913 新增
        return res.json({ code: 0, data: { list: results, total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
