const express = require('express');
const cors = require('cors')

//公用路径
const bodyParser = require('body-parser');
const vertoken = require('./token');
const loginState = require('./loginState');
const device = require('./device');
// 租户库名闸门(审查修复 20261021 二轮 P0-1):验签后、业务前的单点校验,实现见 tenant.js,
const tenant = require('./tenant');
const config = require('./config');
const requestContext = require('./requestContext');
const database = require('./database');
const public = require('./public');
const rbac = require('./rbac');
// 各业务路由的 require 与挂载已全部收进声明式注册表(审查修复 20261021 P1-4):
// 原先本文件里“守卫挂载表 + 路由挂载表”两张手工清单共 90+ 行,顺序即安全但只能靠注释与人工纪律维持,
// 现在新增接口只需在 routeRegistry.js 加一条条目,守卫与路由由 mountApiRoutes 按固定顺序统一挂载,
const routeRegistry = require('./routeRegistry');
const httpDefaults = require('./httpDefaults');
const pkg = require('./package.json');

const app = express();

// 全局兜底：Express 4 不捕获 async handler 抛出的 rejection，Node ≥15 默认策略直接崩进程；
// 这里记录日志并尽量为尚未应答的请求补发 500（requestContext 在同一异步链上可取到 res），
// 覆盖各路由 try 外的同步抛错路径（如语句构造 assertIdentifier） 20261021 审查修复②,
process.on('unhandledRejection', (reason) => {
  console.error(`[unhandledRejection][${requestContext.getRequestId()}]`, reason && reason.stack ? reason.stack : reason);
  try {
    const res = requestContext.getResponse();
    if (res && !res.headersSent) {
      res.status(500).json({ error: 'Internal server error' });
    }
  } catch (e) {
    // 补发失败仅记日志，避免兜底处理器自身抛错再次未捕获
    console.error('[unhandledRejection] respond failed:', e.message);
  }
});

// token 失效文案与统一 401 信封改由 public.respondUnauthorized 下发(审查修复 20261021 P1-5),
// 本文件不再单独引用 TOKEN_EXPIRED_MESSAGE,

// 请求关联号必须挂在最前(在任何一条日志之前):安全头/压缩/鉴权/业务各处的日志行首都靠它,
// 同时把该号回写 X-Request-Id 供前端报障时直接引用(审查修复 20261021 二轮 P2-16),
app.use(httpDefaults.attachRequestId);

// 安全响应头/请求日志/404 与终态错误信封均与业务无关,已抽到 httpDefaults.js 以便单测覆盖,
// 安全头必须挂在最前面:请求体解析失败/404/500 等短路路径同样要带头(审查修复 20261021 P2),
app.use(httpDefaults.securityHeaders);

// gzip 压缩紧跟安全头挂在所有业务路由之前:这样 404 兜底与终态错误信封的响应同样被覆盖,
// 而不只是正常业务响应(审查修复 20261021 二轮 P2-13),
app.use(httpDefaults.gzipJson);

//路由
app.get('/', (req, res) => {
  res.send('Hello, World!')
});

// 健康探针(审查修复 20261021 三轮 P2-6):必须挂在鉴权/响应信封中间件之前——免鉴权、响应不套 {code} 业务信封,
// 供 nginx/监控直接看 HTTP 200 探活;池占用取自 database.poolStats,超时取启动时 applyServerTimeouts 的回读值,
app.get('/health', httpDefaults.createHealthHandler({
  version: `${pkg.name}@${pkg.version}`,
  getPoolStats: () => database.poolStats(),
  getServerTimeouts: () => appliedTimeouts,
}));

// 请求体上限(审查修复 20261021 P2):原写法未设 limit,单个请求可塞任意大 JSON 在解析阶段就打满内存,
// 超限由 body-parser 抛 entity.too.large 并由下方终态错误中间件统一回 413 JSON 信封,
app.use(bodyParser.urlencoded({ extended: false, limit: config.app.bodyLimit }));
app.use(bodyParser.json({ limit: config.app.bodyLimit }));
app.use((req, res, next) => requestContext.runWithResponse(res, req.reqId, next));
// 响应信封归一:必须在 body 解析之后、任何路由之前挂载,
// 把历史手写 `json({ error })` / 缺 code 的响应体统一补齐为 `{code, message, ...}`(审查修复 20261021 P1-5),
app.use(public.normalizeEnvelope);

app.use(cors({
  origin: config.app.corsOrigin,
  // 本系统不靠 Cookie 鉴权(身份完全在 Authorization 头里的 JWT),前端已去掉 withCredentials 20261021 审查修复 P2,
  // credentials 保持 true 仅为兼容可能的存量调用方:浏览器规则要求 credentials:true 时 Origin 不得为 *,
  // 因此 CORS_ORIGIN 必须始终为显式列表(config.js 已对 '*' 软告警),后续要收紧可直接改 false 而无需动前端,
  credentials: true
}));

// 请求日志中间件:记录方法/路径/状态码/耗时,带时间戳且脱敏查询串(实现见 httpDefaults.js) 20260915 新增,20261021 P2 改造,
app.use(httpDefaults.requestLog);

// 解析token获取用户信息:仅负责将有效token负载注入 req.data 并校验活跃登录态;
// 验签失败/过期/格式非法由认证层直接闭环 401,不再静默放行依赖下方认证闸门兑底 20260917 收口,
// 免认证路径直接放行:登录请求可能携带旧token(localStorage残留),不应被认证层误拒 20260917 修复,
// 菜单接口仍须解析token注入 req.data(按用户权限过滤菜单),不在豁免之列 20260917 修复,
app.use(async function (req, res, next) {
  if (req.path === '/' || req.path === '/api/login') {
    return next();
  }
  var token = req.headers['authorization'];
  if (token == undefined) {
    return next();
  }
  // header 格式非法(非 "Bearer <token>")时直接拒绝 20260917 收口,
  if (typeof token !== 'string' || !/^Bearer \S+$/.test(token.trim())) {
    return public.respondUnauthorized(res);
  }
  try {
    const data = await vertoken.verToken(token);
    req.data = data;
  } catch (error) {
    // 验签失败/token过期由认证层直接闭环,不再依赖下方认证闸门兜底 20260917 收口,
    return public.respondUnauthorized(res);
  }
  // 租户库名闸门(审查修复 20261021 二轮 P0-1):下游 240+ 处 `${req.data.dataBase}.表名` 拼串此前只有 3 处做过
  // 标识符断言,“库名不可能是注入载体”完全建在“密钥不外泄”上;现在唯一入口处收口,
  // 不合法库名一律按身份失效处理:既防伪造 token 注入,也防手工签发的 token 指到别家租户的库,
  if (!tenant.isAllowed(req.data.dataBase)) {
    console.warn('tenant 401:', req.reqId, 'invalid_dataBase', req.method, public.maskRequestTarget(req.originalUrl));
    return public.respondUnauthorized(res);
  }
  // 校验活跃登录态:DB 查询失败按服务错误处理,避免误报为 token 失效 20260917 登录态DB化,
  try {
    const active = await loginState.hasActiveLogin(req.data.phone, req.data.exp);
    // 不存在活跃登录态(重新登录/登出后旧token)则结束
    if (!active) {
      return public.respondUnauthorized(res);
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }
  return next();
});
// 认证闸门:上方中间件已对携带 token 的请求做了唯一一次验签(算法在 token.js 固定为 HS256)并注入 req.data,
// 本处只确认受保护请求都带着有效身份,不再用 express-jwt 对同一 token 二次验签 20261021 审查修复 低,
// 免认证口径与原 express-jwt unless 一致:根路径/登录/菜单接口(菜单靠已解析身份过滤,未带 token 时走匿名分支),
const AUTH_EXEMPT_PATHS = ['/', '/api/login', '/api/get-menu-list-i18n'];
app.use(function (req, res, next) {
  if (AUTH_EXEMPT_PATHS.includes(req.path)) {
    return next();
  }
  if (!req.data) {
    console.warn('auth 401:', req.reqId, 'no_valid_identity', req.method, public.maskRequestTarget(req.originalUrl));
    return public.respondUnauthorized(res);
  }
  return next();
});
  //兜底错误处理:下游中间件/路由抛出的 401 统一转 token 失效提示,其余继续下传,
  app.use(function(err, req, res, next) {

  if (err.status == 401) {
    console.warn('auth 401:', req.reqId, err.code || 'unauthorized', req.method, public.maskRequestTarget(req.originalUrl));
    return public.respondUnauthorized(res);
  }

  console.error('Unhandled middleware error:', req.reqId, err);
  return next(err);
  });

// 区域作用域守卫:紧接鉴权之后、各业务路由之前,越权 region 直接 403 并将名单挂到 req.operatorRegions;
// 登录/设备/菜单等无 req.data 或无区域参数的路径不受影响(无名单即不注入不拦截) 20261010 新增,
app.use(rbac.requireRegionScope);

// 业务接口挂载:守卫(区域归属/菜单权限/仅平台管理员)与路由均由声明式注册表驱动,
// 挂载前会先跑一轮注册表体检(auditRouteRegistry),任何接口未登记守卫则直接抛错拒绝启动,
// 原先这里需要同时维护“守卫挂载表”与“路由挂载表”两张清单且靠注释保证守卫先注册 20261021 审查修复 P1-4,
// 区域归属口径(详情读/修改/软删按主键直取直写时校验记录所属区域)已随各条目声明,
// 名单为空(平台管理员/未配区域)或参数缺失时直接放行,不影响存量调用 20261021 审查修复④,
routeRegistry.mountApiRoutes(app);

app.use(httpDefaults.notFound);

// 终态错误中间件:统一回 JSON 信封并把堆栈留在日志(实现见 httpDefaults.js),
app.use(httpDefaults.finalError);
// 传输层超时(审查修复 20261021 二轮 P2-23):本服务此前完全没设 HTTP 超时,一个只发头不发体的
// 慢连接可以按 Node 默认值占住 socket 五分钟;阈值均走配置(置 0 即不改行为),口径与回读见 httpDefaults.js,

//启动服务器
// 生产环境敏感配置缺失时拒绝启动 20260917 收口,
if (config.securityFatal.length > 0) {
  config.securityFatal.forEach((message) => console.error('[security] Fatal:', message));
  process.exit(1);
}

// 启动前幂等建表:确保登录态表 login_session 存在,线上老库缺表曾导致登录 500 20260917 修复,
// tenant.ensureLoaded:首次拉取已登记租户库名单(拉不到不致命,闸门会降级为仅形态白名单),
let server = null;
// applyServerTimeouts 的回读值(启动后才能拿到,初始为 null):/health 会把它透出供运维核对生效值,
let appliedTimeouts = null;
Promise.all([loginState.ensureTable(), device.ensureTable(), tenant.ensureLoaded()]).then(() => {
  server = app.listen(config.app.port, () => {
    appliedTimeouts = httpDefaults.applyServerTimeouts(server);
    console.log(`Server is running on port ${config.app.port}`);
    // 租户库名单周期刷新(5 分钟),新建租户无需重启, 20261021 审查修复二轮 P0-1,
    tenant.startAutoRefresh();
    // 敏感配置默认值告警:生产环境务必通过环境变量覆盖 20260917 新增,
    config.securityWarnings.forEach((warning) => console.warn('[security]', warning));
  });
}).catch((error) => {
  console.error('[startup] 启动前置检查(建表/租户名单)失败,拒绝启动:', error.message);
  process.exit(1);
});

// 优雅停机(审查修复 20261021 P2):原写法收到 SIGTERM/SIGINT 直接退出,连接池 pool.end() 从未被调用,
// 在途的多语句事务(管理费链、批量建位)被硬切,容器重启/滚动发布时表现为偶发半提交数据;
// 现先停止接收新连接并排空在途请求,再关池;超时未到则强制退出,避免 keep-alive 长连把进程吊死,
function shutdown(signal) {
  console.log(`[${new Date().toISOString()}] ${signal} received, shutting down...`);
  const force = setTimeout(() => {
    console.error('[shutdown] 超出优雅停机窗口,强制退出');
    process.exit(1);
  }, config.app.shutdownTimeoutMs);
  // unref 使正常排空后不会被这个定时器拖住退出,
  force.unref();

  if (!server) {
    clearTimeout(force);
    process.exit(0);
    return;
  }

  server.close(async () => {
    clearTimeout(force);
    try {
      await database.end();
    } catch (error) {
      console.error('[shutdown] 连接池关闭失败:', error.message);
    }
    process.exit(0);
  });
  // 先掉空闲 keep-alive 连接,否则 server.close 会等它们自然超时,
  if (typeof server.closeIdleConnections === 'function') {
    server.closeIdleConnections();
  }
}

['SIGTERM', 'SIGINT'].forEach((signal) => process.once(signal, () => shutdown(signal)));



