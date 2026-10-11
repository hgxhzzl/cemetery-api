const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

// 墓区下葬查询：buried 关联 room 逐条返回下葬记录（并左关 sale 取销售信息与价格），
// 支持区域/园区/下葬时间段过滤、两种排序与服务端分页 20260912 新增 20261011 加排序方式与墓位类型/身份证/死亡日期/销售列,
router.get('/list', async (req, res) => {
    const conditions = ['b.isDeleted = 0'];
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

    // 时间段按下葬日期 burialDate 过滤：下葬查询关注实际下葬时间而非录入时间 20260912 新增
    const startDate = String(req.query.startDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(startDate)) {
        conditions.push('b.burialDate >= ?');
        params.push(`${startDate.slice(0, 10)} 00:00:00`);
    }

    const endDate = String(req.query.endDate || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(endDate)) {
        conditions.push('b.burialDate <= ?');
        params.push(`${endDate.slice(0, 10)} 23:59:59`);
    }

    // 分页参数：current 从 1 起，pageSize 限制 1-100 防止恶意大页 20260912 新增
    const current = Math.max(parseInt(req.query.current, 10) || 1, 1);
    const pageSize = Math.min(Math.max(parseInt(req.query.pageSize, 10) || 20, 1), 100);
    const whereSql = conditions.join(' AND ');

    // 排序方式(列表页第二行单选):park=园区/排号/序号/下葬日期(默认)、date=下葬日期/园区/排号/序号,
    // 四个层级均升序、一律取白名单拼串不接受外部原文(防注入口);末尾以 idBuried 兜底保证同序稳定分页,
    // 否则并列行在 LIMIT/OFFSET 下可能重复或漏行 20261011 新增,
    // 园区层级按 park 表的 idPark 排序(即园区设置页拖拽后的园区顺序),不取中文编码序;
    // 下葬日期优先时先把 burialDate 为空的下葬记录排到末尾:MySQL 的 ASC 将 NULL 视为最小值,
    // 不特殊处理的话这类记录会顶在列表第一条 20261011 新增,
    const sortMode = String(req.query.sortMode || '') === 'date' ? 'date' : 'park';
    const orderBySql =
        sortMode === 'date'
            ? 'ORDER BY b.burialDate IS NULL ASC, b.burialDate ASC, pc.idPark IS NULL ASC, pc.idPark ASC, r.park ASC, r.yNum ASC, r.xNum ASC, b.idBuried ASC'
            : 'ORDER BY pc.idPark IS NULL ASC, pc.idPark ASC, r.park ASC, r.yNum ASC, r.xNum ASC, b.burialDate ASC, b.idBuried ASC';

    // 取 idPark 直接等值关联 park 表:重名行已在写入侧堵住(park/save.js 插入前按园区名去重),
    // 这里不再用聚合子查询兜底;墓位园区未在园区设置里配过时 idPark 为 NULL,排到末尾并回退按 park 文本序 20261011 修改,
    const parkOrderJoin = `LEFT JOIN ${req.data.dataBase}.park pc ON pc.park = r.park`;

    // 销售列取最新一笔活动销售(按 idSale 自增序):存量数据里确实存在一穴多条活动销售(gm_data_000 有四个墓位各两条),
    // 直接 LEFT JOIN sale 会把那些墓位的下葬记录放大成多行、与不关联 sale 的总数对不上,
    // 故先按 idRoom 聚合取最大 idSale 再回连主键(口径同首页预定记录的一穴一条处理) 20261011 新增,
    const saleJoin = `LEFT JOIN (SELECT idRoom, MAX(idSale) AS idSale
    FROM ${req.data.dataBase}.sale WHERE isDeleted = 0 GROUP BY idRoom) sl ON sl.idRoom = r.idRoom
    LEFT JOIN ${req.data.dataBase}.sale s ON s.idSale = sl.idSale`;

    const countSql = `SELECT COUNT(*) AS total
    FROM ${req.data.dataBase}.buried b JOIN ${req.data.dataBase}.room r ON b.idRoom = r.idRoom
    WHERE ${whereSql}`;

    try {
        const countResults = await pool.query(countSql, params);
        const total = countResults[0].total;

        // 规格列已从列表去掉:SELECT 一并不再取 r.specs,不留用不到的字段 20261011 修改,
        const dataSql = `SELECT b.idBuried, b.idRoom, r.region, r.park, r.xyNumber, r.roomType, b.deceased, b.deceasedIDCard, b.deathDate, b.burialDate,
    s.realPrice, s.createDate AS saleDate, b.contacts, b.contactsphone, b.remark, b.operator, b.createDate
    FROM ${req.data.dataBase}.buried b JOIN ${req.data.dataBase}.room r ON b.idRoom = r.idRoom
    ${parkOrderJoin}
    ${saleJoin}
    WHERE ${whereSql}
    ${orderBySql}
    LIMIT ? OFFSET ?`;

        const results = await pool.query(dataSql, [...params, pageSize, (current - 1) * pageSize]);
        // 分页结果：list 当前页数据，total 总记录数供前端滚动加载使用 20260912 新增
        return res.json({ code: 0, data: { list: results, total } });
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});
