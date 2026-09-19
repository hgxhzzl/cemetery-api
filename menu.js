const express = require('express');
const router = express.Router();
const pool = require('./database');
const public = require('./public');
module.exports = router;

// 一次查询取出全部有权限菜单行,内存中按 parent_id 建树,替代逐层递归查询(N+1) 20260915 优化,
function buildMenuTreeFromRows(rows) {
    const nodeMap = new Map();
    rows.forEach((item) => {
        const title = { zh_CN: item.zh_CN, en_US: item.en_US };
        const menuItem = {
            // id 下发前端作为 meta.idMenu,菜单 id 因排序调整变化时前端以 name 为准、id 仅作展示 20260919 新增,
            id: item.id,
            path: item.path,
            name: item.name,
            component: item.component,
            redirect: item.redirect,
            meta: { title, icon: item.icon },
        };
        if (item.parent_id !== "0") {
            menuItem.meta = { title };
        }
        nodeMap.set(String(item.id), { menuItem, children: [] });
    });

    const roots = [];
    rows.forEach((item) => {
        const node = nodeMap.get(String(item.id));
        if (item.parent_id == 0) {
            roots.push(node);
            return;
        }
        const parent = nodeMap.get(String(item.parent_id));
        // 父节点无权限或指向自身时不挂入树,与旧逐层查询行为一致 20260915 优化,
        if (!parent || parent === node) {
            return;
        }
        parent.children.push(node);
    });

    function finalize(node) {
        if (node.children.length > 0) {
            node.menuItem.children = node.children.map((child) => child.menuItem);
            node.children.forEach(finalize);
        }
    }

    roots.forEach(finalize);
    return roots.map((root) => root.menuItem);
}

// 按name递归查找菜单节点 20260831 新增,
function findMenuNodeByName(tree, name) {
    for (const node of tree) {
        if (node.name === name) {
            return node;
        }
        if (node.children) {
            const found = findMenuNodeByName(node.children, name);
            if (found) {
                return found;
            }
        }
    }
    return null;
}

// 查询当前库的区域标签，用于生成墓区设置下的区域三级菜单 20260831 新增,
async function fetchRegionTags(dataBaseName) {
    return pool.query(`SELECT id, tagName FROM ${dataBaseName}.taginfo WHERE tagType = 'region'`);
}

// 在指定一级菜单下动态追加区域三级菜单，每个区域一个入口，点击后携带区域打开对应页面 20260831 新增,
// 路径段使用taginfo的id（ASCII），避免中文路径在vue-router中编码不一致导致刷新404；区域值经meta.region下发,
// 标题为"区域+上级菜单名"，页签与菜单均取meta.title；二级菜单改名后三级菜单自动跟随 20260919 修改,
async function appendRegionMenus(menuTree, dataBaseName, parentMenuName) {
    const parentNode = findMenuNodeByName(menuTree, parentMenuName);
    if (!parentNode) {
        return;
    }
    try {
        const regions = await fetchRegionTags(dataBaseName);
        if (regions.length > 0) {
            // 后缀取二级菜单自身标题；英文后缀以字母开头时与区域名之间补空格（中英双语菜单） 20260919 修改,
            const parentTitle = parentNode.meta?.title || {};
            const zhSuffix = parentTitle.zh_CN || '';
            const enSuffix = parentTitle.en_US || '';
            const separator = /^[A-Za-z]/.test(enSuffix) ? ' ' : '';
            parentNode.children = regions.map((item) => ({
                path: `region-${item.id}`,
                name: `${parentMenuName}-region-${item.id}`,
                component: `/${parentMenuName}/index`,
                meta: { title: { zh_CN: `${item.tagName}${zhSuffix}`, en_US: `${item.tagName}${separator}${enSuffix}` }, region: item.tagName },
            }));
        }
    } catch (error) {
        // 区域查询失败时保留原有菜单结构，不影响登录进入 20260831 新增,
        console.log('appendRegionMenus failed:', parentMenuName, error.message);
    }
}

router.get('/', async (req, res) => {
    try {
        if (!req.data) {
            return res.status(401).json({ error: public.TOKEN_EXPIRED_MESSAGE });
        }
        const conditionSql = `SELECT b.idMenu FROM gm_data_000.account_power a,gm_data_000.operator_power b 
        WHERE a.dataBaseName = ? and b.idOperator = ?
        and a.idMenu = b.idMenu and a.useMenu = 1 and b.useMenu = 1 and a.isDeleted = 0`;
        const conditionParams = [req.data.dataBase, req.data.userId];
        const menuRows = await pool.query(`SELECT * FROM gm_data_000.menu WHERE id in (${conditionSql}) ORDER BY id`, conditionParams);
        const menuTree = buildMenuTreeFromRows(menuRows);
        // 墓区设置、墓区销售、墓区下葬均按区域生成三级子菜单 20260831 修改,
        await appendRegionMenus(menuTree, req.data.dataBase, 'room');
        await appendRegionMenus(menuTree, req.data.dataBase, 'sale');
        await appendRegionMenus(menuTree, req.data.dataBase, 'buried');
        await appendRegionMenus(menuTree, req.data.dataBase, 'reserve');
        // 管理费收款按区域生成三级子菜单，与墓区设置/销售/下葬/预定一致 20260909 新增,
        await appendRegionMenus(menuTree, req.data.dataBase, 'adminfee');
        // 墓位联系人按区域生成三级子菜单，与墓区设置/销售/下葬/预定/管理费收款一致 20260909 新增,
        await appendRegionMenus(menuTree, req.data.dataBase, 'contacts');
        // 墓位迁出按区域生成三级子菜单，与墓区下葬一致 20260916 新增,
        await appendRegionMenus(menuTree, req.data.dataBase, 'transferOut');
        return public.respondList(res, menuTree);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});


