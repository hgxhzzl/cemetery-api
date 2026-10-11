const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

// 墓位信息查询：room 主体关联活动销售记录，支持区域/园区/销售日期范围过滤与服务端分页 20260924 新增,
router.get('/list', async (req, res) => {
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
    if (/^\d{4}-\d{2}-\d{2}/.test(startDate)) {
        conditions.push('s.createDate >= ?');
        params.push(`${startDate.slice(0, 10)} 00:00:00`);
    }

    const endDate = String(req.query.endDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(endDate)) {
        conditions.push('s.createDate <= ?');
        params.push(`${endDate.slice(0, 10)} 23:59:59`);
    }
    // 关键词：按墓区编号/购墓人/联系人组合(姓名+电话)/购墓人电话/安葬者/备注拼串包含查找 20260926 修改 20261003 加备注,
    const keyword = String(req.query.keyword || '').trim();
    if (keyword) {
        conditions.push("CONCAT(COALESCE(r.xyNumber,''),COALESCE(r.buyer,''),COALESCE(c.contactsGroup,''),COALESCE(s.payerPhone,''),COALESCE(r.deceased,''),COALESCE(r.remark,'')) LIKE ?");
        params.push(`%${keyword}%`);
    }

    // 销售状态/迁出状态多选过滤：一对复选框只勾其一时按该状态过滤，都勾或都不勾时不过滤 20260924 新增
    // 迁出状态保留 out/notOut 两个参数但列表页已不再传 notOut(未迁出就是不限)，两个都收着才能保持接口口径不变 20261011 说明,
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
    FROM ${req.data.dataBase}.room r
    LEFT JOIN ${req.data.dataBase}.sale s ON s.idRoom = r.idRoom AND s.isDeleted = 0
    LEFT JOIN (SELECT idRoom, GROUP_CONCAT(CONCAT(contacts, contactsPhone) SEPARATOR ' ') AS contactsGroup FROM ${req.data.dataBase}.contacts WHERE isDeleted = 0 GROUP BY idRoom) c ON c.idRoom = r.idRoom
    WHERE ${whereSql}`;

    try {
        const countResults = await pool.query(countSql, params);
        const total = countResults[0].total;

        // 选择销售日期范围时未销售墓位不满足 s.createDate 条件被自然排除，未选范围时展示全部墓位 20260924 新增
        // 联系人列改为 contacts 表组合：每条“姓名+电话”，多联系人空格分隔（替换原 room.contacts 冗余字段）20260926 修改
        // 新增 r.remark：供列表备注列展示 20261003 新增
        // 新增 s.realPrice:活动销售记录的实收金额,供列表销售金额列展示(未销售墓位为 NULL) 20261011 新增
        const dataSql = `SELECT r.idRoom, r.region, r.park, r.xyNumber, r.buyer, s.payerPhone, s.createDate, s.realPrice, r.deceased, r.remark, COALESCE(c.contactsGroup, '') AS contacts, r.transferOutStatus
    FROM ${req.data.dataBase}.room r
    LEFT JOIN ${req.data.dataBase}.sale s ON s.idRoom = r.idRoom AND s.isDeleted = 0
    LEFT JOIN (SELECT idRoom, GROUP_CONCAT(CONCAT(contacts, contactsPhone) SEPARATOR ' ') AS contactsGroup FROM ${req.data.dataBase}.contacts WHERE isDeleted = 0 GROUP BY idRoom) c ON c.idRoom = r.idRoom
    WHERE ${whereSql}
    ORDER BY r.idRoom DESC
    LIMIT ? OFFSET ?`;

        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        return res.json({ code: 0, data: { list: results, total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
