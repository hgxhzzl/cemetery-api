// 响应信封:成功/列表/详情/事务/影响行数回包,错误体归一中间件与 401/4xx 统一出口(由 public.js 拆出,审查修复 20261021 P1-7)。
// 对外口径不变:public.js 门面仍再导出本模块全部成员,调用点无需改动。

exports.handleQueryError = function (res, error) {
  console.error('Database query error:', error);
  if (!res.headersSent) {
    // 走统一失败信封而不用裸 { error }(审查修复 20261021 二轮 P2-12):信封层自己不能再留手写体,
    // 否则 lib/ 里同时存在两套响应形状,输出字段与旧写法逐字一致(code 取 500、message 同文案),
    exports.respondError(res, 500, 'Internal server error');
  }

  return res;
}

exports.respondList = function (res, list) {
  return res.json({ code: 0, message: '查询成功', data: { list } });
}

exports.respondDetail = function (res, list) {
  if (!Array.isArray(list) || list.length === 0) {
    return exports.respondError(res, 404, '数据不存在!');
  }

  return res.json({ code: 0, message: '查询成功', data: { list } });
}

// 统一失败信封(审查修复 20261021 P1-5):旧写法各处手写 `res.status(4xx).json({ error })`,
// 前端只看 code/message 的路径拿不到可读文案;新信封同时下发 message 与兼容位 error(同值),
// 使新旧前端都能透出具体拒绝原因,
exports.respondError = function (res, status, message, extra = {}) {
  const text = String(message || '操作失败!');
  return res.status(status || 500).json({ code: status || 500, message: text, error: text, ...extra });
}

// 信封归一中间件:全站 100+ 处历史 `json({ error })` / `json({ code })` 写法不在本批逐个迁移,
// 集中在此补齐缺失的 code/message 字段(code 缺省取 HTTP 状态码、message 缺省取 error 文案),
// 保证任何响应都是 `{code, message, data?}` 形状(审查修复 20261021 P1-5),
exports.normalizeEnvelope = function (req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const errorText = typeof body.error === 'string' ? body.error : '';
      if (body.code === undefined) {
        body.code = res.statusCode === 200 ? 0 : res.statusCode;
      }
      if (body.message === undefined) {
        body.message = errorText || (Number(body.code) === 0 ? '操作成功' : '操作失败!');
      }
      if (!errorText && Number(body.code) !== 0) {
        // 失败体反向补上 error 字段,旧前端的 extractServerError 只看 error 也能拿到文案,
        body.error = body.message;
      }
    }
    return originalJson(body);
  };
  return next();
}

// token 失效统一 401 信封(审查修复 20261021 P1-5):原 `res.status(401).send(纯文本)` 使前端
// 无法从响应体取到可读 message,只能靠全局拦截器写死提示,
exports.respondUnauthorized = function (res) {
  return exports.respondError(res, 401, exports.TOKEN_EXPIRED_MESSAGE);
}

exports.respondAffectedRows = function (res, result, options = {}) {
  const affectedRows = Number(result && result.affectedRows) || 0;
  const successStatus = options.successStatus || 200;
  const notFoundStatus = options.notFoundStatus || 404;
  // 信封统一(审查修复 20261021 P1-5):affectedRows 一并放进 data(前端 transformRequestHook 只返回 data.data),
  // 顶层保留一份兼容旧调用点与 isTransformResponse:false 的读法,
  const body = exports.buildSuccessBody(affectedRows, options);

  if (affectedRows === 0) {
    // 0 行更新不再是“成功”:原写法把 `code: 0` 与 404 同发,前端按 code 判成功会静默丢单,
    // 现改软失败体(code 非 0 + 语义 message),HTTP 状态保持 404 不影响旧前端的错误分支,
    const message = options.notFoundMessage || '数据不存在或已被删除!';
    return res.status(notFoundStatus).json({ code: notFoundStatus, message, error: message, affectedRows: 0 });
  }

  return res.status(successStatus).json(body);
}

// 成功信封拼装:affectedRows 与可选附带 data 合并为一个对象(审查修复 20261021 P1-5),
exports.buildSuccessBody = function (affectedRows, options = {}) {
  const payload = options.data;
  const extra = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const body = {
    code: 0,
    message: options.message || '操作成功',
    affectedRows,
    // 无附带对象时 data 仍为对象(含 affectedRows),使前端拿到的一致是对象而非 undefined,
    data: { affectedRows, ...extra },
  };
  // 附带值为数组/原始值时放到 value,不丢调用方数据,
  if (payload !== undefined && payload !== extra) {
    body.data.value = payload;
  }
  return body;
}

exports.respondTransaction = function (res, result, options = {}) {
  const affectedRows = Number(result && result.affectedRows) || 0;
  const successStatus = options.successStatus || 200;
  const body = exports.buildSuccessBody(affectedRows, options);

  return res.status(successStatus).json(body);
}

//token失效统一提示文案,index/menu 共用,避免各处硬编码 20260917 梳理,
exports.TOKEN_EXPIRED_MESSAGE = 'token失效1';
