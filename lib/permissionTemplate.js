// 功能级权限模板:数据源为 gm_data_000.menu.powerConfig(JSON),不再维护代码侧目录 20261023 改造:
// 模板形如 { "功能名": ["动作", ...] },单功能菜单的功能键 = 菜单名;gravePlotBusiness 一页多功能,
// 功能键按请求 type 归一(sale/buried/...),type 缺省或未知落 business。
// 模板只在启动时从库加载一次(运营改模板后重启生效);请求期守卫直接用权限行同一 JOIN 取出的
// m.powerConfig,不依赖本缓存,避免缓存与库不一致。实际授权仍存 operator_power.powerConfig。
const database = require('../database');

// menuName -> { fn: [action...] };用 Object.create(null) 避免 __proto__ 之类的菜单名污染原型链,
let templates = Object.create(null);

// 归一模板:json 列可能回对象或字符串;非法/空模板返回 null(该菜单不做功能级管控),
function parseTemplate(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  let value = raw;
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch (error) {
      console.warn('[permissionTemplate] menu.powerConfig 解析失败,按未纳入功能级管控处理:', error.message);
      return null;
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const template = Object.create(null);
  Object.entries(value).forEach(([fn, actions]) => {
    if (!fn || !Array.isArray(actions)) {
      return;
    }
    const list = [...new Set(actions.map((action) => String(action)).filter(Boolean))];
    if (list.length > 0) {
      template[fn] = list;
    }
  });
  return Object.keys(template).length > 0 ? template : null;
}

// 由 menu 行({ name, powerConfig })重建缓存,返回本次装载的菜单数;启动与脚本共用同一归一逻辑,
function setTemplatesFromRows(rows) {
  const next = Object.create(null);
  (Array.isArray(rows) ? rows : []).forEach((row) => {
    const name = row && row.name !== undefined ? String(row.name) : '';
    const template = parseTemplate(row && row.powerConfig);
    if (name && template) {
      next[name] = template;
    }
  });
  templates = next;
  return Object.keys(next).length;
}

// 测试/脚本注入:{ menuName: { fn: [actions] } }(模板也可传 JSON 字符串),
function setTemplates(map) {
  const rows = Object.entries(map || {}).map(([name, powerConfig]) => ({ name, powerConfig }));
  return setTemplatesFromRows(rows);
}

// 启动时加载:menu 为全局共享表,固定读 gm_data_000;
// 列缺失/模板全空都属“升级脚本未执行”,直接给出可执行的修复命令:
// 否则只能等到注册表体检阶段报 29 条“未纳入功能级管控”,真正原因会被噪音埋掉 20261023 新增,
async function loadFromDatabase(db = database) {
  let rows;
  try {
    rows = await db.query('SELECT name, powerConfig FROM gm_data_000.menu WHERE powerConfig IS NOT NULL');
  } catch (error) {
    if (error && error.code === 'ER_BAD_FIELD_ERROR') {
      throw new Error('gm_data_000.menu 缺少 powerConfig 列,请先执行 node scripts/add-menu-power-config.js 后再启动');
    }
    throw error;
  }
  const count = setTemplatesFromRows(rows);
  if (count === 0) {
    throw new Error('menu.powerConfig 未配置任何功能级权限模板,请先执行 node scripts/add-menu-power-config.js 后再启动');
  }
  console.log(`[permissionTemplate] 已加载 ${count} 个菜单的功能级权限模板`);
  return count;
}

function getTemplates() {
  return templates;
}

function isFunctionMenu(menuName) {
  return Object.prototype.hasOwnProperty.call(templates, String(menuName));
}

function getFunctions(menuName) {
  return Object.keys(templates[String(menuName)] || {});
}

function getFunctionActions(menuName, fn) {
  const template = templates[String(menuName)];
  return (template && template[fn]) || [];
}

function isValidFn(menuName, fn) {
  return Object.prototype.hasOwnProperty.call(templates[String(menuName)] || {}, fn);
}

function isValidAction(menuName, fn, action) {
  return isValidActionInTemplate(templates[String(menuName)], fn, action);
}

// 纯函数版本:供 /config 直接使用本次 SELECT 取出的菜单模板(不依赖启动缓存),
function isValidFnInTemplate(template, fn) {
  return Boolean(template) && Object.prototype.hasOwnProperty.call(template, fn);
}

function isValidActionInTemplate(template, fn, action) {
  if (!isValidFnInTemplate(template, fn)) {
    return false;
  }
  return template[fn].includes(String(action));
}

// 运行期解析功能键:单功能菜单(模板键 = 菜单名)直接返回菜单名;
// 集成页按 type 命中模板键;缺省/未知 type 仅在模板仍含 business 时回退 business——
// business(默认业务形态)已于 20261023 从墓位业务模板移除,此处的回退只用于兼容未执行
// db:remove-business-function 的存量库;新库解析为 null,守卫改为按菜单权限放行,
function resolveFunctionFromTemplate(template, menuName, req) {
  if (!template) {
    return null;
  }
  const menuKey = String(menuName || '');
  if (Object.prototype.hasOwnProperty.call(template, menuKey)) {
    return menuKey;
  }
  const body = req && req.body ? req.body : {};
  const query = req && req.query ? req.query : {};
  const rawType = body.type !== undefined ? body.type : query.type;
  const type = String(rawType === undefined || rawType === null ? '' : rawType).trim();
  if (type && Object.prototype.hasOwnProperty.call(template, type)) {
    return type;
  }
  if (Object.prototype.hasOwnProperty.call(template, 'business')) {
    return 'business';
  }
  return null;
}

function resolveFunction(menuName, req) {
  return resolveFunctionFromTemplate(templates[String(menuName)], menuName, req);
}

function resetForTesting() {
  templates = Object.create(null);
}

module.exports = {
  parseTemplate,
  setTemplatesFromRows,
  setTemplates,
  loadFromDatabase,
  getTemplates,
  isFunctionMenu,
  getFunctions,
  getFunctionActions,
  isValidFn,
  isValidAction,
  isValidFnInTemplate,
  isValidActionInTemplate,
  resolveFunction,
  resolveFunctionFromTemplate,
  resetForTesting,
};
