// 统一授权守卫:平台管理员判定、全局管理接口授权、RBAC 菜单动作校验 20260917 越权收口,
const pool = require('./database');
const public = require('./public');
const permissionTemplate = require('./lib/permissionTemplate');

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

// 菜单权限命中结果短 TTL 缓存(审查修复 20261021 P2 性能):一次页面加载会并行打 6~10 个接口前缀,
// 每个守卫都要跑一遍 operator_power JOIN(共 3 张表),而权限数据在几十秒内基本不变,
// 按 userId + 菜单集合折叠成一次查库;命中与未命中均缓存(拒绝路径也常被反复重试),
// 条目数超上限时按插入顺序淘汰最早一半,避免大量冷账号长期占用内存 20261021 新增,
const POWER_CACHE_TTL_MS = 30 * 1000;
const POWER_CACHE_MAX_ENTRIES = 2000;
const powerCache = new Map();

function buildPowerCacheKey(userId, values, byMenuName) {
  return `${byMenuName ? 'name' : 'id'}:${userId}:${values.join(',')}`;
}

function evictPowerCacheOverflow() {
  if (powerCache.size <= POWER_CACHE_MAX_ENTRIES) {
    return;
  }
  const dropCount = Math.ceil(powerCache.size / 2);
  for (const key of powerCache.keys()) {
    if (dropCount <= 0) break;
    powerCache.delete(key);
    dropCount -= 1;
  }
}

async function queryMenuPowerHitCached(userId, values, byMenuName) {
  const key = buildPowerCacheKey(userId, values, byMenuName);
  const cached = powerCache.get(key);
  if (cached && Date.now() - cached.at < POWER_CACHE_TTL_MS) {
    return cached.hit;
  }
  const hit = await queryMenuPowerHit(userId, values, byMenuName);
  powerCache.set(key, { at: Date.now(), hit });
  evictPowerCacheOverflow();
  return hit;
}

// 授权相关变更后主动作废缓存:权限开关、操作员软删/改区域都会影响守卫结果,
// 旧口径靠 30s TTL 自然过期,使管理员改完权限后操作员仍有一段错乱窗口 20261021 新增,
function invalidateAuthCaches() {
  powerCache.clear();
  regionScopeCache.clear();
  powerConfigCache.clear();
}

// 功能级权限白名单缓存(20261023 功能级权限改造新增):
// 按 userId + 菜单 name 缓存该操作员在该菜单下的 operator_power 行(useMenu 命中与 powerConfig 一并取出),
// 与 powerCache 同 TTL/同失效口径;一次页面加载并行打多个墓位业务写接口时只查一次库。
const powerConfigCache = new Map();

// powerConfig 兼容三种落库形态:mysql2 对 json 列可能直接回对象、回字符串,或列为 NULL/未定义。
// 统一归一为对象;NULL/未配置返回 null(触发"不限功能"回退),解析异常同样按 null 回退并告警,
// (回退方向与存量行 NULL 的旧行为一致,不会因一次脏数据把合法操作员锁死) 20261023 新增,
function parsePowerConfig(raw) {
  if (raw === null || raw === undefined || raw === '') {
    return null;
  }
  if (typeof raw === 'object') {
    return raw;
  }
  try {
    return JSON.parse(String(raw));
  } catch (error) {
    console.warn('[rbac] powerConfig 解析失败,按不限功能回退:', error.message);
    return null;
  }
}

// 取操作员在某菜单下的权限行(经菜单 name 关联);命中 useMenu=1 才有 row,
// row 为 null 表示无菜单权限;row.powerConfig 为解析后的授权白名单对象或 null,
// row.menuTemplate 为该菜单 menu.powerConfig 解析出的功能模板(菜单未纳入功能级管控时为 null) 20261023 新增/改造,
async function fetchMenuPowerRowCached(userId, menuName) {
  const key = `${userId}:${menuName}`;
  const cached = powerConfigCache.get(key);
  if (cached && Date.now() - cached.at < POWER_CACHE_TTL_MS) {
    return cached.row;
  }
  const sql =
    'SELECT a.powerConfig AS powerConfig, m.powerConfig AS menuTemplate FROM gm_data_000.operator_power a ' +
    'JOIN gm_data_000.operator b ON a.idOperator = b.idOperator AND b.isDeleted = 0 ' +
    'JOIN gm_data_000.menu m ON m.id = a.idMenu ' +
    'WHERE a.idOperator = ? AND a.useMenu = 1 AND m.name = ? LIMIT 1';
  const rows = await pool.query(sql, [userId, menuName]);
  const row =
    Array.isArray(rows) && rows.length > 0
      ? {
          powerConfig: parsePowerConfig(rows[0].powerConfig),
          menuTemplate: permissionTemplate.parseTemplate(rows[0].menuTemplate),
        }
      : null;
  powerConfigCache.set(key, { at: Date.now(), row });
  // 条目数超上限时按插入顺序淘汰最早一半,与 powerCache 同策略,避免大量冷账号长期占用内存,
  if (powerConfigCache.size > POWER_CACHE_MAX_ENTRIES) {
    const dropCount = Math.ceil(powerConfigCache.size / 2);
    for (const cacheKey of powerConfigCache.keys()) {
      if (dropCount <= 0) break;
      powerConfigCache.delete(cacheKey);
      dropCount -= 1;
    }
  }
  return row;
}

// 白名单判定:cfg 为 null(未配置/回退)一律放行;否则仅当 cfg[fn].actions[action] 显式为 1 才有权,
// 键缺失/为 0 视为无权(缺省禁止) 20261023 新增,
function isFunctionActionGranted(cfg, fn, action) {
  if (cfg === null || cfg === undefined) {
    return true;
  }
  const fnCfg = cfg[fn];
  if (!fnCfg || !fnCfg.actions) {
    return false;
  }
  return Number(fnCfg.actions[action]) === 1;
}

// RBAC 功能级守卫:在菜单权限(useMenu=1)之上,再按"功能×动作"白名单收口 20261023 新增,
// opts.fn 缺省时运行期按该菜单 menu.powerConfig 模板从 req.body/query 的 type 解析;
// opts.action 由注册表按路由显式声明。
// 判定顺序:1) 平台管理员放行; 2) 无菜单权限→区分"菜单未配置/无权限"并 403; 3) 按白名单判 fn.action;
// 区域(数据轴)不在本守卫处理,交由条目上已有的 requireRegionOwnership 把守,
function requireFunctionPower(menuName, opts) {
  const options = opts || {};
  return async function (req, res, next) {
    if (isPlatformAdmin(req)) {
      return next();
    }
    try {
      const row = await fetchMenuPowerRowCached(req.data.userId, menuName);
      if (!row) {
        if (!(await anyMenuNameConfigured([menuName]))) {
          console.error('[rbac] 菜单未配置,拒绝访问:', menuName);
          return public.respondError(res, 403, '无权限:菜单未配置!');
        }
        return public.respondError(res, 403, '无权限:当前账号缺少该菜单操作权限!');
      }
      const fn = options.fn || permissionTemplate.resolveFunctionFromTemplate(row.menuTemplate, menuName, req);
      const action = options.action;
      if (!fn || !action) {
        // 功能/动作无法确定:不属于本守卫的判定范围(如菜单未纳入功能模板),按菜单权限放行,
        return next();
      }
      if (!isFunctionActionGranted(row.powerConfig, fn, action)) {
        return public.respondError(res, 403, '无权限:当前账号缺少该功能操作权限!');
      }
      return next();
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  };
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
      if (await queryMenuPowerHitCached(req.data.userId, [menuId], false)) {
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
      if (await queryMenuPowerHitCached(req.data.userId, [menuName], true)) {
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
      if (await queryMenuPowerHitCached(req.data.userId, menuNames, true)) {
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

// 共用详情页(room-detail)取数放行:打开详情需并行拉 7 类数据(room/预定/销售/下葬/管理费/联系人/迁出),
// 它们分属 7 个业务菜单接口前缀。若逐个按自身菜单校验,只开通部分模块的租户点详情会整批 403,
// 而前端 Promise.all 一遇失败即静默放弃(详情视图不出现且无任何提示),表现为"点详情没反应"。
// 口径统一为:调用"详情专用取数路径"时,只要具备任一含详情页功能菜单的 useMenu 即放行,
// 各页卡片列表(/room /canSale /parkTree /room?park=region= 等)仍按自身菜单严格校验 20261004 修改,
// 名单已剔除 sale/buried/contacts/reserve(菜单 103102/103103/103105/103104 登记页已下线,菜单行本身不再下发,
// 留在名单里只会变成一个永不命中的死项;详情取数靠墓位业务/墓位设置/各查询页菜单即可命中) 20261023 剔除 reserve,
const DETAIL_PAGE_MENUS = [
  'room', 'adminfee', 'transferOut',
  'gravePlotBusiness', 'managementPeriod',
  'roomQuery', 'saleQuery', 'buriedQuery', 'adminfeeQuery', 'contactsQuery', 'transferOutQuery',
];

// 详情聚合放行的显式路径白名单(审查修复 20261021 二轮 P1-3):原判定是“路径形状猜测”
// (req.path 为 /idList、/get-by-room,或裸 / 且带 idRoom),由此带来三处口径外溢:
// 1) 挂了 queryDetail 的前缀里,凡形状吻合的路径都走宽松校验,包括该前缀上根本不存在的路由(如 /api/sale-query/idList);
// 2) 裸 / 只看“带 idRoom 且不带 park/region”,今后同前缀新增一个带 idRoom 的列表接口会被误升级为详情口径;
// 3) 前端 useRoomDetail 实际并行拉 7 类,此表中迁出记录一前(/api/transferOut-query 裸 /)此前未登记详情放行,
//    只有其它墓位菜单的操作员点详情会因这一路 403 使整个详情打不开(与本口径初衷相悖),
// 现按「挂载前缀 + 路径」逐项登记,并限定 GET 且 idRoom 必须是数值,任一不吻合即回到该前缀自身的严格菜单口径,
const DETAIL_AGGREGATE_ROUTES = [
  { prefix: '/api/room-query', path: '/idList' },
  { prefix: '/api/sale-query', path: '/get-by-room' },
  { prefix: '/api/reserve-query', path: '/get-by-room' },
  { prefix: '/api/buried-query', path: '/' },
  { prefix: '/api/adminfee-query', path: '/' },
  { prefix: '/api/contacts-query', path: '/' },
  // 迁出前缀同时服务迁出业务页与迁出查询页,权限口径由本条目的 anyMenu 担当,此处只多一道详情放行,
  { prefix: '/api/transferOut-query', path: '/' },
];

// 详情专用路径判定:req.path 已被 express 剥掉挂载前缀,前缀取 req.baseUrl(守卫中间件按条目 path 挂载,因此恰为本表登记的完整前缀),
// 末尾斜杠与无斜杠两种写法在 Express 下 path 分别为 '/' 与 '',一并归一 20261004 新增 20261021 二轮 P1-3 改为显式白名单,
function isDetailAggregateRequest(req) {
  if (String(req.method || '').toUpperCase() !== 'GET') {
    return false;
  }
  const prefix = String(req.baseUrl || '');
  const path = String(req.path || '');
  const normalizedPath = path === '' ? '/' : path;
  if (!DETAIL_AGGREGATE_ROUTES.some((rule) => rule.prefix === prefix && rule.path === normalizedPath)) {
    return false;
  }
  // 详情取数必然带数值 idRoom:缺失或非法时不升级为宽松口径——路由自身会回 400,但权限口径不该被参数形状放大,
  return public.parseNumericParam(req.query && req.query.idRoom) !== null;
}

// query 前缀守卫:详情取数路径按"任一详情页菜单"放行,其余路径维持单菜单严格校验 20261004 新增,
// menuName 可为单个菜单名,也可为“任一命中”的菜单名数组(迁出前缀即同时挂业务页与查询页两个菜单) 20261021 二轮 P1-3 扩展,
function requireQueryPowerWithDetail(menuName) {
  const pagePower = Array.isArray(menuName) ? requirePowerByAnyMenuName(...menuName) : requirePowerByMenuName(menuName);
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
// 返回空数组代表"不做区域过滤",仅以下两种情况为空:1) region 未配置; 2) 平台管理员(跨区域运维角色,负责园区设置/票据配置/给操作员分配区域,
// 若按其 region 收窄会出现"管理员填了区域就管不了其它区域"的自锁) 20261010 新增,
// 取数失败不再吞异常返回空数组(旧口径为 3) 查询失败):空名单在下游一律被当作"不过滤",区域管理员遇到
// operator 表查询抖动时会瞬时拿到全量数据与全量区域下拉,属于 fail-open;现改为向上抛错,
// 由 requireRegionScope / 各查询接口统一回 500,宁可报错不可越权 20261021 审查修复二轮 P1-4,
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
  // 此处取数失败仍降为空名单:该分支不参与越权判定(分配 region 本就是管理动作),
  // 且真正的权限边界由 requirePowerByMenuName('operator') 把守,不影响安全口径 20261021 审查修复二轮 P1-4,
  if (isRegionAssignmentRequest(req)) {
    try {
      req.operatorRegions = await fetchOperatorRegions(req);
    } catch (error) {
      console.warn('region scope skipped:', req.data.userId, error.message);
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

// 主键记录区域归属校验中间件工厂:requireRegionScope 只校验显式 region 参数,按主键直取直写的
// 详情/修改/软删路径不经过该判定——限定 A 区的操作员猜到 B 区 idRoom 仍可读取甚至作废 B 区数据。
// 本中间件在 handler 前按主键查出记录所属 region 并验证∈名单(水平越权收口,审查修复 20261021 ④):
// - table='room' 直查 room.region;其余业务表(均有 idRoom 列)JOIN room 取 region;
// - 名单为空(平台管理员/未配区域)不拦截;参数缺失/非法交 handler 原有 400 逻辑;
// - 记录不存在不拦截(无数据可泄,由 handler 回空结果/0 行);
// - table/idField/idParam 均为代码侧固定字符串,不接受请求体输入,无注入面 20261021 新增,
function requireRegionOwnership({ table, idField = 'idRoom', idParam = 'idRoom' }) {
  return async function (req, res, next) {
    const allowed = req.operatorRegions;
    if (!Array.isArray(allowed) || allowed.length === 0 || !req.data || !req.data.dataBase) {
      return next();
    }
    const raw = (req.query && req.query[idParam]) ?? (req.body && req.body[idParam]);
    const idValue = public.parseNumericParam(raw);
    if (idValue === null) {
      return next();
    }
    try {
      // 库名来自 token,防御性再过一次标识符白名单(防伪造 token 载荷把库名拼成注入载体)
      const db = public.assertIdentifier(req.data.dataBase, 'database');
      const sql = table === 'room'
        ? `SELECT region FROM ${db}.room WHERE idRoom = ? LIMIT 1`
        : `SELECT r.region FROM ${db}.${table} t JOIN ${db}.room r ON t.idRoom = r.idRoom WHERE t.${idField} = ? LIMIT 1`;
      const rows = await pool.query(sql, [idValue]);
      if (!Array.isArray(rows) || rows.length === 0) {
        return next();
      }
      if (!allowed.includes(String(rows[0].region || '').trim())) {
        console.log('region ownership denied:', req.data.userId, req.method, req.originalUrl, table, idValue);
        return res.status(403).json({ error: '无权限:该记录不属于当前区域!' });
      }
      return next();
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  };
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
  requireFunctionPower,
  parsePowerConfig,
  isFunctionActionGranted,
  DETAIL_AGGREGATE_ROUTES,
  DETAIL_PAGE_MENUS,
  invalidateAuthCaches,
  fetchOperatorRegions,
  filterByOperatorRegions,
  requireRegionScope,
  requireRegionOwnership,
  buildRegionCondition,
};

