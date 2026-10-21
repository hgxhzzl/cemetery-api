// HTTP 层通用中间件(审查修复 20261021 P2):安全响应头、404 兜底、终态错误信封三件事与业务无关,
// 从 index.js 抽到本文件便于单测覆盖(index.js 会连库并 process.exit,不能被测试直接加载),
const config = require('./config');
const public = require('./public');

// 轻量安全响应头:纯 JSON 接口不为此新增 helmet 依赖,只按本服务实际需要设四类,
// nosniff 阻止浏览器把响应误判为可执行内容;DENY/frame-ancestors 关掉被嵌套点击劫持;
// no-store 避免带业务数据的响应被代理/共享缓存留副本;CSP 收紧到 default-src 'none'(本服务只输出 JSON),
// 必须由 index.js 挂在最前:请求体解析失败/404/500 等短路路径同样要带头,
function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  return next();
}

// 404 兜底:未匹配任何已登记接口的请求原先落到 Express 默认的 HTML 404 页面,
// 前端 res.json() 解析失败后只能提示“未知错误”,排障时看不到到底是哪个路径没注册,
// 现统一回 JSON 信封;必须挂在全部业务路由之后,否则会把正常接口吞掉,
function notFound(req, res) {
  return public.respondError(res, 404, `接口不存在: ${req.method} ${req.path}`);
}

// 终态错误中间件:此前只有一层把 401 转信封的错误中间件,其余错误一律 next(err) 交给 Express 默认处理器,
// 输出带堆栈的 HTML 页面(前端解析不了,还可能泄露内部路径与依赖版本);
// 现按可识别的载荷错误分类回 JSON 信封,完整堆栈只进日志不出响应,
function finalError(err, req, res, next) {
  if (res.headersSent) {
    return next(err);
  }
  console.error(`[${new Date().toISOString()}][error] ${req.method} ${public.maskRequestTarget(req.originalUrl)}`, err.stack || err.message);

  // body-parser 的 JSON 解析失败以 SyntaxError 抛出并带 body 字段,
  if (err instanceof SyntaxError && 'body' in err) {
    return public.respondError(res, 400, '请求体不是合法的 JSON');
  }
  if (err.type === 'entity.too.large') {
    return public.respondError(res, 413, `请求体超过上限 ${config.app.bodyLimit},请分批提交`);
  }
  if (err.status === 401) {
    return public.respondUnauthorized(res);
  }
  return public.respondError(res, 500, '服务器内部错误');
}

// 请求日志(20260915 新增,审查修复 20261021 P2 改造):原行直接打 req.originalUrl 且无时间戳,
// 一是无法与 DB 慢日志对齐时间线,二是查询串里的手机号/账户名会原样落盘(本系统登录名就是手机号),
// 现走 public.maskRequestTarget 脱敏,并把 4xx/5xx 升为 warn 便于只看错误行排查,
function requestLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const line = `${req.method} ${public.maskRequestTarget(req.originalUrl)} ${res.statusCode} ${Date.now() - start}ms`;
    if (res.statusCode >= 400) {
      console.warn(`[${new Date().toISOString()}][warn] ${line}`);
      return;
    }
    console.log(`[${new Date().toISOString()}] ${line}`);
  });
  return next();
}

module.exports = { securityHeaders, requestLog, notFound, finalError };
