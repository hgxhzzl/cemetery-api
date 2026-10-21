// public.js —— 全站公共工具的再导出门面(facade)。
// 原单文件同时承担 SQL 构造、响应封装、口令、日期、管理费期限链、墓位同步等 6 类职责,
// 被 100+ 处 require 引用,任何改动全仓震荡;现按职责拆到 lib/*.js,本文件只做再导出,
// 调用点一行不改(审查修复 20261021 P1-7)。新增工具请写进对应的 lib 模块并在此再导出,
// 依赖方向:lib 之间只允许 common ← 其余模块的单向引用(拆分脚本已断言不成环),
const MODULES = ['common', 'sqlBuilder', 'security', 'respond', 'feePeriod', 'roomSync', 'transaction'];

MODULES.forEach((name) => {
  Object.assign(exports, require('./lib/' + name));
});
