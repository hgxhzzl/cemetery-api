const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');

module.exports = router;

// 首页统计聚合：4 卡片数值 + 按月×区域 + 今天与昨天销售明细列表 + 今天与明天下葬明细列表 + 管理到期明细列表 20260914 新增 20260915 修改 20260921 改今天与昨天 20260925 新增下葬明细与管理到期明细
// 口径：年销售/年收费按当年 createDate；年下葬数当年且 burialDate<=当天；预下葬数当年且 burialDate>当天；
// 月销售数量当年 1-12 月；销售记录为今天与昨天逐条明细，字段：区域/园区/编号/实际价格/购买人/日期；
// 下葬记录为今天与明天逐条明细（按 burialDate），字段：区域/园区/编号/安葬者/联系人/联系人电话；
// 管理到期记录为 endDate 已到期（<=当天）且未迁出的墓位，字段：区域/园区/编号/到期日期/联系人
// 4 卡片各配一个按区域分解数组（yearSalesByRegion 等），供卡片内小字行展示区域合计 20260915 新增
router.get('/summary', async (req, res) => {
    const db = req.data.dataBase;
    const year = new Date().getFullYear();
    const yearStart = `${year}-01-01 00:00:00`;
    const nextYearStart = `${year + 1}-01-01 00:00:00`;

    const query = pool.query;

    try {
        // 12 个查询分两批并发：错峰降低建连并发峰值，避免连接池冷启动偶发 500 20260917 修改 20260925 调整
        const [regionRows, yearSalesRows, yearFeesRows, yearBuriedRows, reservedBuriedRows, monthlyRows] = await Promise.all([
            query(`SELECT tagName as label, tagName as value FROM ${db}.taginfo WHERE tagType ='region' ORDER BY id ASC LIMIT 2`, []),
            query(`SELECT COALESCE(SUM(realPrice), 0) AS v FROM ${db}.sale WHERE isDeleted = 0 AND createDate >= ? AND createDate < ?`, [yearStart, nextYearStart]),
            query(`SELECT COALESCE(SUM(payAmount), 0) AS v FROM ${db}.adminfee WHERE isDeleted = 0 AND createDate >= ? AND createDate < ?`, [yearStart, nextYearStart]),
            query(`SELECT COUNT(*) AS v FROM ${db}.buried WHERE isDeleted = 0 AND burialDate >= ? AND burialDate <= NOW()`, [yearStart]),
            query(`SELECT COUNT(*) AS v FROM ${db}.buried WHERE isDeleted = 0 AND burialDate > NOW() AND burialDate < ?`, [nextYearStart]),
            query(`SELECT r.region, DATE_FORMAT(a.createDate, '%m') AS month, COUNT(*) AS count FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ? GROUP BY r.region, DATE_FORMAT(a.createDate, '%m') ORDER BY r.region, month`, [yearStart, nextYearStart]),
        ]);
        // 第二批：周明细与按区域分解与下葬明细与管理到期明细，与第一批错峰并发 20260917 修改 20260925 新增
        const [weeklyRows, yearSalesRegionRows, yearFeesRegionRows, yearBuriedRegionRows, reservedBuriedRegionRows, buriedRows, expiredRows] = await Promise.all([
            query(`SELECT a.idSale, r.region, r.park, r.xyNumber, a.realPrice, a.payer, DATE_FORMAT(a.createDate, '%Y-%m-%d') AS createDate FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND a.createDate < DATE_ADD(CURDATE(), INTERVAL 1 DAY) ORDER BY a.createDate DESC, a.idSale DESC`, []),
            query(`SELECT r.region, COALESCE(SUM(a.realPrice), 0) AS v FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ? GROUP BY r.region ORDER BY r.region`, [yearStart, nextYearStart]),
            query(`SELECT r.region, COALESCE(SUM(a.payAmount), 0) AS v FROM ${db}.adminfee a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ? GROUP BY r.region ORDER BY r.region`, [yearStart, nextYearStart]),
            query(`SELECT r.region, COUNT(*) AS v FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate >= ? AND b.burialDate <= NOW() GROUP BY r.region ORDER BY r.region`, [yearStart]),
            query(`SELECT r.region, COUNT(*) AS v FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate > NOW() AND b.burialDate < ? GROUP BY r.region ORDER BY r.region`, [nextYearStart]),
            // 下葬明细：今天与明天（burialDate 落在 [CURDATE, CURDATE+2) 内），按日期升序 20260925 新增
            query(`SELECT b.idBuried, r.region, r.park, r.xyNumber, b.deceased, b.contacts, b.contactsphone, DATE_FORMAT(b.burialDate, '%Y-%m-%d') AS burialDate FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate >= CURDATE() AND b.burialDate < DATE_ADD(CURDATE(), INTERVAL 2 DAY) ORDER BY b.burialDate ASC, b.idBuried ASC`, []),
            // 管理到期明细：endDate <= 当天且未迁出（transferOutStatus 默认 NULL，仅撤销迁出时写 notOut，故按空值安全的未迁出条件，与 managementPeriod 查询一致），按到期日期升序 20260925 新增
            query(`SELECT r.idRoom, r.region, r.park, r.xyNumber, DATE_FORMAT(r.endDate, '%Y-%m-%d') AS endDate, r.contacts FROM ${db}.room r WHERE r.isDeleted = 0 AND r.endDate IS NOT NULL AND r.endDate < DATE_ADD(CURDATE(), INTERVAL 1 DAY) AND (r.transferOutStatus IS NULL OR r.transferOutStatus <> 'statusType.transferOutStatusEnum.out') ORDER BY r.endDate ASC, r.idRoom ASC`, []),
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
                expiredRooms: expiredRows,
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
