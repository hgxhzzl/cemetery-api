// 声明式路由注册表(审查修复 20261021 P1-4):原 index.js 用两张彼此独立的手工清单维护接口——
// 「守卫挂载表」(区域归属 + 菜单权限,约 40 行)与「路由挂载表」(约 40 行),
// 二者的唯一约束是“守卫必须先于业务路由注册”,只能靠注释与人工纪律维持;
// 新增接口时漏写一行守卫,结果就是该接口无鉴权裸奔,且当时没有任何测试能发现。
// 本文件把“挂哪里 / 由哪个 router 处理 / 需要哪些守卫”收进单表 ROUTES,由 mountApiRoutes
// 按固定顺序(区域归属 → 菜单权限 → 业务路由)落挂载,调用方无需再关心顺序;
// 守卫覆盖由 tests/routes.test.js 遍历全表断言:写接口必须声明权限守卫,豁免项必须写明理由 20261021 新增,

const rbac = require('./rbac');
const device = require('./device');

// 合同路径
const contractDeleteROutes = require('./contract/delete');
const contractQueryROutes = require('./contract/query');
const contractSaveROutes = require('./contract/save');
// 账户路径
const accountDeleteROutes = require('./account/delete');
const accountQueryROutes = require('./account/query');
const accountSaveROutes = require('./account/save');
// 标签路径
const taginfoQueryROutes = require('./taginfo/query');
const taginfoSaveROutes = require('./taginfo/save');
// 操作员路径
const operatorDeleteROutes = require('./operator/delete');
const operatorQueryROutes = require('./operator/query');
const operatorSaveROutes = require('./operator/save');
// 操作员权限路径
const operatorPowerQueryROutes = require('./operatorPower/query');
const operatorPowerSaveROutes = require('./operatorPower/save');
// 园区路径
const parkQueryROutes = require('./park/query');
const parkSaveROutes = require('./park/save');
// 收据配制路径
const receiptConfigQueryROutes = require('./receiptConfig/query');
const receiptConfigSaveROutes = require('./receiptConfig/save');
// 卡片配色路径
const cardColorQueryROutes = require('./cardColor/query');
const cardColorSaveROutes = require('./cardColor/save');
// room 路径
const roomQueryROutes = require('./room/query');
const roomSaveROutes = require('./room/save');
const roomDeleteROutes = require('./room/delete');
// 销售路径
const saleSaveROutes = require('./sale/save');
const saleDeleteROutes = require('./sale/delete');
const saleQueryROutes = require('./sale/query');
// 销售统计查询路径
const saleQueryStatsRoutes = require('./saleQuery/query');
// 墓位业务路径(菜单 103101 墓位业务,数据表 graveplotbusiness,独立于销售)
const gravePlotBusinessSaveROutes = require('./gravePlotBusiness/save');
const gravePlotBusinessDeleteROutes = require('./gravePlotBusiness/delete');
const gravePlotBusinessQueryROutes = require('./gravePlotBusiness/query');
const gravePlotBusinessCancelSaleROutes = require('./gravePlotBusiness/cancelSale');
const buriedQueryStatsRoutes = require('./buriedQuery/query');
const adminfeeQueryStatsRoutes = require('./adminfeeQuery/query');
const contactsQueryStatsRoutes = require('./contactsQuery/query');
const roomQueryStatsRoutes = require('./roomQuery/query');
// 管理期限路径
const managementPeriodRoutes = require('./managementPeriod/query');
const managementPeriodSaveRoutes = require('./managementPeriod/save');
// 首页路径
const dashboardQueryROutes = require('./dashboard/query');
// 下葬路径
const buriedQueryROutes = require('./buried/query');
const buriedSaveROutes = require('./buried/save');
const buriedDeleteROutes = require('./buried/delete');
// 迁出路径
const transferOutQueryROutes = require('./transferOut/query');
const transferOutSaveROutes = require('./transferOut/save');
const transferOutDeleteROutes = require('./transferOut/delete');
// 管理费收款路径
const adminfeeQueryROutes = require('./adminfee/query');
const adminfeeSaveROutes = require('./adminfee/save');
const adminfeeDeleteROutes = require('./adminfee/delete');
// 墓位联系人路径
const contactsQueryROutes = require('./contacts/query');
const contactsSaveROutes = require('./contacts/save');
const contactsDeleteROutes = require('./contacts/delete');
// 预定路径
const reserveSaveROutes = require('./reserve/save');
const reserveQueryROutes = require('./reserve/query');
const reserveDeleteROutes = require('./reserve/delete');
// 账户权限路径
const accountPowerQueryROutes = require('./accountPower/query');
const accountPowerSaveROutes = require('./accountPower/save');
// 公用路径
const userRoutes = require('./login');
const menuROutes = require('./menu');

// 主键记录的区域归属校验作用域:room 表直查自身 region,其余业务表 JOIN room 取 region,
// 表名/主键字段/入参名均为代码侧固定字符串(不接受请求输入),迁移注册表时逐字保留原口径,
const ownRoomScope = { table: 'room', idParam: 'idRoom' };
const ownBuriedScope = { table: 'buried', idField: 'idBuried', idParam: 'idBuried' };
const ownTransferOutScope = { table: 'transfer_out', idField: 'idTransfer', idParam: 'idTransfer' };
const ownAdminfeeScope = { table: 'adminfee', idField: 'idAdminfee', idParam: 'idAdminfee' };
const ownContactsScope = { table: 'contacts', idField: 'idContacts', idParam: 'idContacts' };

// 守卫声明字段含义:
//   menu         - 需具备该菜单的 useMenu(整前缀或 at 指定的子路径)
//   openPaths    - 配合 menu:该前缀下的这些子路径仅需登录(参照数据不能要求页面菜单权限)
//   anyMenu      - 任一指命菜单具备 useMenu 即放行(业务页与对应查询页共用同一接口)
//   queryDetail  - 配合 menu:查询前缀专用口径,详情取数路径按“任一详情页菜单”放行
//   platformOnly - 仅平台管理员(gm_data_000 租户账户)
//   ownership    - 主键记录的区域归属校验;可单独出现(子路径归属校验,权限由同一条目的整前缀守卫担当),
//                  也可与上面任一权限同时出现
//   loginOnly    - 显式声明“仅需登录”,必须同时给出 reason(测试据此判定为有意豁免而非漏写)
// 条目字段 loginOnlyWrites:声明“该条目的写接口(POST/PUT/DELETE)历史上就只要求登录”,
// 必须写明理由;未声明的条目内出现未登记守卫的写接口会在启动时被 mountApiRoutes 拒绝,
// 这样“新增接口漏一行守卫”从线上的无鉴权裸奔变成启动即失败(审查修复 20261021 P1-4),
// 区域归属校验在 index.js 里原本统一排在所有菜单权限之前,现按条目内顺序挂载:
// 同一前缀下“归属 → 权限”的相对顺序保持不变,跨前缀之间互不影响(Express 按挂载前缀各自匹配),
const ROUTES = [
  // ==================== 登录与全局接口 ====================
  {
    path: '/api/login',
    router: userRoutes,
    note: '登录(设备白名单/爆破防护在路由内部)',
    loginOnlyWrites: '登录/登出接口本身即鉴权入口,不存在上一层权限可依据',
    guards: [{ at: '', loginOnly: true, reason: '登录接口本身即鉴权入口,且在 index.js 的 AUTH_EXEMPT_PATHS 豁免名单内' }],
  },
  {
    path: '/api/get-menu-list-i18n',
    router: menuROutes,
    note: '菜单树:按当前身份过滤',
    guards: [{ at: '', loginOnly: true, reason: '菜单接口按登录身份过滤且免菜单权限,不含业务数据写口' }],
  },
  {
    // 设备白名单接口(登记/列表/停用,仅平台管理员可操作) 20260924 新增;原口径由 device.js 内部
    // requireAdmin 判定,此处再挂一道同名守卫使权限口径在注册表里可见(审查修复 20261021 P1-1/P1-4),
    path: '/api/device',
    router: device.router,
    note: '登录设备白名单登记/列表/停用',
    guards: [{ at: '', platformOnly: true }],
  },

  // ==================== 合同(菜单 101102 合同列表) ====================
  {
    path: '/api/contract-save',
    router: contractSaveROutes,
    note: '合同新建/修改',
    guards: [
      { at: '/insert', menu: 'contract' },
      { at: '/update', menu: 'contract' },
    ],
  },
  {
    path: '/api/contract-query',
    router: contractQueryROutes,
    note: '合同查询(contract 表在 gm_data_000 全局库无 region 列,不做区域归属)',
    guards: [{ at: '', menu: 'contract' }],
  },
  {
    path: '/api/contract-delete',
    router: contractDeleteROutes,
    note: '合同删除',
    guards: [{ at: '', menu: 'contract' }],
  },

  // ==================== 账户(租户开户与资料,历史上仅要求登录) ====================
  {
    path: '/api/account-save',
    router: accountSaveROutes,
    note: '账户新建/修改/建库',
    loginOnlyWrites: '账户开户为注册流程入口,历史口径即只要登录不校验菜单权限;若需收口为仅平台管理员,请显式改本条目守卫',
    guards: [{ at: '', loginOnly: true, reason: '账户开户为注册流程入口,历史口径即只要登录不校验菜单权限;迁移注册表时保持不变' }],
  },
  {
    path: '/api/account-query',
    router: accountQueryROutes,
    note: '账户查询',
    guards: [{ at: '', loginOnly: true, reason: '同上:账户接口历史仅要求登录,迁移时保持口径' }],
  },
  {
    path: '/api/account-delete',
    router: accountDeleteROutes,
    note: '账户注销(级联删除该租户操作员与授权)',
    loginOnlyWrites: '账户接口历史仅要求登录,迁移时保持口径(收口为 platformOnly 需业务确认后再改)',
    guards: [{ at: '', loginOnly: true, reason: '账户接口历史仅要求登录,迁移时保持口径(收口为 platformOnly 需业务确认后再改)' }],
  },

  // ==================== 标签(菜单 102102 选择设置) ====================
  {
    // /taginfo 作为业务页参考数据(墓位业务页“逝者关系”下拉)不要求“选择设置”菜单权限,
    // 否则未开该菜单的操作员表单里这个下拉会空;/tagset 仍属选择设置页自身功能,保持严格校验 20261010 修复,
    path: '/api/taginfo-save',
    router: taginfoSaveROutes,
    note: '标签新建/修改',
    guards: [{ at: '/insert', menu: 'tagInfo' }],
  },
  {
    path: '/api/taginfo-query',
    router: taginfoQueryROutes,
    note: '标签查询',
    guards: [{ at: '', menu: 'tagInfo', openPaths: ['/taginfo'] }],
  },

  // ==================== 操作员(菜单 102104 操作人员) ====================
  {
    path: '/api/operator-save',
    router: operatorSaveROutes,
    note: '操作员新建/修改/重置密码/授权',
    guards: [
      { at: '/insert', menu: 'operator' },
      { at: '/update', menu: 'operator' },
      { at: '/password', menu: 'operator' },
      { at: '/power', menu: 'operator' },
    ],
  },
  {
    path: '/api/operator-query',
    router: operatorQueryROutes,
    note: '操作员查询',
    guards: [{ at: '', menu: 'operator' }],
  },
  {
    path: '/api/operator-delete',
    router: operatorDeleteROutes,
    note: '操作员删除',
    guards: [{ at: '', menu: 'operator' }],
  },
  {
    path: '/api/operatorPower-save',
    router: operatorPowerSaveROutes,
    note: '操作员权限保存',
    guards: [{ at: '/power', menu: 'operator' }],
  },
  {
    path: '/api/operatorPower-query',
    router: operatorPowerQueryROutes,
    note: '操作员权限查询',
    guards: [{ at: '', menu: 'operator' }],
  },

  // ==================== 园区(菜单 102103 园区设置) ====================
  {
    // 区域/园区下拉(/region /park)为各业务页与查询页共用的参照数据且已按 operator.region 收窄,
    // 不要求调用者具备“园区设置”菜单权限:未开该菜单的操作员会 403,表现为区域下拉空白 20261010 修复,
    path: '/api/park-save',
    router: parkSaveROutes,
    note: '园区/区域新建修改',
    guards: [{ at: '/insert', menu: 'park' }],
  },
  {
    path: '/api/park-query',
    router: parkQueryROutes,
    note: '园区树与区域/园区下拉',
    guards: [{ at: '', menu: 'park', openPaths: ['/region', '/park'] }],
  },

  // ==================== 收据配制(菜单 102105 收据配制) ====================
  {
    path: '/api/receiptConfig-save',
    router: receiptConfigSaveROutes,
    note: '收据配制保存',
    guards: [{ at: '', menu: 'receiptConfig' }],
  },
  {
    path: '/api/receiptConfig-query',
    router: receiptConfigQueryROutes,
    note: '收据配制读取',
    guards: [{ at: '', menu: 'receiptConfig' }],
  },
  {
    // 打印票据读取前缀/地址/电话不属页面操作,仅需登录不校验菜单权限 20260922 新增,
    path: '/api/receiptConfig-print',
    router: receiptConfigQueryROutes,
    note: '打印取用票据抬头信息',
    guards: [{ at: '', loginOnly: true, reason: '打印抬头属展示型参照数据,历史口径仅需登录;写口在 receiptConfig-save 已把守' }],
  },

  // ==================== 卡片配色(菜单 name=cardColor 卡片颜色) ====================
  {
    // 查询不校验菜单权限:四态卡片色出现在墓位业务/墓位设置/管理费用/迁出等所有卡片页,未开“卡片颜色”
    // 菜单的操作员也应看到同事配好的色,权限只挡在保存上 20261011 新增,
    path: '/api/cardColor-query',
    router: cardColorQueryROutes,
    note: '卡片配色读取',
    guards: [{ at: '', loginOnly: true, reason: '配色为跨页共享展示数据,历史口径仅需登录;写口在 cardColor-save 已把守' }],
  },
  {
    path: '/api/cardColor-save',
    router: cardColorSaveROutes,
    note: '卡片配色保存',
    guards: [{ at: '', menu: 'cardColor' }],
  },

  // ==================== 墓位设置(菜单 name=room) ====================
  {
    path: '/api/room-save',
    router: roomSaveROutes,
    note: '墓位新建(含批量建位)/修改',
    guards: [
      { at: '/insert', menu: 'room' },
      { at: '/update', menu: 'room', ownership: ownRoomScope },
    ],
  },
  {
    path: '/api/room-query',
    router: roomQueryROutes,
    note: '墓位卡片列表与详情取数',
    guards: [{ at: '/idList', ownership: ownRoomScope }, { at: '', menu: 'room', queryDetail: true }],
  },
  {
    path: '/api/room-delete',
    router: roomDeleteROutes,
    note: '墓位软删',
    guards: [{ at: '', menu: 'room', ownership: ownRoomScope }],
  },

  // ==================== 墓位销售(菜单 103102) ====================
  {
    path: '/api/sale-save',
    router: saleSaveROutes,
    note: '销售新建/修改',
    guards: [
      { at: '/insert', menu: 'sale' },
      { at: '/update', menu: 'sale', ownership: ownRoomScope },
    ],
  },
  {
    path: '/api/sale-query',
    router: saleQueryROutes,
    note: '销售记录取数',
    guards: [{ at: '/get-by-room', ownership: ownRoomScope }, { at: '', menu: 'sale', queryDetail: true }],
  },
  {
    path: '/api/sale-delete',
    router: saleDeleteROutes,
    note: '销售作废',
    guards: [{ at: '', menu: 'sale', ownership: ownRoomScope }],
  },

  // ==================== 墓位业务(菜单 103101) ====================
  {
    path: '/api/gravePlotBusiness-save',
    router: gravePlotBusinessSaveROutes,
    note: '墓位业务新建/修改',
    guards: [
      { at: '/insert', menu: 'gravePlotBusiness' },
      { at: '/update', menu: 'gravePlotBusiness', ownership: ownRoomScope },
    ],
  },
  {
    path: '/api/gravePlotBusiness-query',
    router: gravePlotBusinessQueryROutes,
    note: '墓位业务取数',
    guards: [{ at: '/get-by-room', ownership: ownRoomScope }, { at: '', menu: 'gravePlotBusiness' }],
  },
  {
    path: '/api/gravePlotBusiness-delete',
    router: gravePlotBusinessDeleteROutes,
    note: '墓位业务删除',
    guards: [{ at: '', menu: 'gravePlotBusiness', ownership: ownRoomScope }],
  },
  {
    // 销售取消:后端补齐“仅平台管理员”口径,与前端入口 isAccount===1 网关一致
    // (原仅菜单权限与注释不符,审查修复 20261021 ⑤),
    path: '/api/gravePlotBusiness-cancelSale',
    router: gravePlotBusinessCancelSaleROutes,
    note: '取消销售(仅平台管理员)',
    guards: [{ at: '', platformOnly: true, menu: 'gravePlotBusiness', ownership: ownRoomScope }],
  },

  // ==================== 查询统计(菜单 1051xx) ====================
  { path: '/api/saleQuery', router: saleQueryStatsRoutes, note: '销售统计查询', guards: [{ at: '', menu: 'saleQuery' }] },
  { path: '/api/buriedQuery', router: buriedQueryStatsRoutes, note: '下葬统计查询', guards: [{ at: '', menu: 'buriedQuery' }] },
  { path: '/api/adminfeeQuery', router: adminfeeQueryStatsRoutes, note: '管理费统计查询', guards: [{ at: '', menu: 'adminfeeQuery' }] },
  { path: '/api/contactsQuery', router: contactsQueryStatsRoutes, note: '联系人统计查询', guards: [{ at: '', menu: 'contactsQuery' }] },
  { path: '/api/roomQuery', router: roomQueryStatsRoutes, note: '墓位信息查询', guards: [{ at: '', menu: 'roomQuery' }] },

  // ==================== 管理期限(菜单 104102) ====================
  {
    path: '/api/managementPeriod-save',
    router: managementPeriodSaveRoutes,
    note: '管理期限修改',
    guards: [{ at: '/update', menu: 'managementPeriod', ownership: ownRoomScope }],
  },
  {
    path: '/api/managementPeriod',
    router: managementPeriodRoutes,
    note: '管理期限查询',
    guards: [{ at: '', menu: 'managementPeriod' }],
  },

  // ==================== 墓位下葬(菜单 103103) ====================
  {
    path: '/api/buried-save',
    router: buriedSaveROutes,
    note: '下葬新建/修改',
    guards: [
      { at: '/insert', menu: 'buried' },
      { at: '/update', menu: 'buried', ownership: ownRoomScope },
    ],
  },
  {
    path: '/api/buried-query',
    router: buriedQueryROutes,
    note: '下葬记录取数',
    guards: [{ at: '', menu: 'buried', queryDetail: true, ownership: ownRoomScope }],
  },
  {
    path: '/api/buried-delete',
    router: buriedDeleteROutes,
    note: '下葬记录作废',
    guards: [{ at: '', menu: 'buried', ownership: ownBuriedScope }],
  },

  // ==================== 墓位迁出(菜单 103106) ====================
  {
    path: '/api/transferOut-save',
    router: transferOutSaveROutes,
    note: '迁出新建/修改',
    guards: [
      { at: '/insert', menu: 'transferOut' },
      { at: '/update', menu: 'transferOut', ownership: ownRoomScope },
    ],
  },
  {
    path: '/api/transferOut-query',
    router: transferOutQueryROutes,
    note: '迁出记录取数(业务页与迁出查询页共用)',
    guards: [{ at: '', anyMenu: ['transferOut', 'transferOutQuery'] }],
  },
  {
    path: '/api/transferOut-delete',
    router: transferOutDeleteROutes,
    note: '迁出记录作废',
    guards: [{ at: '', menu: 'transferOut', ownership: ownTransferOutScope }],
  },

  // ==================== 管理费收款(菜单 104101) ====================
  {
    path: '/api/adminfee-save',
    router: adminfeeSaveROutes,
    note: '管理费收款新建/修改',
    guards: [
      { at: '/insert', menu: 'adminfee' },
      { at: '/update', menu: 'adminfee', ownership: ownRoomScope },
    ],
  },
  {
    path: '/api/adminfee-query',
    router: adminfeeQueryROutes,
    note: '管理费记录取数',
    guards: [{ at: '', menu: 'adminfee', queryDetail: true, ownership: ownRoomScope }],
  },
  {
    path: '/api/adminfee-delete',
    router: adminfeeDeleteROutes,
    note: '管理费记录作废',
    guards: [{ at: '', menu: 'adminfee', ownership: ownAdminfeeScope }],
  },

  // ==================== 墓位联系人(菜单 103105) ====================
  {
    path: '/api/contacts-save',
    router: contactsSaveROutes,
    note: '联系人新建/修改',
    guards: [
      { at: '/insert', menu: 'contacts' },
      { at: '/update', menu: 'contacts', ownership: ownRoomScope },
    ],
  },
  {
    path: '/api/contacts-query',
    router: contactsQueryROutes,
    note: '联系人取数',
    guards: [{ at: '', menu: 'contacts', queryDetail: true, ownership: ownRoomScope }],
  },
  {
    path: '/api/contacts-delete',
    router: contactsDeleteROutes,
    note: '联系人删除',
    guards: [{ at: '', menu: 'contacts', ownership: ownContactsScope }],
  },

  // ==================== 墓位预定(菜单 103104) ====================
  {
    path: '/api/reserve-save',
    router: reserveSaveROutes,
    note: '预定新建/修改',
    guards: [
      { at: '/insert', menu: 'reserve' },
      { at: '/update', menu: 'reserve', ownership: ownRoomScope },
    ],
  },
  {
    path: '/api/reserve-query',
    router: reserveQueryROutes,
    note: '预定记录取数',
    guards: [{ at: '/get-by-room', ownership: ownRoomScope }, { at: '', menu: 'reserve', queryDetail: true }],
  },
  {
    path: '/api/reserve-delete',
    router: reserveDeleteROutes,
    note: '预定记录作废',
    guards: [{ at: '', menu: 'reserve', ownership: ownRoomScope }],
  },

  // ==================== 账户权限与首页 ====================
  {
    path: '/api/accountPower-save',
    router: accountPowerSaveROutes,
    note: '账户(租户)菜单权限保存',
    loginOnlyWrites: '账户权限接口与账户接口同口径,历史仅要求登录;写口按账户自身身份生效',
    guards: [{ at: '', loginOnly: true, reason: '账户权限接口与账户接口同口径,历史仅要求登录;写口按账户自身身份生效' }],
  },
  {
    path: '/api/accountPower-query',
    router: accountPowerQueryROutes,
    note: '账户菜单权限读取',
    guards: [{ at: '', loginOnly: true, reason: '同上' }],
  },
  {
    path: '/api/dashboard-query',
    router: dashboardQueryROutes,
    note: '首页统计',
    guards: [{ at: '', loginOnly: true, reason: '首页统计为只读聚合且已按当前身份取数,历史口径仅需登录' }],
  },
];

// 拼接挂载全路径:at 为空即整前缀,否则前缀 + 子路径(与迁移前 index.js 里手写的字符串逐字一致),
function buildMountPath(path, at) {
  if (!at || at === '') {
    return path;
  }
  return path + at;
}

// 校验单个守卫项的口径合法性:注册表是安全配置的唯一事实来源,写法歧义(如同时给 menu 与 anyMenu、
// loginOnly 不给理由)必须在启动时立刻炸出来,而不是等到线上少了一道鉴权才发现 20261021 新增,
function assertGuardEntry(entry, guard) {
  const label = `${entry.path}${guard.at || ''}`;
  // 口径合法组合:page 级权限(menu / anyMenu 二选一)可与 platformOnly 叠加(如取消销售需“仅平台管理员
  // 且具备菜单权限”);loginOnly 与任何权限口径互斥(否则豁免意图不明),
  const hasMenu = Boolean(guard.menu);
  const hasAnyMenu = Boolean(guard.anyMenu);
  if (hasMenu && hasAnyMenu) {
    throw new Error(`路由注册表守卫配置错误(${label}):menu 与 anyMenu 不能同时声明`);
  }
  if (guard.loginOnly && (hasMenu || hasAnyMenu || guard.platformOnly)) {
    throw new Error(`路由注册表守卫配置错误(${label}):loginOnly 不得与权限口径同时声明`);
  }
  const hasPermission = hasMenu || hasAnyMenu || Boolean(guard.platformOnly);
  if (!hasPermission && !guard.loginOnly) {
    // 允许“纯归属校验”的守卫项(无权限字段),但必须锁定具体子路径,否则等于整前缀无权限声明,
    if (!guard.ownership || !guard.at) {
      throw new Error(`路由注册表守卫配置错误(${label}):无权限口径的守卫必须带 ownership 且指定非空 at`);
    }
  }
  if (guard.queryDetail && !guard.menu) {
    throw new Error(`路由注册表守卫配置错误(${label}):queryDetail 必须搭配 menu 使用`);
  }
  if (guard.openPaths && !guard.menu) {
    throw new Error(`路由注册表守卫配置错误(${label}):openPaths 必须搭配 menu 使用`);
  }
  if (guard.loginOnly && !guard.reason) {
    throw new Error(`路由注册表守卫配置错误(${label}):loginOnly 豁免必须写明 reason`);
  }
  if (guard.at && guard.at !== '' && !guard.at.startsWith('/')) {
    throw new Error(`路由注册表守卫配置错误(${label}):at 必须以 / 开头或为空串`);
  }
}

// 由守卫声明构造实际中间件链:区域归属排在权限之前(与迁移前挂载顺序一致),
// loginOnly 返回空链(全局登录闸门已在 index.js 完成)20261021 新增,
function buildGuardMiddlewares(guard) {
  const middlewares = [];
  if (guard.ownership) {
    middlewares.push(rbac.requireRegionOwnership(guard.ownership));
  }
  if (guard.platformOnly) {
    middlewares.push(rbac.requirePlatformAdmin);
  }
  if (guard.queryDetail) {
    middlewares.push(rbac.requireQueryPowerWithDetail(guard.menu));
  } else if (guard.anyMenu) {
    middlewares.push(rbac.requirePowerByAnyMenuName(...guard.anyMenu));
  } else if (guard.menu) {
    middlewares.push(rbac.requirePowerByMenuName(guard.menu, guard.openPaths));
  }
  return middlewares;
}

// 枚举一个 Express Router 内部真实声明的路由(路径 + 方法),用于把“注册表声明的守卫”与
// “路由实际提供的接口”逐条比对——否则在 room/save.js 里新增一个 POST 接口而忘了在注册表登记守卫,
// 静态看表仍然完全成立 20261021 新增,
function listRouterRoutes(router) {
  const stack = (router && router.stack) || [];
  return stack
    .filter((layer) => layer.route)
    .map((layer) => ({
      subPath: layer.route.path,
      methods: Object.keys(layer.route.methods).map((method) => method.toUpperCase()),
    }));
}

// 写接口口径以方法定为准(而非路径名正则):P0-1 已将破坏性 GET 全部改为 POST,
// 因此 POST/PUT/PATCH/DELETE/all 均视为写,只有 GET/HEAD/OPTIONS 算读 20261021 新增,
const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE', 'ALL'];

function isWriteMethod(methods) {
  return methods.some((method) => WRITE_METHODS.includes(method));
}

// 去掉末尾斜杠后比对路径(路由内部 router.post('/',…) 的 layer.path 就是 '/'),
function normalizePath(path) {
  const text = String(path || '');
  return text.length > 1 && text.endsWith('/') ? text.slice(0, -1) : text;
}

// 守卫挂载路径是否罩住该实际接口:完全相等,或作为其路径前缀(app.use('/api/room-save', mw)
// 同样拦得住 /api/room-save/insert,这与 Express 实际匹配行为一致),
function guardCoversRoute(guardMountPath, routeFullPath) {
  const guardPath = normalizePath(guardMountPath);
  const routePath = normalizePath(routeFullPath);
  return routePath === guardPath || routePath.startsWith(guardPath + '/');
}

function guardHasRealPermission(guard) {
  return Boolean(guard.menu) || Boolean(guard.anyMenu) || Boolean(guard.platformOnly);
}

// 注册表体检:返回全部配置违规描述(空数组即合格)。启动与测试都跑这一套断言,
// 目的是把“守卫必须先注册”与“写接口必须有权”从人工纪律上升为不可绕过的前置条件 20261021 新增,
function auditRouteRegistry(routes = ROUTES) {
  const violations = [];
  const mountedPaths = new Set();
  for (const entry of routes) {
    if (!entry.path || !entry.router) {
      violations.push(`条目缺少 path 或 router:${JSON.stringify({ path: entry.path, note: entry.note })}`);
      continue;
    }
    if (!entry.note) {
      violations.push(`条目缺少 note 说明(该接口做什么/权限口径来源):${entry.path}`);
    }
    if (mountedPaths.has(normalizePath(entry.path))) {
      violations.push(`同一前缀重复挂载:${entry.path}`);
    }
    mountedPaths.add(normalizePath(entry.path));
    const guards = Array.isArray(entry.guards) ? entry.guards : [];
    if (guards.length === 0) {
      violations.push(`条目未声明任何守卫(至少需显式 loginOnly + reason):${entry.path}`);
      continue;
    }
    for (const guard of guards) {
      try {
        assertGuardEntry(entry, guard);
      } catch (error) {
        violations.push(error.message);
      }
    }
    for (const route of listRouterRoutes(entry.router)) {
      const routeFullPath = normalizePath(entry.path + route.subPath);
      const covered = guards.filter((guard) => guardCoversRoute(buildMountPath(entry.path, guard.at), routeFullPath));
      if (covered.length === 0) {
        violations.push(`接口 ${route.methods.join('|')} ${routeFullPath} 未登记任何守卫,将无鉴权裸奔`);
        continue;
      }
      if (isWriteMethod(route.methods) && !covered.some((guard) => guardHasRealPermission(guard)) && !entry.loginOnlyWrites) {
        violations.push(`写接口 ${route.methods.join('|')} ${routeFullPath} 仅靠登录即可调用:要么补权限守卫,要么在条目里写明 loginOnlyWrites 理由`);
      }
    }
  }
  return violations;
}

// 单表驱动挂载:每个条目先挂守卫再挂业务路由,因此“守卫必须先注册”这一隐式约束
// 从此由代码保证而非人工纪律;条目之间互不干扰(Express 按各自前缀匹配)20261021 新增,
function mountApiRoutes(app, routes = ROUTES) {
  // 启动即体检:注册表是全站鉴权的唯一事实来源,配置歧义必须在启动时炸掉,而不是留到线上少一道鉴权,
  const violations = auditRouteRegistry(routes);
  if (violations.length > 0) {
    throw new Error(`路由注册表校验未通过:\n- ${violations.join('\n- ')}`);
  }
  for (const entry of routes) {
    for (const guard of entry.guards || []) {
      const middlewares = buildGuardMiddlewares(guard);
      if (middlewares.length > 0) {
        app.use(buildMountPath(entry.path, guard.at), ...middlewares);
      }
    }
    app.use(entry.path, entry.router);
  }
  return app;
}

module.exports = {
  ROUTES,
  mountApiRoutes,
  auditRouteRegistry,
  listRouterRoutes,
  isWriteMethod,
  guardCoversRoute,
  normalizePath,
  buildMountPath,
};
