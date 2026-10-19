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

// 菜单权限命中查询单语句化:按 name 集合时 JOIN menu 表匹配,按 idMenu 直配时不经过 menu 表,
// 一次 DB 往返完成 menu→operator_power→operator 链校验,替代旧两步查询(先查 menu 拿 id 再查权限) 20261019 性能优化,
// 约束:menu name / idMenu 的过滤条件必须写在 WHERE 里排在 a.idOperator 之后,与下方 [userId, ...values] 的顺序一致
async function queryMenuPowerHit(userId, values, byMenuName) {
  const holes = values.map(() => '?').join(', ');
  const sql =
    'SELECT 1 FROM gm_data_000.operator_power a ' +
    'JOIN gm_data_000.operator b ON a.idOperator = b.idOperator AND b.isDeleted = 0 ' +
    (byMenuName ? 'JOIN gm_data_000.menu m ON m.id = a.idMenu ' : '') +
    'WHERE a.idOperator = ? AND a.useMenu = 1 ' +
    (byMenuName ? `AND m.name IN (${holes})` : `AND a.idMenu IN (${holes})`);
  // 位置绑定陷阱:mysql2 按占位符在 SQL 里的出现顺序消费参数数组,旧写法把 m.name IN (?) 放在上面的
  // JOIN 段里,它早于 WHERE 的 a.idOperator = ?,结果菜单名被绑给 idOperator、userId 被绑给 m.name,
  // 命中查询恒为空,所有非平台管理员账号按 name 的守卫一律 403“缺少该菜单操作权限” 20261019 修复,
  const rows = await pool.query(sql, [userId, ...values]);
  return Array.isArray(rows) && rows.length > 0;
}

// 拒绝路径存在性检查:仅在权限查询未命中时补打一次库,用于区分"菜单未配置"与"有菜单无权限"两种文案,
// 放行路径(绝大多数请求)不触发 20261019 性能优化,
async function anyMenuNameConfigured(menuNames) {
  const holes = menuNames.map(() => '?').join(', ');
  const rows = await pool.query(`SELECT 1 FROM gm_data_000.menu WHERE name IN (${holes})`, menuNames);
  return Array.isArray(rows) && rows.length > 0;
}

// RBAC 中间件:校验当前操作员在指定菜单下具备菜单权限(useMenu=1);平台管理员全放行,
// 业务规则:动作级字段(useCreate/useModify/useDelete)未启用,useMenu=1 即视为具备全部操作权限 20260918 修正,
function requirePower(menuId) {
  return async function (req, res, next) {
    if (isPlatformAdmin(req)) {
      return next();
    }
    try {
      // 命中查询单语句化,口径与旧两步查询一致(b.isDeleted=0 + a.useMenu=1) 20261019 性能优化,
      if (await queryMenuPowerHit(req.data.userId, [menuId], false)) {
        return next();
      }
      return res.status(403).json({ error: '无权限:当前账号缺少该菜单操作权限!' });
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  };
}

// RBAC 按菜单 name 动态解析权限:菜单 id 会因显示顺序调整而变化,代码不能写死 id;
// 旧实现每次请求先查 menu 表拿 id 再查 operator_power(2 次往返),现合并为一条 JOIN 只打 1 次库,
// 菜单表极小且 name 已有索引,拒绝路径才补一次存在性检查以保留"菜单未配置"文案区分 20261019 性能优化,
// openPaths(可选):挂载前缀下的子路径白名单,命中则仅需登录不校验菜单权限。适用于区域/园区下拉这类
// 被多个业务页/查询页共用的参照数据:它们不能要求调用者具备“园区设置”菜单,否则未开该菜单的操作员会 403 使下拉空白 20261010 新增,
function requirePowerByMenuName(menuName, openPaths) {
  return async function (req, res, next) {
    if (isPlatformAdmin(req)) {
      return next();
    }
    // 注:中间件挂在 app.use('/api/park-query', ...) 下时 req.path 为去除前缀后的剩余路径(如 /region) 20261010 新增,
    if (Array.isArray(openPaths) && openPaths.includes(req.path)) {
      return next();
    }
    try {
      if (await queryMenuPowerHit(req.data.userId, [menuName], true)) {
        return next();
      }
      if (!(await anyMenuNameConfigured([menuName]))) {
        console.error('[rbac] 菜单未配置,拒绝访问:', menuName);
        return res.status(403).json({ error: '无权限:菜单未配置!' });
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
      // 任一菜单命中权限即放行:IN 一次性查全部 name,拒绝路径再按名单做存在性检查 20261019 性能优化,
      if (await queryMenuPowerHit(req.data.userId, menuNames, true)) {
        return next();
      }
      if (!(await anyMenuNameConfigured(menuNames))) {
        console.error('[rbac] 菜单未配置,拒绝访问:', menuNames.join('/'));
        return res.status(403).json({ error: '无权限:菜单未配置!' });
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

// 操作员区域名单短 TTL 缓存:30 秒内同一操作员不重复查库;管理员改完某操作员区域后
// 最多 30 秒自然生效,不需重启服务 20261010 新增,
const REGION_SCOPE_TTL_MS = 30 * 1000;
const regionScopeCache = new Map();

// 当前登录操作员的所属区域(operator.region,逗号分隔如"福东,福西"):菜单层区域二级菜单收窄与数据层区域下拉
// 共用同一口径,故从 menu.js 抽出到授权层统一收口 20261010 新增,
// 返回空数组代表"不做区域过滤",以下三种情况均回退到原有 account_power/operator_power 菜单权限口径:
// 1) region 未配置; 2) 查询失败; 3) 平台管理员(跨区域运维角色,负责园区设置/票据配置/给操作员分配区域,
// 若按其 region 收窄会出现"管理员填了区域就管不了其它区域"的自锁) 20261010 新增,
async function fetchOperatorRegions(req) {
  const idOperator = req && req.data && req.data.userId;
  if (!idOperator) {
    return [];
  }
  if (isPlatformAdmin(req)) {
    return [];
  }
  // 同一次页面加载会先后命中菜单/区域下拉/列表接口多次,按 userId 做短 TTL 缓存避免反复 PK 查询;
  // 空名单同样缓存(未配置区域/管理员),避免未配区域的账号每次请求都打库 20261010 新增,
  const cacheKey = String(idOperator);
  const cached = regionScopeCache.get(cacheKey);
  if (cached && Date.now() - cached.at < REGION_SCOPE_TTL_MS) {
    return cached.regions;
  }
  const regions = await readOperatorRegions(idOperator);
  regionScopeCache.set(cacheKey, { at: Date.now(), regions });
  return regions;
}

async function readOperatorRegions(idOperator) {
  try {
    const rows = await pool.query('SELECT region FROM gm_data_000.operator WHERE idOperator = ?', [idOperator]);
    if (!Array.isArray(rows) || rows.length === 0 || !rows[0].region) {
      return [];
    }
    return String(rows[0].region)
      // 分隔符同时接受半角/全角逗号:前端提交用半角,但存量数据和人工维护的库可能写成全角“，”。
      // 一旦漏切会把“福东，福西”当成一个区域名,匹配不到任何标签,进而把该组功能整体隐藏掉 20261010 加固,
      .split(/[,，]/)
      .map((item) => item.trim())
      .filter((item) => item !== '');
  } catch (error) {
    console.log('fetchOperatorRegions failed:', idOperator, error.message);
    return [];
  }
}

// 区域作用域中间件:挂在鉴权之后、业务路由之前。两件职责 20261010 新增,
// 1) 显式携带 region 的请求(GET query / POST body 均计)不在当前操作员区域名单内 → 403,
//    杜绝“前端选不到但直接改参调用”越权取/写其它区域数据;
// 2) 将解析好的名单挂到 req.operatorRegions,供列表接口在“未指定区域”时强制收窄,避免省略参数即拿到全量,
// 无名单(未配置区域/平台管理员)时不注入也不拦截,维持原有权限口径 20261010 新增,
// 区域名单按“自身所属区域”收窄本意是隔离数据;但“给操作员分配区域”是管理动作,分配的 region 不属于调用者
// 自身筛选作用域,且 /api/operator-save 前缀已由 requirePowerByMenuName('operator') 把守,故对该写操作不做越权拦截;
// 否则区域管理员在下拉里能选到范围外区域、提交却被本中间件 403(表现即“修改操作员提交失败”)20261012 新增,
function isRegionAssignmentRequest(req) {
  return (
    req.method === 'POST' &&
    (req.path === '/api/operator-save/insert' || req.path === '/api/operator-save/update')
  );
}

async function requireRegionScope(req, res, next) {
  if (!req.data) {
    return next();
  }
  // 区域分配写操作:仅注入名单供下游参考,跳过越权拦截(名单为空也照常放行)20261012 新增,
  if (isRegionAssignmentRequest(req)) {
    try {
      req.operatorRegions = await fetchOperatorRegions(req);
    } catch (error) {
      req.operatorRegions = [];
    }
    return next();
  }
  try {
    const allowed = await fetchOperatorRegions(req);
    req.operatorRegions = allowed;
    if (allowed.length === 0) {
      return next();
    }
    const raw = String((req.query && req.query.region) || (req.body && req.body.region) || '').trim();
    if (raw) {
      // 多值形式也得过审:操作员保存时 region 是“福东,福西”这样的分配列表而非单一筛选值,
      // 按单值比对会把正常的多区域分配误判成越权,故逐项校验且任一项不在名单即拦下 20261010 加固,
      const asked = raw.split(/[,，]/).map((item) => item.trim()).filter((item) => item !== '');
      const crossed = asked.filter((item) => !allowed.includes(item));
      if (crossed.length > 0) {
        console.log('region scope denied:', req.data.userId, req.method, req.originalUrl, 'crossed=' + crossed.join('|'));
        return res.status(403).json({ error: '无权限:当前账号不属于该区域!' });
      }
    }
    return next();
  } catch (error) {
    return public.handleQueryError(res, error);
  }
}

// 列表接口区域条件构造器:统一三段口径 20261010 新增,
// 1) 请求指定了 region → 等值匹配(越权值已由 requireRegionScope 在入口拦下);
// 2) 未指定但操作员有区域名单 → 按名单 IN 收窄,防止省略参数拿到全库;
// 3) 无名单(未配置/管理员)且未指定 → 返回 null 不加条件,完全维持旧行为,
// 调用方拿到 null 时应退回原来的“不加过滤”分支,不得直接拼接 undefined 20261010 新增,
function buildRegionCondition(req, column) {
  const region = String((req.query && req.query.region) || '').trim();
  if (region) {
    return { sql: `${column} = ?`, params: [region] };
  }
  const allowed = (req && Array.isArray(req.operatorRegions)) ? req.operatorRegions : [];
  if (allowed.length > 0) {
    return { sql: `${column} IN (${allowed.map(() => '?').join(', ')})`, params: [...allowed] };
  }
  return null;
}

// 按操作员所属区域收窄名单:rows 中 fieldName 命中 allowedRegions 的才保留;
// allowedRegions 为空维持全量(即未配置区域/管理员的回退口径),调用方无需再各自判空 20261010 新增,
function filterByOperatorRegions(rows, fieldName, allowedRegions) {
  if (!Array.isArray(rows)) {
    return rows;
  }
  if (!Array.isArray(allowedRegions) || allowedRegions.length === 0) {
    return rows;
  }
  return rows.filter((row) => allowedRegions.includes(String(row[fieldName])));
}

module.exports = {
  isPlatformAdmin,
  requirePlatformAdmin,
  requirePower,
  requirePowerByMenuName,
  requirePowerByAnyMenuName,
  requireQueryPowerWithDetail,
  fetchOperatorRegions,
  filterByOperatorRegions,
  requireRegionScope,
  buildRegionCondition,
};

