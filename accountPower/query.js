const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
module.exports = router;

// 全局管理接口:账户权限查询(含补模板初值写副作用)仅平台管理员可操作 20260917 越权收口,
router.use(rbac.requirePlatformAdmin);
//get account Power
router.get('/power', async (req, res) => {
    const dataBaseName = req.query.dataBaseName;
    const account = req.query.account;
    // 已删除账户遗留的权限行占住 (idMenu,dataBaseName) 主键,活账户打开权限页时先物理清理,再补模板初值 20260916 修复,
    const sqlDelete = 'DELETE FROM gm_data_000.account_power WHERE dataBaseName = ? and isDeleted = 1';
    try {
        await pool.query(sqlDelete, [dataBaseName]);
        const sqlinsert = `insert into gm_data_000.account_power 
        (idMenu,dataBaseName,account,menuName,level,menuDescribe,
            operateCreate,operateModify,operateDelete,operateExamine,operateFinish,operatePower) 
        select idMenu, ?, ?, menuName, level, menuDescribe, 
        operateCreate,operateModify,operateDelete,operateExamine,operateFinish,operatePower
        from gm_data_000.account_power b  
        where b.dataBaseName = 'gm_data_000' and b.isDeleted = 0 and b.idMenu not in (
            select idMenu from gm_data_000.account_power c where c.dataBaseName = ?)`;
        await pool.query(sqlinsert, [dataBaseName, account, dataBaseName]);
        const sql = 'SELECT * FROM gm_data_000.account_power a WHERE a.dataBaseName = ? and a.isDeleted = 0';
        const results = await pool.query(sql, [dataBaseName]);
        return public.respondList(res, results);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
})


