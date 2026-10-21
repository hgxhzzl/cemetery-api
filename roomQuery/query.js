const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

// 墓位信息查询：room 主体关联活动销售记录，支持区域/园区/销售日期范围过滤与服务端分页 20260924 新增,
// 性能口径改造(审查修复 20261021 P2):原 count 与数据查询都 LEFT JOIN 一整张 contacts 的派生表
// (SELECT idRoom, GROUP_CONCAT(...) ... GROUP BY idRoom)，带聚合的派生表无法与外层合并，MySQL 每次请求
// 都要先全表扫描 contacts 并落临时表，存量联系人越多翻页越慢;现改判条件走 EXISTS 子查询、展示列走相关子查询，
// 后者只对本页最多 100 行按 idRoom 主键索引取数，count 也从三表 JOIN 降为单表扫描,
router.get('/list', async (req, res) => {
    const dataBase = req.data.dataBase;
    const conditions = ['r.isDeleted = 0'];
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

    const startDate = String(req.query.startDate || '').trim();
    const endDate = String(req.query.endDate || '').trim();
    // 销售日期范围:改 EXISTS 取代旧的 LEFT JOIN sale + WHERE s.createDate 写法——选了范围时无销售记录的墓位
    // 仍被自然排除,未选范围时展示全部墓位,口径与旧写法一致 20260924 新增 20261021 改判 EXISTS,
    const saleDateConds = [];
    const saleDateParams = [];
    if (/^\d{4}-\d{2}-\d{2}/.test(startDate)) {
        saleDateConds.push('s.createDate >= ?');
        saleDateParams.push(`${startDate.slice(0, 10)} 00:00:00`);
    }
    if (/^\d{4}-\d{2}-\d{2}/.test(endDate)) {
        saleDateConds.push('s.createDate <= ?');
        saleDateParams.push(`${endDate.slice(0, 10)} 23:59:59`);
    }
    if (saleDateConds.length > 0) {
        conditions.push(`EXISTS (SELECT 1 FROM ${dataBase}.sale s WHERE s.idRoom = r.idRoom AND s.isDeleted = 0 AND ${saleDateConds.join(' AND ')})`);
        params.push(...saleDateParams);
    }
    // 关键词：按墓区编号/购墓人/联系人组合(姓名+电话)/购墓人电话/安葬者/备注拼串包含查找 20260926 修改 20261003 加备注,
    // 20261021 改造:room 列仍拼串 LIKE,sale.payerPhone 与联系人组合拆为 EXISTS 子查询(不再依赖派生表),
    // 原写法把全部字段拼成一串做 LIKE,跨字段粘连(上一字段尾 + 下一字段头)会误命中,拆开后按语义各自匹配,
    const keyword = String(req.query.keyword || '').trim();
    if (keyword) {
        const like = `%${keyword}%`;
        conditions.push(
            `(CONCAT(COALESCE(r.xyNumber,''),COALESCE(r.buyer,''),COALESCE(r.deceased,''),COALESCE(r.remark,'')) LIKE ?` +
            ` OR EXISTS (SELECT 1 FROM ${dataBase}.sale sk WHERE sk.idRoom = r.idRoom AND sk.isDeleted = 0 AND COALESCE(sk.payerPhone,'') LIKE ?)` +
            ` OR EXISTS (SELECT 1 FROM ${dataBase}.contacts ck WHERE ck.idRoom = r.idRoom AND ck.isDeleted = 0` +
            ` AND CONCAT(COALESCE(ck.contacts,''),COALESCE(ck.contactsPhone,'')) LIKE ?))`,
        );
        params.push(like, like, like);
    }

    // 状态多选过滤：8 个复选框(已/未销售、已/未预定、已/未下葬、已/未迁出)每个单独按 room 对应状态列成一组,
    // 勾选的所有组取并集(union all 去重：命中任一选中状态即纳入，全部不勾则状态维度不限) 20260924 新增 20261012 改为并集,
    // 已/未销售改判 room.saleStatus(不再用 sale 联表)，未销售=非已销售(含空值与历史 reserve 脏值) 20261012 新增,
    const statusConds = [];
    if (String(req.query.sold || '') === 'true') {
        statusConds.push("r.saleStatus = 'statusType.saleStatusEnum.sold'");
    }
    if (String(req.query.unsold || '') === 'true') {
        statusConds.push("(r.saleStatus IS NULL OR r.saleStatus <> 'statusType.saleStatusEnum.sold')");
    }
    if (String(req.query.reserved || '') === 'true') {
        statusConds.push("r.reserveStatus = 'statusType.reserveStatusEnum.reserved'");
    }
    if (String(req.query.unreserved || '') === 'true') {
        statusConds.push("(r.reserveStatus IS NULL OR r.reserveStatus <> 'statusType.reserveStatusEnum.reserved')");
    }
    if (String(req.query.buried || '') === 'true') {
        statusConds.push("r.intoStatus = 'statusType.intoStatusEnum.buried'");
    }
    if (String(req.query.notBuried || '') === 'true') {
        statusConds.push("(r.intoStatus IS NULL OR r.intoStatus <> 'statusType.intoStatusEnum.buried')");
    }
    if (String(req.query.out || '') === 'true') {
        statusConds.push("r.transferOutStatus = 'statusType.transferOutStatusEnum.out'");
    }
    if (String(req.query.notOut || '') === 'true') {
        statusConds.push("(r.transferOutStatus IS NULL OR r.transferOutStatus <> 'statusType.transferOutStatusEnum.out')");
    }
    // 多组间 OR(并集)，整体作为一个条件与区域/园区/日期/关键词等其他条件 AND 拼接 20261012 新增,
    if (statusConds.length > 0) {
        conditions.push(`(${statusConds.join(' OR ')})`);
    }



    // 分页参数：current 从 1 起，pageSize 限制 1-100 防止恶意大页 20260924 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const whereSql = conditions.join(' AND ');

    const countSql = `SELECT COUNT(*) AS total
    FROM ${dataBase}.room r
    WHERE ${whereSql}`;

    try {
        const countResults = await pool.query(countSql, params);
        const total = countResults[0].total;

        // 销售日期范围与关键词已在上方改判 EXISTS,本页取数不再 JOIN sale/contacts:原写法一行墓位遇到多条活动销售会重复成多行,
        // 且 count 与本页的 JOIN 必须逐字一致才能对齐分页总数,拆开后单一 room 口径天然一致 20261021 改造,
        // 销售列(payerPhone/createDate/realPrice)与联系人列改相关子查询:仅对本页行按 idRoom 走 idx_sale_idRoom/idx_contacts_idRoom 取数,
        // 联系人拼接口径(姓名+电话、空格分隔、无活动联系人时为空串)与旧派生表一致 20260926 修改 20261003 加 remark 20261011 加 realPrice,
        const latestSale = (column) =>
            `(SELECT s.${column} FROM ${dataBase}.sale s WHERE s.idRoom = r.idRoom AND s.isDeleted = 0 ORDER BY s.idSale DESC LIMIT 1)`;
        const dataSql = `SELECT r.idRoom, r.region, r.park, r.xyNumber, r.buyer,
    ${latestSale('payerPhone')} AS payerPhone,
    ${latestSale('createDate')} AS createDate,
    ${latestSale('realPrice')} AS realPrice,
    r.deceased, r.remark,
    COALESCE((SELECT GROUP_CONCAT(CONCAT(c.contacts, c.contactsPhone) SEPARATOR ' ') FROM ${dataBase}.contacts c
      WHERE c.idRoom = r.idRoom AND c.isDeleted = 0), '') AS contacts,
    r.transferOutStatus
    FROM ${dataBase}.room r
    WHERE ${whereSql}
    ORDER BY r.idRoom DESC
    LIMIT ? OFFSET ?`;

        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        return res.json({ code: 0, data: { list: results, total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
