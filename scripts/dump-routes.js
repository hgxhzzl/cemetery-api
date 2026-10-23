// 路由注册表自检脚本:打印每条已挂载接口的实际方法与守卫口径,并输出注册表体检结论
// (新增接口漏登记守卫时此处会直接列出), npm run routes:audit 20261021 新增,
// functionPower 体检依赖 gm_data_000.menu.powerConfig 模板,故先连库加载模板再体检 20261023 改造,
const { ROUTES, auditRouteRegistry, listRouterRoutes, buildMountPath, isWriteMethod } = require('../routeRegistry');
const permissionTemplate = require('../lib/permissionTemplate');
const database = require('../database');

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
  // functionPower 守卫(墓位业务写接口/选择设置等)此前落到 loginOnly,审核时看不出依赖哪个动作键 20261023 修复,
  if (guard.functionPower) {
    const { menu, fn, action } = guard.functionPower;
    return `functionPower=${menu}${fn ? `.${fn}` : ''}.${action}`;
  }
  return `loginOnly${guard.reason ? `(${guard.reason.slice(0, 16)}…)` : ''}`;
}

async function main() {
  try {
    const loaded = await permissionTemplate.loadFromDatabase();
    console.log(`功能模板:gm_data_000.menu.powerConfig 已加载 ${loaded} 个菜单`);

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
  } finally {
    // 加载模板需要连库,不关池会让脚本跑完后一直挂在事件循环里(命令行看不到任何输出)20261023 修复,
    await database.end();
  }
}

main().catch((error) => {
  console.error(error.code || error.message || error);
  if (error.sqlMessage) {
    console.error(error.sqlMessage);
  }
  process.exit(1);
});
