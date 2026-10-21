const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

// 管理收款查询：adminfee 关联 room 逐条返回收款记录，支持区域/园区/收款时间段过滤与服务端分页 20260912 新增
router.get('/list', async (req, res) => {
    const conditions = ['a.isDeleted = 0'];
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

    // 时间段按收款创建日期 createDate 过滤：与销售查询模板保持一致 20260912 新增
    const startDate = String(req.query.startDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(startDate)) {
        conditions.push('a.createDate >= ?');
        params.push(`${startDate.slice(0, 10)} 00:00:00`);
    }

    const endDate = String(req.query.endDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(endDate)) {
        conditions.push('a.createDate <= ?');
        params.push(`${endDate.slice(0, 10)} 23:59:59`);
    }

    // 分页参数：current 从 1 起，pageSize 限制 1-100 防止恶意大页 20260912 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const whereSql = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) AS total, COALESCE(SUM(a.payAmount), 0) AS totalAmount
    FROM ${req.data.dataBase}.adminfee a JOIN ${req.data.dataBase}.room r ON a.idRoom = r.idRoom
    WHERE ${whereSql}`;

    try {
        const dataSql = `SELECT a.idAdminfee, a.idRoom, r.region, r.park, r.xyNumber, a.termYears, a.startDate, a.endDate, a.payAmount, a.payer, a.payePrhone, a.operator, a.createDate
    FROM ${req.data.dataBase}.adminfee a JOIN ${req.data.dataBase}.room r ON a.idRoom = r.idRoom
    WHERE ${whereSql}
    ORDER BY a.createDate DESC, a.idAdminfee DESC
    LIMIT ? OFFSET ?`;

        // 总数与收款合计短 TTL 复用并与取数并发发出(审查修复 20261021 二轮 P2-14):同一筛选条件下翻页时
        // 这两个聚合值根本不会变,而 COUNT(*) + SUM(payAmount) 要同时扫 adminfee 与 room 两表;原写法还是串行两段, 20261021 改造,
        // queryAggregate 已将列值统一转 Number(原写法同样在此处转),SUM 返回的 DECIMAL 字符串不影响前端千分位格式化,
        const [aggregate, results] = await Promise.all([
            public.queryAggregate(pool.query, { database: req.data.dataBase, sql: countSql, params, columns: ['total', 'totalAmount'] }),
            pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]),
        ]);
        // 分页结果：list 当前页数据，total 总记录数供前端滚动加载使用 20260912 新增
        return res.json({ code: 0, data: { list: results, total: aggregate.total, totalAmount: aggregate.totalAmount } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
