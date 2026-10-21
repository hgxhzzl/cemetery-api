// HTTP 层通用中间件(审查修复 20261021 P2):安全响应头、404 兜底、终态错误信封三件事与业务无关,
// 从 index.js 抽到本文件便于单测覆盖(index.js 会连库并 process.exit,不能被测试直接加载),
const zlib = require('zlib');
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

// gzip 压缩(审查修复 20261021 二轮 P2-13):墓位/业务列表一页整行 JSON 动辄数百 KB,全站此前无任何压缩,
// 局域网之外的访问链路会把这段体积原样摊到每次翻页上;本服务不为此新增 compression 依赖,直接用 node 自带 zlib,
// 口径:客户端声明支持 gzip + 响应为 JSON/文本 + 2xx + 体积达到阈值(默认 1KB)才压,
// 小于阈值或未声明支持的请求原样发出(多一次压缩反而增加 CPU 与首字节延迟),
// 实现上缓冲 res.write/res.end 到内存后一次性压完再设 Content-Encoding/Content-Length,
// 因此只适用于本服务这种“一次 json() 出完整个响应”的接口,不适合大文件流式下载,
const compressibleContentTypePattern = /^(application\/(json|javascript|xml)|text\/)/i;

function gzipJson(req, res, next) {
  const minBytes = Number(config.app.gzipMinBytes) || 0;
  // Vary 无条件设置:不加的话共享缓存可能把压缩响应回给不支持 gzip 的客户端(本服务已 no-store,此处属防御性写法),
  res.setHeader('Vary', 'Accept-Encoding');
  // HEAD 没有响应体,压了也没意义;gzipMinBytes 置 0 视为关闭压缩,
  if (minBytes <= 0 || req.method === 'HEAD' || !/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) {
    return next();
  }

  const buffers = [];
  const rawWrite = res.write.bind(res);
  const rawEnd = res.end.bind(res);
  let ended = false;

  function collect(chunk, encoding) {
    if (chunk === undefined || chunk === null) {
      return;
    }
    buffers.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), encoding || 'utf8'));
  }

  // body-parser/Express 会传 (chunk, encoding, callback) 的各种组合,回调一律补触发,否则上游流控会被吊死,
  res.write = function (chunk, encoding, callback) {
    collect(chunk, typeof encoding === 'function' ? undefined : encoding);
    const done = typeof encoding === 'function' ? encoding : callback;
    if (typeof done === 'function') {
      done();
    }
    return true;
  };

  res.end = function (chunk, encoding, callback) {
    if (ended) {
      return res;
    }
    ended = true;
    collect(chunk, typeof encoding === 'function' ? undefined : encoding);
    const done = typeof encoding === 'function' ? encoding : callback;
    const body = Buffer.concat(buffers);
    const contentType = String(res.getHeader('Content-Type') || '');
    const statusCode = res.statusCode;

    // 非 2xx/非文本/体积不足一律原样发出:错误页与空响应不必压,二进制(未来的导出流)更不能误压,
    if (statusCode < 200 || statusCode >= 300 || body.length < minBytes || !compressibleContentTypePattern.test(contentType)) {
      res.setHeader('Content-Length', body.length);
      return rawEnd(body, done);
    }

    zlib.gzip(body, { level: zlib.constants.Z_DEFAULT_COMPRESSION }, (error, zipped) => {
      // 压缩失败或压完反而更大(高熵短响应):必须退回原样输出,绝不能让中间件把响应吞掉,
      if (error || !zipped || zipped.length >= body.length) {
        res.setHeader('Content-Length', body.length);
        rawEnd(body, done);
        return;
      }
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Length', zipped.length);
      rawEnd(zipped, done);
    });
    return res;
  };

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
  console.error(`[${new Date().toISOString()}][error][${requestIdOf(req)}] ${req.method} ${public.maskRequestTarget(req.originalUrl)}`, err.stack || err.message);

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
// 行首先带请求号并补慢请求告警(审查修复 20261021 二轮 P2-16 / P2-23):同一次页面加载的多条日志行
// 原先只能靠毫秒时间戳猜归属;超过 SLOW_REQUEST_MS 的 200 也单独记一条 warn,
// 本层无权中断已发出的语句(那需要库侧 MAX_EXECUTION_TIME),故只告警不断流,与慢语句日志构成两层时间线,
const SLOW_REQUEST_MS = Number(config.app.slowRequestMs) || 0;

function requestLog(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const cost = Date.now() - start;
    const line = `[${requestIdOf(req)}] ${req.method} ${public.maskRequestTarget(req.originalUrl)} ${res.statusCode} ${cost}ms`;
    if (res.statusCode >= 400) {
      console.warn(`[${new Date().toISOString()}][warn] ${line}`);
      return;
    }
    if (SLOW_REQUEST_MS > 0 && cost >= SLOW_REQUEST_MS) {
      console.warn(`[${new Date().toISOString()}][warn][slow-request] ${line}`);
      return;
    }
    console.log(`[${new Date().toISOString()}] ${line}`);
  });
  return next();
}

// 请求关联号(审查修复 20261021 二轮 P2-16):逐请求发一个短号并回写 X-Request-Id,
// 前端报障时可直接引用该号定位后端全部日志;网关已带号时沿用(把上下游日志接起来),
// 但对外部传入值限定字符集与长度,防止伪造控制字符把脏行写进日志,
let requestSeq = 0;

function createRequestId() {
  requestSeq = (requestSeq + 1) % 1296;
  return `${Date.now().toString(36)}${requestSeq.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

function attachRequestId(req, res, next) {
  const incoming = String(req.headers['x-request-id'] || '');
  req.reqId = /^[\w.-]{1,64}$/.test(incoming) ? incoming : createRequestId();
  res.setHeader('X-Request-Id', req.reqId);
  return next();
}

// 取请求号:非请求上下文(启动/定时任务/未经 attach 的内部调用)统一回 '-',避免日志行形状不一致,
function requestIdOf(req) {
  return (req && req.reqId) || '-';
}

// 传输层超时(审查修复 20261021 二轮 P2-23):本服务此前完全没设 HTTP 超时,Node 默认
// requestTimeout=300s、headersTimeout=60s:一个只发头不发体(或发一半)的慢连接可以占住 socket 五分钟
// (与 Slowloris 同形),而本系统最慢的正常请求也只是批量建位那类,
// 口径:只收紧连接层超时,不做响应级 504——本层无权中断已发出的语句(那需要库侧 MAX_EXECUTION_TIME),
// 且给在途请求定时回 504 会撞上 write-after-end;超阈值的正常慢请求靠 requestLog 的 [slow-request] 告警形成第二层时间线,
// 任一阈值置 0 即沿用 Node 默认值(等于不改行为),便于线上不改代码快速回退,
// 本函数留在本文件而非 index.js:index.js 会连库并 process.exit,无法被用例加载,
function applyServerTimeouts(httpServer, limits = config.app) {
  if (!httpServer) {
    return null;
  }
  if (Number(limits.requestTimeoutMs) > 0) {
    httpServer.requestTimeout = Number(limits.requestTimeoutMs);
  }
  if (Number(limits.headersTimeoutMs) > 0) {
    httpServer.headersTimeout = Number(limits.headersTimeoutMs);
  }
  if (Number(limits.keepAliveTimeoutMs) > 0) {
    httpServer.keepAliveTimeout = Number(limits.keepAliveTimeoutMs);
  }
  // 回读服务上的实际生效值(而不是入参),便于用例断言“未配置那一项仍保持 Node 默认”,
  return {
    requestTimeout: httpServer.requestTimeout,
    headersTimeout: httpServer.headersTimeout,
    keepAliveTimeout: httpServer.keepAliveTimeout,
  };
}

module.exports = { securityHeaders, gzipJson, requestLog, notFound, finalError, attachRequestId, requestIdOf, applyServerTimeouts };
