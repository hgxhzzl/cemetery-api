// HTTP 层通用中间件用例(审查修复 20261021 P2):安全头、404 兜底、终态错误信封,
// 这三处原先都写在 index.js 里无法被测试加载(会连库并 process.exit),故抽到 httpDefaults.js,
const test = require('node:test');
const assert = require('node:assert');
const zlib = require('zlib');
const express = require('express');
const bodyParser = require('body-parser');
const config = require('../config');
const httpDefaults = require('../httpDefaults');

function createApp(setup) {
  const app = express();
  app.use(httpDefaults.attachRequestId);
  app.use(httpDefaults.securityHeaders);
  app.use(httpDefaults.requestLog);
  setup(app);
  app.use(httpDefaults.notFound);
  app.use(httpDefaults.finalError);
  return app;
}

async function withServer(app, run) {
  const server = app.listen(0);
  try {
    return await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}

test('httpDefaults: 所有响应(含 404/500)都带安全响应头', async () => {
  const app = createApp((router) => {
    router.get('/api/ok', (req, res) => res.json({ code: 0, message: 'ok' }));
    router.get('/api/boom', () => {
      throw new Error('意外的底层异常 with /api/boom');
    });
  });

  await withServer(app, async (base) => {
    for (const path of ['/api/ok', '/api/missing', '/api/boom']) {
      const response = await fetch(`${base}${path}`);
      assert.strictEqual(response.headers.get('x-content-type-options'), 'nosniff', `${path} 缺少 nosniff`);
      assert.strictEqual(response.headers.get('x-frame-options'), 'DENY', `${path} 缺少 X-Frame-Options`);
      assert.strictEqual(response.headers.get('referrer-policy'), 'no-referrer', `${path} 缺少 Referrer-Policy`);
      assert.strictEqual(response.headers.get('cache-control'), 'no-store', `${path} 缺少 no-store`);
      assert.match(response.headers.get('content-security-policy') || '', /default-src 'none'/, `${path} 缺少 CSP`);
    }
  });
});

test('httpDefaults: 未登记接口返回 JSON 信封而非 HTML 404 页', async () => {
  const app = createApp(() => {});

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/api/not-registered`);
    assert.strictEqual(response.status, 404);
    assert.match(response.headers.get('content-type') || '', /application\/json/);
    const body = await response.json();
    assert.strictEqual(body.code, 404);
    assert.match(body.message, /接口不存在: GET \/api\/not-registered/);
  });
});

test('httpDefaults: 异常统一回 JSON 信封且不把堆栈写进响应体', async () => {
  const app = createApp((router) => {
    router.use('/api/json', bodyParser.json({ limit: config.app.bodyLimit }), (req, res) => {
      res.json({ code: 0, message: 'ok' });
    });
    router.get('/api/boom', () => {
      throw new Error('底层堆栈 SecretInnerPath');
    });
    router.get('/api/throw401', () => {
      const error = new Error('token 失效');
      error.status = 401;
      throw error;
    });
  });

  await withServer(app, async (base) => {
    // 非法 JSON:body-parser 抛 SyntaxError,应回 400 信封而非默认 HTML 错误页,
    const badJson = await fetch(`${base}/api/json`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{oops' });
    assert.strictEqual(badJson.status, 400);
    assert.match((await badJson.json()).message, /请求体不是合法的 JSON/);

    // 超限请求体:应回 413 并提示上限,
    const tooLarge = await fetch(`${base}/api/json`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pad: 'x'.repeat(1024 * 1024) }),
    });
    assert.strictEqual(tooLarge.status, 413);
    assert.match((await tooLarge.json()).message, new RegExp(`超过上限 ${config.app.bodyLimit}`));

    // 未分类异常:只回笼统文案,原始 message(可能含内部路径)不得出现在响应体,
    const boom = await fetch(`${base}/api/boom`);
    assert.strictEqual(boom.status, 500);
    const boomBody = await boom.json();
    assert.strictEqual(boomBody.message, '服务器内部错误');
    assert.doesNotMatch(JSON.stringify(boomBody), /SecretInnerPath|at .*\.js/);

    // 401 仍走统一 token 失效文案,
    const unauthorized = await fetch(`${base}/api/throw401`);
    assert.strictEqual(unauthorized.status, 401);
    assert.match((await unauthorized.json()).message, /token/);
  });
});

// gzip 中间件单独搭一个应用验证(审查修复 20261021 二轮 P2-13):不并入上面的 createApp,
// 以免缓冲改写 res.end 后影响安全头/错误信封那几条既有用例的原有断言口径, 20261021 新增,
function createGzipApp(setup) {
  const app = express();
  app.use(httpDefaults.securityHeaders);
  app.use(httpDefaults.gzipJson);
  setup(app);
  app.use(httpDefaults.notFound);
  app.use(httpDefaults.finalError);
  return app;
}

// node fetch 会自动解开 gzip,因此 gzip 相关断言一律走原始客户端,才能看到未经改写的响应头与字节, 20261021 新增,
function rawRequest(options, onResponse) {
  return new Promise((resolve, reject) => {
    const http = require('http');
    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ res, raw: Buffer.concat(chunks), text: onResponse(res, Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// 构造一份能稳定压出收益的列表响应(重复性文本),体积必须超过阈值才能触发压缩, 20261021 新增,
function buildBigPayload() {
  const remark = '福东墓区 一园区 张三 13800138000 ';
  return {
    code: 0,
    data: {
      total: 200,
      list: Array.from({ length: 200 }, (item, index) => ({ idRoom: index, xyNumber: `${index}`, buyer: '张三', remark })),
    },
  };
}

test('httpDefaults: 达到阈值的 JSON 响应以 gzip 下发且内容可逐字还原', async () => {
  const payload = buildBigPayload();
  const rawJson = JSON.stringify(payload);
  const app = createGzipApp((router) => {
    router.get('/api/big', (req, res) => res.json(payload));
    router.get('/api/small', (req, res) => res.json({ code: 0, message: 'ok' }));
  });

  const server = app.listen(0);
  try {
    const port = server.address().port;
    const compressed = await rawRequest({ port, path: '/api/big', headers: { 'Accept-Encoding': 'gzip' } }, (res, body) =>
      res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(body).toString('utf8') : body.toString('utf8'),
    );
    assert.strictEqual(compressed.res.statusCode, 200);
    assert.strictEqual(compressed.res.headers['content-encoding'], 'gzip', '大响应应被压缩');
    assert.strictEqual(compressed.res.headers.vary, 'Accept-Encoding', 'Vary 必须无条件带上');
    assert.strictEqual(compressed.text, rawJson, '解压后应逐字等于原响应体');
    assert.ok(Number(compressed.res.headers['content-length']) < Buffer.byteLength(rawJson), '下发的 Content-Length 应是压缩后长度');
    assert.ok(Buffer.compare(compressed.raw, Buffer.from(rawJson)) !== 0, '线上字节不应仍是未压缩原文');

    // 小于阈值的短响应不压:多一次 CPU 与首字节延迟却省不了多少带宽,
    const small = await rawRequest({ port, path: '/api/small', headers: { 'Accept-Encoding': 'gzip' } }, (res, body) => body.toString('utf8'));
    assert.ok(!small.res.headers['content-encoding'], '短响应不应被压缩');
    assert.strictEqual(JSON.parse(small.text).message, 'ok');
    assert.strictEqual(small.res.headers.vary, 'Accept-Encoding', '未压缩时同样要声明内容随请求头协商');

    // 客户端未声明支持 gzip 时原样发出,否则老代理/老客户端拿到解不开的二进制,
    const identity = await rawRequest({ port, path: '/api/big', headers: { 'Accept-Encoding': 'identity' } }, (res, body) => body.toString('utf8'));
    assert.ok(!identity.res.headers['content-encoding'], '不支持 gzip 的客户端应拿到原文');
    assert.strictEqual(identity.text, rawJson);
  } finally {
    server.close();
  }
});

test('httpDefaults: 压缩不影响 404 兜底与终态错误信封的可读性', async () => {
  const app = createGzipApp((router) => {
    router.get('/api/boom', () => {
      throw new Error('底层堆栈 SecretInnerPath');
    });
  });

  await withServer(app, async (base) => {
    // 带 Accept-Encoding 也不能把错误信封弄成解不开的内容(非 2xx 一律不压,保证排障时 curl 直读),
    const missing = await fetch(`${base}/api/not-registered`, { headers: { 'Accept-Encoding': 'gzip' } });
    assert.strictEqual(missing.status, 404);
    assert.strictEqual(missing.headers.get('content-encoding'), null, '404 响应不压缩');
    assert.match((await missing.json()).message, /接口不存在/);

    const boom = await fetch(`${base}/api/boom`, { headers: { 'Accept-Encoding': 'br' } });
    assert.strictEqual(boom.status, 500);
    assert.strictEqual((await boom.json()).message, '服务器内部错误');
  });
});

test('httpDefaults: 请求日志按敏感字段脱敏后再输出', async () => {
  const app = createApp((router) => {
    router.get('/api/logged', (req, res) => res.json({ code: 0, message: 'ok' }));
  });
  const logged = [];
  const original = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/logged?phone=13800138000&accountName=%E5%BC%A0%E4%B8%89&page=1`);
      assert.strictEqual(response.status, 200);
    });
  } finally {
    console.log = original;
  }

  assert.strictEqual(logged.length, 1, '一次请求应输出一条访问日志');
  const line = logged[0];
  assert.match(line, /\[\d{4}-\d{2}-\d{2}T/, '日志应带 ISO 时间戳');
  assert.doesNotMatch(line, /13800138000/, '手机号不得原样进日志');
  assert.match(line, /phone=138\*\*\*\*8000/);
  assert.doesNotMatch(line, /accountName=张三|accountName=%E5%BC%A0%E4%B8%89/, '账户名不得进日志');
  assert.match(line, /accountName=\*\*\*&page=1/);
});

// 请求关联号(审查修复 20261021 二轮 P2-16):日志行首的 [reqId] 是把访问日志/401/慢语句串成
// 同一时间线的唯一线索,且会回写 X-Request-Id 供前端报障直接引用;入站号必须清洗而不能原样落日志,
// 否则一个带换行的头就能伪造出一整行看似正常的日志(日志注入),因此这里走单元口径而不走 fetch
// (undici 会先拦下非法头,反而测不到服务端的清洗逻辑),
test('httpDefaults: attachRequestId 沿用合法入站号、清洗非法号并回写响应头', () => {
  function run(headers) {
    const written = [];
    const res = { setHeader: (name, value) => written.push([name, value]) };
    const req = { headers };
    let nextCalled = false;
    httpDefaults.attachRequestId(req, res, () => { nextCalled = true; });
    assert.ok(nextCalled, '关联号中间件不得中断请求链');
    assert.deepStrictEqual(written, [['X-Request-Id', req.reqId]], '应把最终采用的号回写响应头');
    return req.reqId;
  }

  const generated = run({});
  assert.match(generated, /^[\w.-]{1,64}$/, `无入站号时应生成合法形态的号,实际:${generated}`);
  assert.notStrictEqual(generated, run({}), '连续两个请求不得共用同一个号');
  assert.strictEqual(run({ 'x-request-id': 'trace-abc_123' }), 'trace-abc_123', '合法入站号应原样沿用(与前端同一线索对齐)');

  const hostile = `bad id\n[2026-01-01T00:00:00Z][warn] fake`; 
  assert.notStrictEqual(run({ 'x-request-id': hostile }), hostile, '含换行/空格的号不得原样进日志');
  assert.match(run({ 'x-request-id': hostile }), /^[\w.-]{1,64}$/);
  assert.ok(run({ 'x-request-id': 'x'.repeat(200) }).length <= 64, '超长号应被整条替换而不是截断保留');
});

test('httpDefaults: 访问日志与 4xx 告警行首都带同一个请求关联号', async () => {
  const app = createApp(() => {});
  const lines = [];
  const originalLog = console.log;
  const originalWarn = console.warn;
  console.log = (...args) => lines.push(args.join(' '));
  console.warn = (...args) => lines.push(args.join(' '));
  try {
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/api/not-registered`, { headers: { 'X-Request-Id': 'trace-404' } });
      assert.strictEqual(response.status, 404);
      assert.strictEqual(response.headers.get('x-request-id'), 'trace-404', '响应头应回显采用的关联号');
    });
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
  }

  const withId = lines.filter((line) => line.includes('[trace-404]'));
  assert.strictEqual(withId.length, 1, `404 请求应输出一条带关联号的日志,实际共 ${lines.length} 行:${lines.join(' | ')}`);
  assert.match(withId[0], /\[warn\] \[trace-404\] GET \/api\/not-registered 404/, '行首应是「[warn] [关联号]」而非把号摆在时间戳前单独一处');
});

// 传输层超时(审查修复 20261021 二轮 P2-23):阈值全部走配置且置 0 时不改行为(便于线上不改代码回退),
// 同时钉住生产配置确实把三项收到远小于 Node 默认值的量级——否则一旦有人清空 .env,本条修复会无声退回生效前,
test('httpDefaults: applyServerTimeouts 按配置收紧连接超时且 0 值不改行为', async () => {
  const http = require('http');
  const server = http.createServer((req, res) => res.end('ok'));
  await new Promise((resolve) => server.listen(0, resolve));
  // 任何一项被改之前先取一次快照:这三值就是当前 Node 的默认值,不写死数字以免升级 Node 后断言失真,
  const nodeDefaults = { requestTimeout: server.requestTimeout, headersTimeout: server.headersTimeout, keepAliveTimeout: server.keepAliveTimeout };
  try {
    const untouched = httpDefaults.applyServerTimeouts(server, { requestTimeoutMs: 0, headersTimeoutMs: 0, keepAliveTimeoutMs: 0 });
    assert.deepStrictEqual(untouched, nodeDefaults, '阈值置 0 时不应改动服务默认超时');

    const applied = httpDefaults.applyServerTimeouts(server, { requestTimeoutMs: 45000, headersTimeoutMs: 12000, keepAliveTimeoutMs: 4000 });
    assert.deepStrictEqual(applied, { requestTimeout: 45000, headersTimeout: 12000, keepAliveTimeout: 4000 });
    assert.strictEqual(httpDefaults.applyServerTimeouts(null), null, '未拿到 server 时应安全返回而不是抛错');
  } finally {
    server.close();
  }

  assert.ok(config.app.requestTimeoutMs > 0 && config.app.requestTimeoutMs < nodeDefaults.requestTimeout, `requestTimeoutMs=${config.app.requestTimeoutMs} 未严于 Node 默认值 ${nodeDefaults.requestTimeout}`);
  assert.ok(config.app.headersTimeoutMs > 0 && config.app.headersTimeoutMs < config.app.requestTimeoutMs, 'headersTimeout 应小于 requestTimeout(Node 要求如此才会生效)');
  assert.ok(config.app.keepAliveTimeoutMs > 0, 'keepAliveTimeout 必须显式设置');
  assert.ok(config.app.slowRequestMs > 0, '慢请求告警阈值必须显式设置,否则 [slow-request] 分支永不进入');
});

// 健康探针(审查修复 20261021 三轮 P2-6):免鉴权、响应不套业务 {code} 信封,供 nginx/监控直接按 HTTP 200 探活;
// 池占用与超时值均由注入提供,取不到池计数(mock 池)时应标注 unavailable 而不是省略(否则会被监控误读为 0),
test('httpDefaults: GET /health 回 200 并透出存活/版本/池占用/超时生效值', async () => {
  const app = createApp((router) => {
    router.get('/health', httpDefaults.createHealthHandler({
      version: 'cemetery-api@test',
      getPoolStats: () => ({ total: 5, idle: 3, borrowed: 2, waiting: 1 }),
      getServerTimeouts: () => ({ requestTimeout: 45000, headersTimeout: 12000, keepAliveTimeout: 4000 }),
    }));
    router.get('/health-nopool', httpDefaults.createHealthHandler({ version: 'x' }));
  });

  await withServer(app, async (base) => {
    const response = await fetch(`${base}/health`);
    assert.strictEqual(response.status, 200);
    const body = await response.json();
    assert.strictEqual(body.status, 'ok');
    assert.strictEqual(body.version, 'cemetery-api@test');
    assert.strictEqual(typeof body.uptimeSeconds, 'number');
    assert.deepStrictEqual(body.pool, { total: 5, idle: 3, borrowed: 2, waiting: 1 });
    assert.deepStrictEqual(body.timeouts, { requestTimeout: 45000, headersTimeout: 12000, keepAliveTimeout: 4000 });
    assert.ok(!('code' in body), 'health 响应不应被业务 {code} 信封包裹');

    const nopool = await (await fetch(`${base}/health-nopool`)).json();
    assert.deepStrictEqual(nopool.pool, { unavailable: true }, '取不到池计数时应显式标注 unavailable');
    assert.strictEqual(nopool.version, 'x');
  });
});
