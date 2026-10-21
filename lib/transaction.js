// 事务执行:语句清单串行提交、编号唯一冲突守护与统一回包(由 public.js 拆出,审查修复 20261021 P1-7)。
// 对外口径不变:public.js 门面仍再导出本模块全部成员,调用点无需改动。

const pool = require('../database');
const { handleQueryError, respondError, respondTransaction } = require('./respond');

//事务
exports.Transaction = function (sqlList, res, options = {}) {
  pool.withTransaction(sqlList)
    .then((result) => {
      // options.onCommitted(result):提交成功后的副作用回调(如作废授权缓存),
      // 挂在 commit 之后而非请求入口,避免事务回滚了却按新数据放行后续请求 20261021 新增,
      if (typeof options.onCommitted === 'function') {
        try {
          options.onCommitted(result);
        } catch (error) {
          console.error('onCommitted callback failed:', error);
        }
      }
      return respondTransaction(res, result, options);
    })
    .catch((error) => {
      return handleQueryError(res, error);
    });

  return res;
}

// 销售类写事务的编号撞号兜底(审查修复 20261021 中B):取号/预检与落库间存在 TOCTOU 窗口,
// 由库层唯一索引 uk_room_region_serial 兜底,此处把 ER_DUP_ENTRY 转友好 400 而非 500,
// 供 gravePlotBusiness/sale 的 insert、update 尾部替代裸 Transaction 20261021 新增,
exports.TransactionWithSerialGuard = function (sqlList, res) {
  pool.withTransaction(sqlList)
    .then((result) => {
      return respondTransaction(res, result);
    })
    .catch((error) => {
      if (error && error.code === 'ER_DUP_ENTRY' && /uk_room_region_serial/.test(String(error.message))) {
        if (!res.headersSent) {
          // 改走统一失败信封(审查修复 20261021 二轮 P2-12):旧写法只发 error 一字段,靠中间件运行时补齐 code,
          // 本层为公共层必须直接产出标准信封(输出逐字一致且不再依赖中间件补齐),
          respondError(res, 400, '编号已被其它墓位占用（并发撞号），请重新取号后再保存!');
        }
        return res;
      }
      return handleQueryError(res, error);
    });

  return res;
}

