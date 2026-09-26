const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');

module.exports = router;

// 首页统计聚合：4 卡片数值 + 按月×区域 + 今天与昨天销售明细列表 + 今天与明天下葬明细列表（管理到期记录走 /expired-list 独立分页）20260914 新增 20260915 修改 20260921 改今天与昨天 20260925 新增下葬明细 20260926 管理到期改独立分页
// 口径：年销售/年收费按当年 createDate；年下葬数当年且 burialDate<=当天；预下葬数当年且 burialDate>当天；
// 月销售数量当年 1-12 月；销售记录为今天与昨天逐条明细，字段：区域/园区/编号/实际价格/购墓人/日期；
// 下葬记录为今天与明天逐条明细（按 burialDate），字段：区域/园区/编号/安葬者/联系人/联系人电话
// 4 卡片各配一个按区域分解数组（yearSalesByRegion 等），供卡片内小字行展示区域合计 20260915 新增
router.get('/summary', async (req, res) => {
    const db = req.data.dataBase;
    const year = new Date().getFullYear();
    const yearStart = `${year}-01-01 00:00:00`;
    const nextYearStart = `${year + 1}-01-01 00:00:00`;

    const query = pool.query;

    try {
        // 11 个查询分两批并发：错峰降低建连并发峰值，避免连接池冷启动偶发 500 20260917 修改 20260926 调整
        const [regionRows, yearSalesRows, yearFeesRows, yearBuriedRows, reservedBuriedRows, monthlyRows] = await Promise.all([
            query(`SELECT tagName as label, tagName as value FROM ${db}.taginfo WHERE tagType ='region' ORDER BY id ASC LIMIT 2`, []),
            query(`SELECT COALESCE(SUM(realPrice), 0) AS v FROM ${db}.sale WHERE isDeleted = 0 AND createDate >= ? AND createDate < ?`, [yearStart, nextYearStart]),
            query(`SELECT COALESCE(SUM(payAmount), 0) AS v FROM ${db}.adminfee WHERE isDeleted = 0 AND createDate >= ? AND createDate < ?`, [yearStart, nextYearStart]),
            query(`SELECT COUNT(*) AS v FROM ${db}.buried WHERE isDeleted = 0 AND burialDate >= ? AND burialDate <= NOW()`, [yearStart]),
            query(`SELECT COUNT(*) AS v FROM ${db}.buried WHERE isDeleted = 0 AND burialDate > NOW() AND burialDate < ?`, [nextYearStart]),
            query(`SELECT r.region, DATE_FORMAT(a.createDate, '%m') AS month, COUNT(*) AS count FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ? GROUP BY r.region, DATE_FORMAT(a.createDate, '%m') ORDER BY r.region, month`, [yearStart, nextYearStart]),
        ]);
        // 第二批：周明细与按区域分解与下葬明细，与第一批错峰并发 20260917 修改 20260925 新增
        const [weeklyRows, yearSalesRegionRows, yearFeesRegionRows, yearBuriedRegionRows, reservedBuriedRegionRows, buriedRows] = await Promise.all([
            query(`SELECT a.idSale, r.region, r.park, r.xyNumber, a.realPrice, a.payer, DATE_FORMAT(a.createDate, '%Y-%m-%d') AS createDate FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND a.createDate < DATE_ADD(CURDATE(), INTERVAL 1 DAY) ORDER BY a.createDate DESC, a.idSale DESC`, []),
            query(`SELECT r.region, COALESCE(SUM(a.realPrice), 0) AS v FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ? GROUP BY r.region ORDER BY r.region`, [yearStart, nextYearStart]),
            query(`SELECT r.region, COALESCE(SUM(a.payAmount), 0) AS v FROM ${db}.adminfee a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ? GROUP BY r.region ORDER BY r.region`, [yearStart, nextYearStart]),
            query(`SELECT r.region, COUNT(*) AS v FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate >= ? AND b.burialDate <= NOW() GROUP BY r.region ORDER BY r.region`, [yearStart]),
            query(`SELECT r.region, COUNT(*) AS v FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate > NOW() AND b.burialDate < ? GROUP BY r.region ORDER BY r.region`, [nextYearStart]),
            // 下葬明细：今天与明天（burialDate 落在 [CURDATE, CURDATE+2) 内），按日期升序 20260925 新增
            query(`SELECT b.idBuried, r.region, r.park, r.xyNumber, b.deceased, b.contacts, b.contactsphone, DATE_FORMAT(b.burialDate, '%Y-%m-%d') AS burialDate FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate >= CURDATE() AND b.burialDate < DATE_ADD(CURDATE(), INTERVAL 2 DAY) ORDER BY b.burialDate ASC, b.idBuried ASC`, []),
        ]);

        // 金额合计 SUM 可能返回 DECIMAL 字符串，统一转 Number 供前端千分位格式化
        return res.json({
            code: 0,
            data: {
                regions: regionRows,
                yearSales: Number(yearSalesRows[0].v) || 0,
                yearFees: Number(yearFeesRows[0].v) || 0,
                yearBuriedCount: Number(yearBuriedRows[0].v) || 0,
                reservedBuriedCount: Number(reservedBuriedRows[0].v) || 0,
                monthlySales: monthlyRows,
                weeklySales: weeklyRows,
                buriedRecords: buriedRows,
                yearSalesByRegion: yearSalesRegionRows.map((row) => ({ region: row.region, v: Number(row.v) || 0 })),
                yearFeesByRegion: yearFeesRegionRows.map((row) => ({ region: row.region, v: Number(row.v) || 0 })),
                yearBuriedCountByRegion: yearBuriedRegionRows.map((row) => ({ region: row.region, v: Number(row.v) || 0 })),
                reservedBuriedCountByRegion: reservedBuriedRegionRows.map((row) => ({ region: row.region, v: Number(row.v) || 0 })),
            },
        });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

// 首页管理到期记录分页：endDate 已到期（<=当天）且未迁出的墓位，按区域过滤、服务端分页，
// 供首页管理到期卡片滚动加载（每页 40 条，同销售查询页无限滚动方式）20260926 新增
// 未迁出条件用空值安全写法（transferOutStatus 默认 NULL，仅撤销迁出时写 notOut），与 managementPeriod 查询一致
router.get('/expired-list', async (req, res) => {
    const db = req.data.dataBase;
    const conditions = [
        'r.isDeleted = 0',
        'r.endDate IS NOT NULL',
        'r.endDate < DATE_ADD(CURDATE(), INTERVAL 1 DAY)',
        '(r.transferOutStatus IS NULL OR r.transferOutStatus <> \'statusType.transferOutStatusEnum.out\')',
    ];
    const params = [];

    const region = String(req.query.region || '').trim();
    if (region) {
        conditions.push('r.region = ?');
        params.push(region);
    }

    // 分页参数：current 从 1 起，pageSize 默认 40 与销售查询页一致，限制 1-100 防恶意大页 20260926 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 40, 1), 100);
    const whereSql = conditions.join(' AND ');

    try {
        const countResults = await pool.query('SELECT COUNT(*) AS total FROM ' + db + '.room r WHERE ' + whereSql, params);
        const dataSql = 'SELECT r.idRoom, r.region, r.park, r.xyNumber, DATE_FORMAT(r.endDate, \'%Y-%m-%d\') AS endDate, r.contacts ' +
            'FROM ' + db + '.room r WHERE ' + whereSql + ' ' +
            'ORDER BY r.endDate ASC, r.idRoom ASC ' +
            'LIMIT ? OFFSET ?';
        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        // 分页结果：list 当前页数据，total 总记录数供卡片标题条数展示与滚动加载判断 20260926 新增
        return res.json({ code: 0, data: { list: results, total: countResults[0].total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
