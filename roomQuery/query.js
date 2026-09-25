const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 墓位信息查询：room 主体关联活动销售记录，支持区域/园区/销售日期范围过滤与服务端分页 20260924 新增,
router.get('/list', async (req, res) => {
    const conditions = ['r.isDeleted = 0'];
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
    // 关键词：按墓区编号/购买人/联系人/电话/安葬者拼串包含查找 20260924 新增,
    const keyword = String(req.query.keyword || '').trim();
    if (keyword) {
        conditions.push("CONCAT(COALESCE(r.xyNumber,''),COALESCE(r.buyer,''),COALESCE(r.contacts,''),COALESCE(s.payerPhone,''),COALESCE(r.deceased,'')) LIKE ?");
        params.push(`%${keyword}%`);
    }

    // 销售状态/迁出状态多选过滤：一对复选框只勾其一时按该状态过滤，都勾或都不勾时不过滤 20260924 新增
    const sold = String(req.query.sold || '') === 'true';
    const unsold = String(req.query.unsold || '') === 'true';
    if (sold !== unsold) {
        conditions.push(sold ? 's.idRoom IS NOT NULL' : 's.idRoom IS NULL');
    }
    const out = String(req.query.out || '') === 'true';
    const notOut = String(req.query.notOut || '') === 'true';
    if (out !== notOut) {
        conditions.push(
            out
                ? "r.transferOutStatus = 'statusType.transferOutStatusEnum.out'"
                : "(r.transferOutStatus IS NULL OR r.transferOutStatus <> 'statusType.transferOutStatusEnum.out')",
        );
    }



    // 分页参数：current 从 1 起，pageSize 限制 1-100 防止恶意大页 20260924 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const whereSql = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) AS total
    FROM ${req.data.dataBase}.room r LEFT JOIN ${req.data.dataBase}.sale s ON s.idRoom = r.idRoom AND s.isDeleted = 0
    WHERE ${whereSql}`;

    try {
        const countResults = await pool.query(countSql, params);
        const total = countResults[0].total;

        // 选择销售日期范围时未销售墓位不满足 s.createDate 条件被自然排除，未选范围时展示全部墓位 20260924 新增
        const dataSql = `SELECT r.idRoom, r.region, r.park, r.xyNumber, r.buyer, s.payerPhone, s.createDate, r.deceased, r.contacts, r.transferOutStatus
    FROM ${req.data.dataBase}.room r LEFT JOIN ${req.data.dataBase}.sale s ON s.idRoom = r.idRoom AND s.isDeleted = 0
    WHERE ${whereSql}
    ORDER BY r.idRoom DESC
    LIMIT ? OFFSET ?`;

        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        return res.json({ code: 0, data: { list: results, total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
