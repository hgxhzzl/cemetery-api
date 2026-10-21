const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');

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

    // 首页聚合按当前操作员所属区域收窄(硬隔离):菜单层/下拉层/列表接口均已过滤,首页卡片与明细若不过滤
    // 会把别区的销售额/下葬安葬者/联系人电话一并展示出来 20261010 新增,
    // 已 JOIN room 的语句直接追加 r.region IN(...);未 JOIN room 的总额语句走 idRoom 子查询,
    // 不改原有 JOIN 结构,故平台管理员/未配区域(名单为空)时语句与参数与改动前完全一致 20261010 新增,
    const allowedRegions = Array.isArray(req.operatorRegions) ? req.operatorRegions : [];
    const regionHoles = allowedRegions.map(() => '?').join(', ');
    const joinRegionSql = allowedRegions.length ? ` AND r.region IN (${regionHoles})` : '';
    const roomRegionSql = (idRoomExpr) => (allowedRegions.length
      ? ` AND ${idRoomExpr} IN (SELECT idRoom FROM ${db}.room WHERE region IN (${regionHoles}))`
      : '');

    try {
        // 11 个查询分两批并发：错峰降低建连并发峰值，避免连接池冷启动偶发 500 20260917 修改 20260926 调整
        // 区域标签去掉 LIMIT 2 改为取回后按名单过滤再取前二:先截断再过滤会出现“前二恰好是别区”导致首页卡片直接空掉 20261010 硬隔离,
        const [regionRows, yearSalesRows, yearFeesRows, yearBuriedRows, reservedBuriedRows, monthlyRows] = await Promise.all([
            query(`SELECT tagName as label, tagName as value FROM ${db}.taginfo WHERE tagType ='region' ORDER BY id ASC`, []),
            query(`SELECT COALESCE(SUM(realPrice), 0) AS v FROM ${db}.sale WHERE isDeleted = 0 AND createDate >= ? AND createDate < ?${roomRegionSql('idRoom')}`, [yearStart, nextYearStart, ...allowedRegions]),
            query(`SELECT COALESCE(SUM(payAmount), 0) AS v FROM ${db}.adminfee WHERE isDeleted = 0 AND createDate >= ? AND createDate < ?${roomRegionSql('idRoom')}`, [yearStart, nextYearStart, ...allowedRegions]),
            query(`SELECT COUNT(*) AS v FROM ${db}.buried WHERE isDeleted = 0 AND burialDate >= ? AND burialDate <= NOW()${roomRegionSql('idRoom')}`, [yearStart, ...allowedRegions]),
            query(`SELECT COUNT(*) AS v FROM ${db}.buried WHERE isDeleted = 0 AND burialDate > NOW() AND burialDate < ?${roomRegionSql('idRoom')}`, [nextYearStart, ...allowedRegions]),
            query(`SELECT r.region, DATE_FORMAT(a.createDate, '%m') AS month, COUNT(*) AS count FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ?${joinRegionSql} GROUP BY r.region, DATE_FORMAT(a.createDate, '%m') ORDER BY r.region, month`, [yearStart, nextYearStart, ...allowedRegions]),
        ]);
        // 第二批：周明细与按区域分解与下葬明细，与第一批错峰并发 20260917 修改 20260925 新增
        const [weeklyRows, yearSalesRegionRows, yearFeesRegionRows, yearBuriedRegionRows, reservedBuriedRegionRows, buriedRows] = await Promise.all([
            query(`SELECT a.idSale, r.region, r.park, r.xyNumber, a.realPrice, a.payer, DATE_FORMAT(a.createDate, '%Y-%m-%d') AS createDate FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= DATE_SUB(CURDATE(), INTERVAL 1 DAY) AND a.createDate < DATE_ADD(CURDATE(), INTERVAL 1 DAY)${joinRegionSql} ORDER BY a.createDate DESC, a.idSale DESC`, [...allowedRegions]),
            query(`SELECT r.region, COALESCE(SUM(a.realPrice), 0) AS v FROM ${db}.sale a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ?${joinRegionSql} GROUP BY r.region ORDER BY r.region`, [yearStart, nextYearStart, ...allowedRegions]),
            query(`SELECT r.region, COALESCE(SUM(a.payAmount), 0) AS v FROM ${db}.adminfee a JOIN ${db}.room r ON a.idRoom = r.idRoom WHERE a.isDeleted = 0 AND a.createDate >= ? AND a.createDate < ?${joinRegionSql} GROUP BY r.region ORDER BY r.region`, [yearStart, nextYearStart, ...allowedRegions]),
            query(`SELECT r.region, COUNT(*) AS v FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate >= ? AND b.burialDate <= NOW()${joinRegionSql} GROUP BY r.region ORDER BY r.region`, [yearStart, ...allowedRegions]),
            query(`SELECT r.region, COUNT(*) AS v FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate > NOW() AND b.burialDate < ?${joinRegionSql} GROUP BY r.region ORDER BY r.region`, [nextYearStart, ...allowedRegions]),
            // 下葬明细：今天与明天（burialDate 落在 [CURDATE, CURDATE+2) 内），按日期升序 20260925 新增
            query(`SELECT b.idBuried, r.region, r.park, r.xyNumber, b.deceased, b.contacts, b.contactsphone, DATE_FORMAT(b.burialDate, '%Y-%m-%d') AS burialDate FROM ${db}.buried b JOIN ${db}.room r ON b.idRoom = r.idRoom WHERE b.isDeleted = 0 AND b.burialDate >= CURDATE() AND b.burialDate < DATE_ADD(CURDATE(), INTERVAL 2 DAY)${joinRegionSql} ORDER BY b.burialDate ASC, b.idBuried ASC`, [...allowedRegions]),
        ]);
        const visibleRegions = rbac.filterByOperatorRegions(regionRows, 'label', allowedRegions).slice(0, 2);

        // 金额合计 SUM 可能返回 DECIMAL 字符串，统一转 Number 供前端千分位格式化
        return res.json({
            code: 0,
            data: {
                regions: visibleRegions,
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
// 排序按到期日期降序（最近到期在前），同日期按 idRoom 降序保证分页稳定 20261017 修改
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

    // 到期列表区域条件由 rbac 统一构造:首页展示的是明细列表,有区域名单的操作员不能越名单看到它区到期墓位 20261010 硬隔离,
    const regionCond = rbac.buildRegionCondition(req, 'r.region');
    if (regionCond) {
        conditions.push(regionCond.sql);
        params.push(...regionCond.params);
    }

    // 分页参数：current 从 1 起，pageSize 默认 40 与销售查询页一致，限制 1-100 防恶意大页 20260926 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 40, 1), 100);
    const whereSql = conditions.join(' AND ');

    try {
        const countSql = 'SELECT COUNT(*) AS total FROM ' + db + '.room r WHERE ' + whereSql;
        const dataSql = 'SELECT r.idRoom, r.region, r.park, r.xyNumber, DATE_FORMAT(r.endDate, \'%Y-%m-%d\') AS endDate, r.contacts ' +
            'FROM ' + db + '.room r WHERE ' + whereSql + ' ' +
            'ORDER BY r.endDate DESC, r.idRoom DESC ' +
            'LIMIT ? OFFSET ?';
        // 总数短 TTL 复用并与取数并发发出(审查修复 20261021 二轮 P2-14):首页卡片滚动加载同一筛选条件下
        // 逐页拉取,而这条 COUNT(*) 要扫全部到期墓位;原写法串行两段每翻一页白等一个往返, 20261021 改造,
        const [aggregate, results] = await Promise.all([
            public.queryAggregate(pool.query, { database: db, sql: countSql, params }),
            pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]),
        ]);
        // 分页结果：list 当前页数据，total 总记录数供卡片标题条数展示与滚动加载判断 20260926 新增
        return res.json({ code: 0, data: { list: results, total: aggregate.total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

// 首页预定记录分页：活动预定记录(reserve.isDeleted=0)且预定限期 >= 当天、墓位仍未售出且未迁出，
// 按区域过滤、服务端分页，样式与加载方式同管理到期记录（每页 40 条）20261011 新增
// 「未销售」取未售出口径(saleStatus 非 sold)：预定登记只置 reserveStatus、不动 saleStatus，
// 未售出即命中；用非 sold 而不写等值 unsold，是为了兼顾修数据前的历史行(saleStatus = reserve)，
// 同时把已销售但仍挂着活动预定记录的墓位排除在外 20261011 修改,
router.get('/reserve-list', async (req, res) => {
    const db = req.data.dataBase;
    const conditions = [
        'rv.isDeleted = 0',
        'r.isDeleted = 0',
        'rv.reservationExpireDate IS NOT NULL',
        'rv.reservationExpireDate >= CURDATE()',
        "(r.saleStatus IS NULL OR r.saleStatus <> 'statusType.saleStatusEnum.sold')",
        // 未迁出条件与到期列表同为空值安全写法（该列默认 NULL，仅撤销迁出时写 notOut）20261011 新增,
        "(r.transferOutStatus IS NULL OR r.transferOutStatus <> 'statusType.transferOutStatusEnum.out')",
    ];
    const params = [];

    // 区域条件由 rbac 统一构造:首页只展本区数据,有区域名单的操作员不能越名单看到它区预定 20261011 新增,
    const regionCond = rbac.buildRegionCondition(req, 'r.region');
    if (regionCond) {
        conditions.push(regionCond.sql);
        params.push(...regionCond.params);
    }

    // 分页参数：与到期列表一致，current 从 1 起，pageSize 默认 40、限制 1-100 20261011 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 40, 1), 100);
    const whereSql = conditions.join(' AND ');
    const fromSql = ` FROM ${db}.reserve rv JOIN ${db}.room r ON rv.idRoom = r.idRoom WHERE ${whereSql}`;

    try {
        const countSql = `SELECT COUNT(*) AS total${fromSql}`;
        // 预定限期取 reserve 本表列(墓位 room.reservationExpireDate 只是同步副本);联系人取 liaison/liaisonPhone 20261011 新增,
        const dataSql = `SELECT rv.idReserve, r.region, r.park, r.xyNumber,
            DATE_FORMAT(rv.reservationExpireDate, '%Y-%m-%d') AS reservationExpireDate,
            rv.liaison AS contacts, rv.liaisonPhone AS contactsphone${fromSql}
            ORDER BY rv.reservationExpireDate ASC, rv.idReserve ASC
            LIMIT ? OFFSET ?`;
        // 总数短 TTL 复用并与取数并发发出(审查修复 20261021 二轮 P2-14):首页预定卡片逐页滚动时
        // 活动预定集合基本不变,而这条 COUNT(*) 要 JOIN reserve 与 room 两表, 20261021 改造,
        const [aggregate, results] = await Promise.all([
            public.queryAggregate(pool.query, { database: db, sql: countSql, params }),
            pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]),
        ]);
        return res.json({ code: 0, data: { list: results, total: aggregate.total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
