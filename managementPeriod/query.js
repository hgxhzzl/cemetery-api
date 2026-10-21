const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
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

    // 区域条件由 rbac 统一构造:指定区域走等值;未指定但操作员有区域名单时按名单 IN 收窄,
    // 堵住"省略 region 参数即取到全部区域数据"的越权口子 20261010 硬隔离,
    const regionCond = rbac.buildRegionCondition(req, 'r.region');
    if (regionCond) {
        conditions.push(regionCond.sql);
        params.push(...regionCond.params);
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
        const dataSql = 'SELECT r.idRoom, r.region, r.park, r.xyNumber, r.endDate, r.contacts, ' +
            '(SELECT LEFT(GROUP_CONCAT(c.contactsPhone ORDER BY c.idContacts ASC SEPARATOR \' \'), 200) ' +
            'FROM ' + req.data.dataBase + '.contacts c WHERE c.idRoom = r.idRoom AND c.isDeleted = 0) AS contactsPhone ' +
            'FROM ' + req.data.dataBase + '.room r ' +
            'WHERE ' + whereSql + ' ' +
            'ORDER BY r.endDate DESC, r.idRoom DESC ' +
            'LIMIT ? OFFSET ?';

        // 总数短 TTL 复用并与取数并发发出(审查修复 20261021 二轮 P2-14):同一筛选条件下翻页时总数不会变,
        // 而本页取数每行还要走一次联系人电话聚合子查询,串行两段就是白等一个往返, 20261021 改造,
        const [aggregate, results] = await Promise.all([
            public.queryAggregate(pool.query, { database: req.data.dataBase, sql: countSql, params }),
            pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]),
        ]);
        // 分页结果：list 当前页数据，total 总记录数供前端滚动加载使用 20260915 新增
        return res.json({ code: 0, data: { list: results, total: aggregate.total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
