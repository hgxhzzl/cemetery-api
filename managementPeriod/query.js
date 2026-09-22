const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 管理期限查询：room 表 endDate 落在时间段内的墓位，支持区域/园区/结束日期时间段过滤与服务端分页 20260915 新增
router.get('/list', async (req, res) => {
    // 已迁出的墓位不展示（迁出为终态，与前端卡片列表页规则一致）20260921 新增
    const conditions = [
        'r.isDeleted = 0',
        'r.endDate IS NOT NULL',
        '(r.transferOutStatus IS NULL OR r.transferOutStatus <> \'statusType.transferOutStatusEnum.out\')',
    ];
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

    // 单日期筛选：查询结束日期早于所选日期的墓位 20260915 调整
    const endDate = String(req.query.endDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(endDate)) {
        conditions.push('r.endDate < ?');
        params.push(endDate.slice(0, 10) + ' 00:00:00');
    }

    // 分页参数：current 从 1 起，pageSize 限制 1-100 防止恶意大页 20260915 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const whereSql = conditions.join(' AND ');

    // 联系人电话：room 表无电话列，从墓位联系人表聚合活动记录电话(空格分隔)，与 room.contacts 聚合模式一致 20260915 新增
    const countSql = 'SELECT COUNT(*) AS total FROM ' + req.data.dataBase + '.room r WHERE ' + whereSql;

    try {
        const countResults = await pool.query(countSql, params);
        const total = countResults[0].total;

        const dataSql = 'SELECT r.idRoom, r.region, r.park, r.xyNumber, r.endDate, r.contacts, ' +
            '(SELECT LEFT(GROUP_CONCAT(c.contactsPhone ORDER BY c.idContacts ASC SEPARATOR \' \'), 200) ' +
            'FROM ' + req.data.dataBase + '.contacts c WHERE c.idRoom = r.idRoom AND c.isDeleted = 0) AS contactsPhone ' +
            'FROM ' + req.data.dataBase + '.room r ' +
            'WHERE ' + whereSql + ' ' +
            'ORDER BY r.endDate DESC, r.idRoom DESC ' +
            'LIMIT ? OFFSET ?';

        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        // 分页结果：list 当前页数据，total 总记录数供前端滚动加载使用 20260915 新增
        return res.json({ code: 0, data: { list: results, total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
