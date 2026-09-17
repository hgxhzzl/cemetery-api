const express = require('express');
const cors = require('cors')

//公用路径
const userRoutes = require('./login');
const menuROutes = require('./menu')
const bodyParser = require('body-parser');
const vertoken = require('./token');
const expressJwt = require('express-jwt');
const loginState = require('./loginState');
const config = require('./config');
const requestContext = require('./requestContext');
const public = require('./public');
const rbac = require('./rbac');

//合同路径
const contractDeleteROutes = require('./contract/delete')
const contractQueryROutes  = require('./contract/query')
const contractSaveROutes = require('./contract/save')

//账户路径
const accountDeleteROutes = require('./account/delete')
const accountQueryROutes  = require('./account/query')
const accountSaveROutes = require('./account/save')

//标签路径
const taginfoQueryROutes  = require('./taginfo/query')
const taginfoSaveROutes  = require('./taginfo/save')

//操作员路径
const operatorDeleteROutes = require('./operator/delete')
const operatorQueryROutes  = require('./operator/query')
const operatorSaveROutes = require('./operator/save')

//操作员权限路径
const operatorPowerQueryROutes  = require('./operatorPower/query')
const operatorPowerSaveROutes = require('./operatorPower/save')

//园区路径
const parkQueryROutes  = require('./park/query')
const parkSaveROutes = require('./park/save')

//room路径
const roomQueryROutes  = require('./room/query')
const roomSaveROutes = require('./room/save')
const roomDeleteROutes = require('./room/delete')

//销售路径
const saleSaveROutes = require('./sale/save')
const saleDeleteROutes = require('./sale/delete')
const saleQueryROutes = require('./sale/query')
//销售统计查询路径
const saleQueryStatsRoutes = require('./saleQuery/query')
const buriedQueryStatsRoutes = require('./buriedQuery/query')
const adminfeeQueryStatsRoutes = require('./adminfeeQuery/query')
const contactsQueryStatsRoutes = require('./contactsQuery/query')
//管理期限路径
const managementPeriodRoutes = require('./managementPeriod/query')
const managementPeriodSaveRoutes = require('./managementPeriod/save')


//首页路径
const dashboardQueryROutes  = require('./dashboard/query')

//下葬路径
const buriedQueryROutes  = require('./buried/query')
const buriedSaveROutes = require('./buried/save')
const buriedDeleteROutes = require('./buried/delete')
const transferOutQueryROutes  = require('./transferOut/query')
const transferOutSaveROutes = require('./transferOut/save')
const transferOutDeleteROutes = require('./transferOut/delete')

//管理费收款路径
const adminfeeQueryROutes = require('./adminfee/query')
const adminfeeSaveROutes = require('./adminfee/save')
const adminfeeDeleteROutes = require('./adminfee/delete')

//墓位联系人路径
const contactsQueryROutes = require('./contacts/query')
const contactsSaveROutes = require('./contacts/save')
const contactsDeleteROutes = require('./contacts/delete')

//预定路径
const reserveSaveROutes = require('./reserve/save')
const reserveQueryROutes = require('./reserve/query')
const reserveDeleteROutes = require('./reserve/delete')

//账户权限路径
const accountPowerQueryROutes  = require('./accountPower/query')
const accountPowerSaveROutes  = require('./accountPower/save')


const app = express();

process.env.appname = "GlobalVar";

//token失效统一提示信息,中间件与错误处理共用,文案收敛到 public 避免硬编码 20260917 梳理,
const TOKEN_EXPIRED_MESSAGE = public.TOKEN_EXPIRED_MESSAGE;

//路由
app.get('/', (req, res) => {
  res.send('Hello, World!')
});
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
app.use((req, res, next) => requestContext.runWithResponse(res, next));

app.use(cors({
  origin: config.app.corsOrigin,
  credentials: true
}));

// 请求日志中间件:记录方法/路径/状态码/耗时 20260915 新增,
app.use(function(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    console.log(`${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - start}ms`);
  });
  return next();
});

// 解析token获取用户信息:仅负责将有效token负载注入 req.data 并校验活跃登录态;
// 验签失败/过期/格式非法由认证层直接闭环 401,不再静默放行依赖下方 express-jwt 兑底 20260917 收口,
// 免认证路径直接放行:登录请求可能携带旧token(localStorage残留),不应被认证层误拒 20260917 修复,
// 菜单接口仍须解析token注入 req.data(按用户权限过滤菜单),不在豁免之列 20260917 修复,
app.use(async function (req, res, next) {
  if (req.path === '/' || req.path === '/api/login') {
    return next();
  }
  var token = req.headers['authorization'];
  if (token == undefined) {
    return next();
  }
  // header 格式非法(非 "Bearer <token>")时直接拒绝 20260917 收口,
  if (typeof token !== 'string' || !/^Bearer \S+$/.test(token.trim())) {
    return res.status(401).send(TOKEN_EXPIRED_MESSAGE);
  }
  try {
    const data = await vertoken.verToken(token);
    req.data = data;
  } catch (error) {
    // 验签失败/token过期由认证层直接闭环,不再依赖下方 express-jwt 兑底 20260917 收口,
    return res.status(401).send(TOKEN_EXPIRED_MESSAGE);
  }
  // 校验活跃登录态:DB 查询失败按服务错误处理,避免误报为 token 失效 20260917 登录态DB化,
  try {
    const active = await loginState.hasActiveLogin(req.data.phone, req.data.exp);
    // 不存在活跃登录态(重新登录/登出后旧token)则结束
    if (!active) {
      return res.status(401).send(TOKEN_EXPIRED_MESSAGE);
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }
  return next();
});
  //验证token是否过期并规定哪些路由不用验证,
  //地址一定要用双引号，单引号不好使
  //path: [ "/api/login","/api/get-menu-list-i18n","/api/room-query/parkTree"]
  app.use(expressJwt.expressjwt({
  secret: config.auth.jwtSecret,algorithms: ["HS256"] })
  .unless({
  path: [ "/","/api/login","/api/get-menu-list-i18n"]
  }));
  //当token失效返回提示信息
  app.use(function(err, req, res, next) {

  if (err.status == 401) {
    console.log('auth 401:', err.code || 'unauthorized', req.method, req.originalUrl);
    return res.status(401).send(TOKEN_EXPIRED_MESSAGE);
  }

  console.error('Unhandled middleware error:', err);
  return next(err);
  });
  
app.use('/api/login',userRoutes);
app.use('/api/get-menu-list-i18n',menuROutes);

//合同接口(菜单 101102 合同列表) 20260917 RBAC 接入,
app.use('/api/contract-save/insert', rbac.requirePower('101102', 'create'));
app.use('/api/contract-save/update', rbac.requirePower('101102', 'modify'));
app.use('/api/contract-delete', rbac.requirePower('101102', 'delete'));
app.use('/api/contract-query', rbac.requirePower('101102', 'menu'));
app.use('/api/contract-delete',contractDeleteROutes);
app.use('/api/contract-query',contractQueryROutes);
app.use('/api/contract-save',contractSaveROutes);
//账户接口
app.use('/api/account-save',accountSaveROutes);
app.use('/api/account-query',accountQueryROutes);
app.use('/api/account-delete',accountDeleteROutes);
//标签接口(菜单 102102 选择设置) 20260917 RBAC 接入,
app.use('/api/taginfo-save/insert', rbac.requirePower('102102', 'create'));
app.use('/api/taginfo-query', rbac.requirePower('102102', 'menu'));
app.use('/api/taginfo-query',taginfoQueryROutes);
app.use('/api/taginfo-save',taginfoSaveROutes);

//操作员接口(菜单 102104 操作人员) 20260917 RBAC 接入,
app.use('/api/operator-save/insert', rbac.requirePower('102104', 'create'));
app.use('/api/operator-save/update', rbac.requirePower('102104', 'modify'));
app.use('/api/operator-save/password', rbac.requirePower('102104', 'modify'));
app.use('/api/operator-save/power', rbac.requirePower('102104', 'modify'));
app.use('/api/operator-delete', rbac.requirePower('102104', 'delete'));
app.use('/api/operator-query', rbac.requirePower('102104', 'menu'));
app.use('/api/operator-save',operatorSaveROutes);
app.use('/api/operator-query',operatorQueryROutes);
app.use('/api/operator-delete',operatorDeleteROutes);
//操作员权限接口(菜单 102104 操作人员)
app.use('/api/operatorPower-save/power', rbac.requirePower('102104', 'modify'));
app.use('/api/operatorPower-query', rbac.requirePower('102104', 'menu'));
app.use('/api/operatorPower-save',operatorPowerSaveROutes);
app.use('/api/operatorPower-query',operatorPowerQueryROutes);
//园区接口(菜单 102103 园区设置)
app.use('/api/park-save/insert', rbac.requirePower('102103', 'create'));
app.use('/api/park-query', rbac.requirePower('102103', 'menu'));
app.use('/api/park-save',parkSaveROutes);
app.use('/api/park-query',parkQueryROutes);
//room接口(菜单 103101 墓区设置)
app.use('/api/room-save/insert', rbac.requirePower('103101', 'create'));
app.use('/api/room-save/update', rbac.requirePower('103101', 'modify'));
app.use('/api/room-delete', rbac.requirePower('103101', 'delete'));
app.use('/api/room-query', rbac.requirePower('103101', 'menu'));
app.use('/api/room-save',roomSaveROutes);
app.use('/api/room-query',roomQueryROutes);
app.use('/api/room-delete',roomDeleteROutes);

//销售接口(菜单 103102 墓区销售) 20260917 RBAC 接入,
app.use('/api/sale-save/insert', rbac.requirePower('103102', 'create'));
app.use('/api/sale-save/update', rbac.requirePower('103102', 'modify'));
app.use('/api/sale-delete', rbac.requirePower('103102', 'delete'));
app.use('/api/sale-query', rbac.requirePower('103102', 'menu'));
app.use('/api/sale-save',saleSaveROutes);
app.use('/api/sale-delete',saleDeleteROutes);
app.use('/api/sale-query',saleQueryROutes);
//销售统计查询接口(菜单 105101/105102/105103/105104 查询统计)
// 去掉模块名中冗余的 -query 后缀(目录名已含 Query) 20260915 路由清理,
app.use('/api/saleQuery', rbac.requirePower('105101', 'menu'));
app.use('/api/buriedQuery', rbac.requirePower('105102', 'menu'));
app.use('/api/adminfeeQuery', rbac.requirePower('105103', 'menu'));
app.use('/api/contactsQuery', rbac.requirePower('105104', 'menu'));
app.use('/api/saleQuery',saleQueryStatsRoutes);
app.use('/api/buriedQuery',buriedQueryStatsRoutes);
app.use('/api/adminfeeQuery',adminfeeQueryStatsRoutes);
app.use('/api/contactsQuery',contactsQueryStatsRoutes);
//管理期限接口(菜单 104102 管理期限)
app.use('/api/managementPeriod-save/update', rbac.requirePower('104102', 'modify'));
app.use('/api/managementPeriod', rbac.requirePower('104102', 'menu'));
app.use('/api/managementPeriod',managementPeriodRoutes);
app.use('/api/managementPeriod-save',managementPeriodSaveRoutes);


//下葬接口(菜单 103103 墓区下葬) 20260917 RBAC 接入,
app.use('/api/buried-save/insert', rbac.requirePower('103103', 'create'));
app.use('/api/buried-save/update', rbac.requirePower('103103', 'modify'));
app.use('/api/buried-delete', rbac.requirePower('103103', 'delete'));
app.use('/api/buried-query', rbac.requirePower('103103', 'menu'));
app.use('/api/buried-save',buriedSaveROutes);
app.use('/api/buried-query',buriedQueryROutes);
app.use('/api/buried-delete',buriedDeleteROutes);
//迁出接口(菜单 103106 墓位迁出)
app.use('/api/transferOut-save/insert', rbac.requirePower('103106', 'create'));
app.use('/api/transferOut-save/update', rbac.requirePower('103106', 'modify'));
app.use('/api/transferOut-delete', rbac.requirePower('103106', 'delete'));
app.use('/api/transferOut-query', rbac.requirePower('103106', 'menu'));
app.use('/api/transferOut-save',transferOutSaveROutes);
app.use('/api/transferOut-query',transferOutQueryROutes);
app.use('/api/transferOut-delete',transferOutDeleteROutes);
//管理费收款接口(菜单 104101 管理收款)
app.use('/api/adminfee-save/insert', rbac.requirePower('104101', 'create'));
app.use('/api/adminfee-save/update', rbac.requirePower('104101', 'modify'));
app.use('/api/adminfee-delete', rbac.requirePower('104101', 'delete'));
app.use('/api/adminfee-query', rbac.requirePower('104101', 'menu'));
app.use('/api/adminfee-save',adminfeeSaveROutes);
app.use('/api/adminfee-query',adminfeeQueryROutes);
app.use('/api/adminfee-delete',adminfeeDeleteROutes);
//墓位联系人接口(菜单 103105 墓位联系)
app.use('/api/contacts-save/insert', rbac.requirePower('103105', 'create'));
app.use('/api/contacts-save/update', rbac.requirePower('103105', 'modify'));
app.use('/api/contacts-delete', rbac.requirePower('103105', 'delete'));
app.use('/api/contacts-query', rbac.requirePower('103105', 'menu'));
app.use('/api/contacts-save',contactsSaveROutes);
app.use('/api/contacts-query',contactsQueryROutes);
app.use('/api/contacts-delete',contactsDeleteROutes);
//预定接口(菜单 103104 墓区预定)
app.use('/api/reserve-save/insert', rbac.requirePower('103104', 'create'));
app.use('/api/reserve-save/update', rbac.requirePower('103104', 'modify'));
app.use('/api/reserve-delete', rbac.requirePower('103104', 'delete'));
app.use('/api/reserve-query', rbac.requirePower('103104', 'menu'));
app.use('/api/reserve-save',reserveSaveROutes);
app.use('/api/reserve-query',reserveQueryROutes);
app.use('/api/reserve-delete',reserveDeleteROutes);
//账户菜单
app.use('/api/accountPower-query',accountPowerQueryROutes);
app.use('/api/accountPower-save',accountPowerSaveROutes);
//首页接口
app.use('/api/dashboard-query',dashboardQueryROutes);

//启动服务器
// 生产环境敏感配置缺失时拒绝启动 20260917 收口,
if (config.securityFatal.length > 0) {
  config.securityFatal.forEach((message) => console.error('[security] Fatal:', message));
  process.exit(1);
}

// 启动前幂等建表:确保登录态表 login_session 存在,线上老库缺表曾导致登录 500 20260917 修复,
loginState.ensureTable().then(() => {
  app.listen(config.app.port, () => {
    console.log(`Server is running on port ${config.app.port}`);
    // 敏感配置默认值告警:生产环境务必通过环境变量覆盖 20260917 新增,
    config.securityWarnings.forEach((warning) => console.warn('[security]', warning));
    if (process.env.basicTime =="") {
      console.log('Server basic data is null');
    }
  });
}).catch((error) => {
  console.error('[startup] login_session 建表失败,拒绝启动:', error.message);
  process.exit(1);
});



