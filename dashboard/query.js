const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');

module.exports = router;

// 首页统计聚合：4 卡片数值 + 按月×区域 + 本周销售明细列表 20260914 新增 20260915 修改
// 口径：年销售/年收费按当年 createDate；年下葬数当年且 burialDate<=当天；预下葬数当年且 burialDate>当天；
// 月销售数量当年 1-12 月；销售记录为本周（周一至周日）逐条明细，字段：区域/园区/编号/实际价格/购买人/日期
// 4 卡片各配一个按区域分解数组（yearSalesByRegion 等），供卡片内小字行展示区域合计 20260915 新增
router.get('/summary', async (req, res) => {
    const db = req.data.dataBase;
    const year = new Date().getFullYear();
    const yearStart = `${year}-01-01 00:00:00`;
    const nextYearStart = `${year + 1}-01-01 00:00:00`;

    const query = pool.query;

    try {
        // 11 个查询分两批并发：错峰降低建连并发峰值，避免连接池冷启动偶发 500 20260917 修改
        const [regionRows, yearSalesRows, yearFeesRows, yearBuriedRows, reservedBuriedRows, monthlyRows] = await Promise.all([
            query(`SELECT tagName as label, tagName as value FROM ${db}.taginfo WHERE tagType ='region' ORDER BY id ASC LIMIT 2`, []),
            query(`SELECT COALESCE(SUM(realPrice), 0) AS v FROM ${db}.sale WHERE isDeleted = 0 AND createDate >= ? AND createDate < ?`, [yearStart, nextYearStart]),
            query(`SELECT COALESCE(SUM(payAmount), 0) AS v FROM ${db}.adminfee WHERE isDeleted = 0 AND createDate >= ? AND createDate < ?`, [yearStart, nextYearStart]),
            query(`SELECT COUNT(*) AS v FROM ${db}.buried WHERE isDeleted = 0 AND burialDate >= ? AND burialDate <= NOW()`, [yearStart]),
            query(`SELECT COUNT(*) AS v FROM ${db}.buried WHERE isDeleted = 0 AND burialDate > NOW() AND burialDate < ?`, [nextYearStart]),
            query(`SELECT r.region, DATE_FORMAT(a.createDate, '%m') AS month, COUNT(*) AS count FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ? GROUP BY r.region, DATE_FORMAT(a.createDate, '%m') ORDER BY r.region, month`, [yearStart, nextYearStart]),
        ]);
        // 第二批：周明细与按区域分解，与第一批错峰并发 20260917 修改
        const [weeklyRows, yearSalesRegionRows, yearFeesRegionRows, yearBuriedRegionRows, reservedBuriedRegionRows] = await Promise.all([
            query(`SELECT a.idSale, r.region, r.park, r.xyNumber, a.realPrice, a.payer, DATE_FORMAT(a.createDate, '%Y-%m-%d') AS createDate FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY) AND a.createDate < DATE_ADD(DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY), INTERVAL 7 DAY) ORDER BY a.createDate DESC, a.idSale DESC`, []),
            query(`SELECT r.region, COALESCE(SUM(a.realPrice), 0) AS v FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ? GROUP BY r.region ORDER BY r.region`, [yearStart, nextYearStart]),
            query(`SELECT r.region, COALESCE(SUM(a.payAmount), 0) AS v FROM ${db}.adminfee a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ? GROUP BY r.region ORDER BY r.region`, [yearStart, nextYearStart]),
            query(`SELECT r.region, COUNT(*) AS v FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate >= ? AND b.burialDate <= NOW() GROUP BY r.region ORDER BY r.region`, [yearStart]),
            query(`SELECT r.region, COUNT(*) AS v FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate > NOW() AND b.burialDate < ? GROUP BY r.region ORDER BY r.region`, [nextYearStart]),
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
