const { AsyncLocalStorage } = require('async_hooks');

const requestStorage = new AsyncLocalStorage();

function runWithResponse(res, next) {
  requestStorage.run({ res }, next);
}

function getResponse() {
  const store = requestStorage.getStore();
  return store ? store.res : null;
}

module.exports = {
  runWithResponse,
  getResponse,
};