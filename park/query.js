const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');

module.exports = router;

// 园区下拉与区域下拉同源收窄:results 自带 region 归属列,按当前操作员区域名单过滤,
// 否则操作员在查询页只选了本区域,园区下拉却能把别区的园区也列出来(选了也查不到数据,但暴露了范围) 20261010 硬隔离,
// 未配置区域或平台管理员时返回全量,与 /region 保持一致口径 20261010 新增,
// 园区按 idPark 排序返回:该表写入为“按区域先删后插”,插入序就是页面拖拽排序的结果,
// 不排序则依靠 InnoDB 默认返回序、随时可能变(同 /region 20261010 的处理) 20261011 新增,
router.get('/park', async (req, res) => {
    try {
        const results = await pool.query("SELECT park as label,park as value, region FROM " +req.data.dataBase +".park ORDER BY idPark");
        const allowedRegions = await rbac.fetchOperatorRegions(req);
        return public.respondList(res, rbac.filterByOperatorRegions(results, 'region', allowedRegions));
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});

router.get('/region', async (req, res) => {
    let table = " FROM " + req.data.dataBase +".taginfo  WHERE tagType ='region' ";
    try {
        // 区域标签按 id 排序返回:前端部分查询页以“首项”作区域初值,无序时首项不可预期 20261010 新增,
        const results = await pool.query("SELECT  tagName as label,tagName as value " + table + " ORDER BY id");
        // 区域下拉统一按当前操作员所属区域收窄:业务页/查询页/园区设置/票据配置/操作员分配区域共 11 处
        // 均走本接口(getRegionList 与公共 useParkRoomFilter),在此过滤一次即全局一致;
        // 未配置区域或平台管理员时返回全量 20261010 新增,
        const allowedRegions = await rbac.fetchOperatorRegions(req);
        return public.respondList(res, rbac.filterByOperatorRegions(results, 'label', allowedRegions));
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});