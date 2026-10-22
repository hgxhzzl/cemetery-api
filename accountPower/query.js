const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
// 「用户管理」子树根清单与菜单侧下发兜底(menu.js)同源(三轮 P1-1 延伸 20261022),
const { PLATFORM_ONLY_MENU_ROOTS, collectSubtreeIds } = require('../lib/platformMenus');
module.exports = router;

// 账户权限页列表过滤:当被配权限的账户目标库不是 gm_data_000(即普适租户)时,隐去「用户管理」子树
// (101100 及其下级 101101 账户信息/101102 合同列表)对应的权限行——这些菜单背后的接口读写 gm_data_000 全局表
// 且语句不带租户条件,租户即便被勾上,点开也只会 403;平台账户(gm_data_000)原样保留整棵子树。
// 以“目标账户库名”而非“当前查看者身份”为准:本页就是平台管理员给某个账户配权限,被配对象是不是平台库决定这批行该不该出现。
function filterPlatformOnlyPowers(powerRows, menuRows, isPlatformDatabase) {
    if (isPlatformDatabase) {
        return powerRows;
    }
    const platformIds = collectSubtreeIds(menuRows, PLATFORM_ONLY_MENU_ROOTS);
    return powerRows.filter((row) => !platformIds.has(String(row.idMenu)));
}

// 挂到 router 上供用例复用同一份过滤口径(本文件只导出 router,不另开导出面),与 menu.js 的 filterPlatformOnlyMenus 做法一致,
router.filterPlatformOnlyPowers = filterPlatformOnlyPowers;

// 全局管理接口:账户权限查询(含补模板初值写副作用)仅平台管理员可操作 20260917 越权收口,
router.use(rbac.requirePlatformAdmin);
//get account Power
router.get('/power', async (req, res) => {
    const dataBaseName = req.query.dataBaseName;
    const account = req.query.account;
    // 是否平台账户目标库以“被配权限的库名”为准(非当前登录者),与上面过滤口径对齐,
    const isPlatformDatabase = String(dataBaseName) === 'gm_data_000';
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
        const powerRows = await pool.query(sql, [dataBaseName]);
        // 平台账户原样返回且不额外查菜单表;非平台目标账户借菜单父链把「用户管理」子树整棵闭包后剔除再返回,
        if (isPlatformDatabase) {
            return public.respondList(res, powerRows);
        }
        const menuRows = await pool.query('SELECT id, parent_id FROM gm_data_000.menu');
        return public.respondList(res, filterPlatformOnlyPowers(powerRows, menuRows, false));
    } catch (error) {
        return public.handleQueryError(res, error);
    }
})


