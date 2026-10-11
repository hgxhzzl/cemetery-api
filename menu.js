const express = require('express');
const router = express.Router();
const pool = require('./database');
const public = require('./public');
const rbac = require('./rbac');
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

// 在一级菜单下按区域重组子菜单：区域作为二级菜单，原二级页面菜单下沉为三级并携带区域信息 20260923 修改,
// 路径段使用taginfo的id（ASCII），避免中文路径在vue-router中编码不一致导致刷新404；区域值经meta.region下发,
// 三级页面节点保留原菜单id，前端按idMenu匹配页面按钮权限（usePermission）不受层级变化影响,
// 不在 pageNames 内的二级菜单（如管理期限维护）保持原位不动 20260923 新增,
// allowedRegions 为当前操作员所属区域名单,非空时按其过滤区域二级菜单 20261010 新增,
async function rebuildRegionMenus(menuTree, dataBaseName, rootMenuName, pageNames, allowedRegions) {
    const rootNode = findMenuNodeByName(menuTree, rootMenuName);
    if (!rootNode || !Array.isArray(rootNode.children)) {
        return;
    }
    try {
        const allRegions = await fetchRegionTags(dataBaseName);
        // 已配置所属区域则按其收窄;未配置(空数组)维持全部区域,即回退到原有菜单权限口径 20261010 新增,
        const hasRegionLimit = Array.isArray(allowedRegions) && allowedRegions.length > 0;
        const regions = hasRegionLimit
            ? allRegions.filter((item) => allowedRegions.includes(item.tagName))
            : allRegions;
        const pageMenus = rootNode.children.filter((page) => pageNames.includes(page.name));
        if (pageMenus.length === 0) {
            return;
        }
        // 已配置区域但区域标签全部不匹配(区域被删除/改名等):不能回退成未分区域的扁平菜单,
        // 否则等于放开该组页面的全部区域数据访问,此处直接摘除这些页面菜单 20261010 新增,
        if (hasRegionLimit && regions.length === 0) {
            rootNode.children = rootNode.children.filter((page) => !pageNames.includes(page.name));
            return;
        }
        if (regions.length === 0) {
            return;
        }
        const keptMenus = rootNode.children.filter((page) => !pageNames.includes(page.name));
        rootNode.children = [
            ...regions.map((item) => ({
                path: `region-${item.id}`,
                name: `${rootMenuName}-region-${item.id}`,
                meta: { title: { zh_CN: item.tagName, en_US: item.tagName }, region: item.tagName },
                children: pageMenus.map((page) => ({
                    id: page.id,
                    path: page.path,
                    name: `${rootMenuName}-region-${item.id}-${page.name}`,
                    component: page.component,
                    // 三级标题带区域前缀（如"九泉山墓位销售"），区域二级+页面三级层级语义更完整 20260923 修改,
                    meta: {
                        title: {
                            zh_CN: `${item.tagName}${page.meta?.title?.zh_CN ?? ''}`,
                            en_US: `${item.tagName}${page.meta?.title?.en_US ?? page.meta?.title?.zh_CN ?? ''}`,
                        },
                        region: item.tagName,
                    },
                })),
            })),
            ...keptMenus,
        ];
    } catch (error) {
        // 区域查询失败时保留原有菜单结构，不影响登录进入 20260831 新增,
        console.log('rebuildRegionMenus failed:', rootMenuName, error.message);
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
        // 墓位业务：10 个页面菜单按区域重组为"区域二级 + 页面三级"结构 20260923 修改,
        // 管理费用收款/管理期限维护 20260925 自收费管理迁入墓位管理(菜单 id 103108/103109),一并挂到各区域下,
        // 区域二级菜单按当前操作员 operator.region 收窄,未配置区域(及平台管理员)时不做过滤;
        // 区域取数已上收到 rbac,与区域下拉同源 20261010 修改,
        const operatorRegions = await rbac.fetchOperatorRegions(req);
        await rebuildRegionMenus(menuTree, req.data.dataBase, 'operate', ['gravePlotBusiness', 'sale', 'buried', 'reserve', 'contacts', 'transferOut', 'room', 'adminfee', 'managementPeriod'], operatorRegions);
        return public.respondList(res, menuTree);
    } catch (error) {
        return public.handleQueryError(res, error);
    }
});


