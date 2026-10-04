// 统一授权守卫:平台管理员判定、全局管理接口授权、RBAC 菜单动作校验 20260917 越权收口,
const pool = require('./database');
const public = require('./public');

// 平台管理员:gm_data_000 租户的账户(isAccount=1);旧 token 无 isAccount 字段时安全默认非管理员,
function isPlatformAdmin(req) {
  return Number(req.data && req.data.isAccount) === 1 && req.data.dataBase === 'gm_data_000';
}

// 全局管理接口中间件:仅平台管理员可调用 20260917 越权收口,
function requirePlatformAdmin(req, res, next) {
  if (isPlatformAdmin(req)) {
    return next();
  }
  return res.status(403).json({ error: '无权限:仅平台管理员可操作!' });
}

// RBAC 中间件:校验当前操作员在指定菜单下具备菜单权限(useMenu=1);平台管理员全放行,
// 业务规则:动作级字段(useCreate/useModify/useDelete)未启用,useMenu=1 即视为具备全部操作权限 20260918 修正,
function requirePower(menuId) {
  return async function (req, res, next) {
    if (isPlatformAdmin(req)) {
      return next();
    }
    try {
      const sql =
        'SELECT 1 FROM gm_data_000.operator_power a ' +
        'JOIN gm_data_000.operator b ON a.idOperator = b.idOperator ' +
        'WHERE b.idOperator = ? and b.isDeleted = 0 and a.idMenu = ? and a.useMenu = 1';
      const rows = await pool.query(sql, [req.data.userId, menuId]);
      if (Array.isArray(rows) && rows.length > 0) {
        return next();
      }
      return res.status(403).json({ error: '无权限:当前账号缺少该菜单操作权限!' });
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  };
}

// RBAC 按菜单 name 动态解析当前 idMenu 后校验:菜单 id 会因显示顺序调整而变化,代码不能写死 id;
// 每次请求查 menu 表拿 id(菜单表极小,开销可忽略),name 缺失视为配置错误拒绝访问 20260919 动态化,
function requirePowerByMenuName(menuName) {
  return async function (req, res, next) {
    if (isPlatformAdmin(req)) {
      return next();
    }
    try {
      const menuRows = await pool.query('SELECT id FROM gm_data_000.menu WHERE name = ?', [menuName]);
      if (!Array.isArray(menuRows) || menuRows.length === 0) {
        console.error('[rbac] 菜单未配置,拒绝访问:', menuName);
        return res.status(403).json({ error: '无权限:菜单未配置!' });
      }
      const menuId = menuRows[0].id;
      const sql =
        'SELECT 1 FROM gm_data_000.operator_power a ' +
        'JOIN gm_data_000.operator b ON a.idOperator = b.idOperator ' +
        'WHERE b.idOperator = ? and b.isDeleted = 0 and a.idMenu = ? and a.useMenu = 1';
      const rows = await pool.query(sql, [req.data.userId, menuId]);
      if (Array.isArray(rows) && rows.length > 0) {
        return next();
      }
      return res.status(403).json({ error: '无权限:当前账号缺少该菜单操作权限!' });
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  };
}

// RBAC 多菜单任一命中放行:业务页与对应查询页共用同一接口时使用,
// 如 /api/transferOut-query 同时服务墓位迁出(transferOut)与墓位迁出查询(transferOutQuery)两个菜单,
// 任一菜单有 useMenu=1 权限即放行;全部缺失或菜单未配置时拒绝 20260921 新增,
function requirePowerByAnyMenuName(...menuNames) {
  return async function (req, res, next) {
    if (isPlatformAdmin(req)) {
      return next();
    }
    try {
      const placeholders = menuNames.map(() => '?').join(',');
      const menuRows = await pool.query(
        `SELECT id FROM gm_data_000.menu WHERE name IN (${placeholders})`,
        menuNames,
      );
      const menuIds = Array.isArray(menuRows) ? menuRows.map((row) => row.id) : [];
      if (menuIds.length === 0) {
        console.error('[rbac] 菜单未配置,拒绝访问:', menuNames.join('/'));
        return res.status(403).json({ error: '无权限:菜单未配置!' });
      }
      const sql =
        'SELECT 1 FROM gm_data_000.operator_power a ' +
        'JOIN gm_data_000.operator b ON a.idOperator = b.idOperator ' +
        'WHERE b.idOperator = ? and b.isDeleted = 0 and a.idMenu IN (?) and a.useMenu = 1';
      const rows = await pool.query(sql, [req.data.userId, menuIds]);
      if (Array.isArray(rows) && rows.length > 0) {
        return next();
      }
      return res.status(403).json({ error: '无权限:当前账号缺少该菜单操作权限!' });
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  };
}

// 共用详情页(room-detail)取数放行:打开详情需并行拉 6 类数据(room/预定/销售/下葬/管理费/联系人),
// 它们分属 6 个业务菜单接口前缀。若逐个按自身菜单校验,只开通部分模块的租户点详情会整批 403,
// 而前端 Promise.all 一遇失败即静默放弃(详情视图不出现且无任何提示),表现为"点详情没反应"。
// 口径统一为:调用"详情专用取数路径"时,只要具备任一含详情页功能菜单的 useMenu 即放行,
// 各页卡片列表(/room /canSale /parkTree /room?park=region= 等)仍按自身菜单严格校验 20261004 修改,
const DETAIL_PAGE_MENUS = [
  'room', 'sale', 'buried', 'reserve', 'contacts', 'adminfee', 'transferOut',
  'gravePlotBusiness', 'managementPeriod',
  'roomQuery', 'saleQuery', 'buriedQuery', 'adminfeeQuery', 'contactsQuery', 'transferOutQuery',
];

// 详情专用路径判定:req.path 已被 express 剥掉挂载前缀,
// /idList = room-query 单墓位;/get-by-room = sale/reserve 活动记录;
// 裸 / 且仅带 idRoom = buried/contacts/adminfee 的该墓位记录列表(带 park/region 的卡片列表不算)20261004 新增,
function isDetailAggregateRequest(req) {
  const path = String(req.path || '');
  if (path === '/idList' || path === '/get-by-room') {
    return true;
  }
  const query = req.query || {};
  return (path === '/' || path === '') && !!query.idRoom && !query.park && !query.region;
}

// query 前缀守卫:详情取数路径按"任一详情页菜单"放行,其余路径维持单菜单严格校验 20261004 新增,
function requireQueryPowerWithDetail(menuName) {
  const pagePower = requirePowerByMenuName(menuName);
  const detailPower = requirePowerByAnyMenuName(...DETAIL_PAGE_MENUS);
  return function (req, res, next) {
    if (isDetailAggregateRequest(req)) {
      return detailPower(req, res, next);
    }
    return pagePower(req, res, next);
  };
}

module.exports = {
  isPlatformAdmin,
  requirePlatformAdmin,
  requirePower,
  requirePowerByMenuName,
  requirePowerByAnyMenuName,
  requireQueryPowerWithDetail,
};

