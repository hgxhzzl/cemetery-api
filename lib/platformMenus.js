// 「用户管理」等仅平台账户(gm_data_000)可见的菜单子树业务口径(审查修复 20261021 三轮 P1-1 的延伸,20261022):
// 菜单侧下发兜底(menu.js filterPlatformOnlyMenus)与账户权限页列表过滤(accountPower/query.js)必须共用同一份根清单,
// 避免“接口能收口 / 菜单已隐藏,但账户权限配置页仍给租户留一行点开即 403 的死记录”这类三处口径漂移,
const PLATFORM_ONLY_MENU_ROOTS = ['101100'];

// 按 parent_id 从菜单行把若干根菜单展开成整棵子树的 id 集合(闭包):account_power 是扁平行、不含 parent_id,
// 无法直接从权限行判断“某条是不是用户管理的下级”,故借菜单表父链把根节点连同全部后代收进集合,供调用方按 idMenu 过滤;
// 用队列迭代到不动点(而非只取直接子级),使日后子树加深层级时无需再改这里,
function collectSubtreeIds(menuRows, roots) {
  const childrenByParent = new Map();
  menuRows.forEach((row) => {
    const parentId = String(row.parent_id);
    if (!childrenByParent.has(parentId)) {
      childrenByParent.set(parentId, []);
    }
    childrenByParent.get(parentId).push(String(row.id));
  });

  const collected = new Set();
  const queue = (roots || []).map(String);
  while (queue.length > 0) {
    const id = queue.shift();
    // 已收过则跳过,兼容根清单里同时列了父子节点或菜单父链出现环的情况,
    if (collected.has(id)) {
      continue;
    }
    collected.add(id);
    (childrenByParent.get(id) || []).forEach((child) => queue.push(child));
  }
  return collected;
}

module.exports = { PLATFORM_ONLY_MENU_ROOTS, collectSubtreeIds };
