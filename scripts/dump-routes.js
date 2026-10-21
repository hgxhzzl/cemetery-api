// 路由注册表自检脚本:打印每条已挂载接口的实际方法与守卫口径,并输出注册表体检结论
// (新增接口漏登记守卫时此处会直接列出), npm run routes:audit 20261021 新增,
const { ROUTES, auditRouteRegistry, listRouterRoutes, buildMountPath, isWriteMethod } = require('../routeRegistry');

function guardLabel(guard) {
  if (guard.menu) {
    return `${guard.queryDetail ? 'queryDetail:' : ''}menu=${guard.menu}${guard.openPaths ? ` open=${guard.openPaths.join(',')}` : ''}`;
  }
  if (guard.anyMenu) {
    return `anyMenu=${guard.anyMenu.join('|')}`;
  }
  if (guard.platformOnly) {
    return 'platformOnly';
  }
  return `loginOnly${guard.reason ? `(${guard.reason.slice(0, 16)}…)` : ''}`;
}

for (const entry of ROUTES) {
  const guardPaths = (entry.guards || []).map((guard) => `${buildMountPath(entry.path, guard.at)} → ${guardLabel(guard)}`);
  console.log(`\n[${entry.path}] ${entry.note}`);
  guardPaths.forEach((line) => console.log(`  守卫 ${line}`));
  for (const route of listRouterRoutes(entry.router)) {
    console.log(`  接口 ${route.methods.join('|').padEnd(9)} ${entry.path}${route.subPath}${isWriteMethod(route.methods) ? '  (写)' : ''}`);
  }
}

const violations = auditRouteRegistry();
if (violations.length === 0) {
  console.log(`\n注册表体检通过:${ROUTES.length} 个条目,全部接口均已登记守卫口径`);
} else {
  console.error(`\n注册表体检发现 ${violations.length} 处问题:`);
  violations.forEach((line) => console.error(' - ' + line));
  process.exitCode = 1;
}
