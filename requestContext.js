const { AsyncLocalStorage } = require('async_hooks');

const requestStorage = new AsyncLocalStorage();

function runWithResponse(res, reqId, next) {
  requestStorage.run({ res, reqId }, next);
}

function getResponse() {
  const store = requestStorage.getStore();
  return store ? store.res : null;
}

// 取当前请求的关联号(审查修复 20261021 二轮 P2-16):database.js 的慢语句日志跑在 HTTP 中间件之外,
// 拿不到 req,只能从同一异步链的上下文取,才能把 access log 与 [slow-query] 串成同一条时间线,
function getRequestId() {
  const store = requestStorage.getStore();
  return store && store.reqId ? store.reqId : '-';
}

module.exports = {
  runWithResponse,
  getResponse,
  getRequestId,
};