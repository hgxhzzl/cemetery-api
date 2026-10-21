// HTTP 层通用中间件用例(审查修复 20261021 P2):安全头、404 兜底、终态错误信封,
// 这三处原先都写在 index.js 里无法被测试加载(会连库并 process.exit),故抽到 httpDefaults.js,
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bodyParser = require('body-parser');
const config = require('../config');
const httpDefaults = require('../httpDefaults');

function createApp(setup) {
  const app = express();
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
