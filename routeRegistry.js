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
// 销售取数路径(墓区销售登记页 103102 已于三轮下线,本前缀只保留墓位业务详情聚合与
// 销售查询页需要的按墓位取数,新建/修改/作废统一走 gravePlotBusiness 入口),
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
// 下葬取数路径(墓区下葬登记页 103103 已于三轮下线,仅保留详情聚合取数),
const buriedQueryROutes = require('./buried/query');
// 迁出路径
const transferOutQueryROutes = require('./transferOut/query');
const transferOutSaveROutes = require('./transferOut/save');
const transferOutDeleteROutes = require('./transferOut/delete');
// 管理费收款路径
const adminfeeQueryROutes = require('./adminfee/query');
const adminfeeSaveROutes = require('./adminfee/save');
const adminfeeDeleteROutes = require('./adminfee/delete');
// 墓位联系人取数路径(墓位联系登记页 103105 已于三轮下线,仅保留详情聚合取数),
const contactsQueryROutes = require('./contacts/query');
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
// 新建(/insert)同样挂 ownRoomScope:新记录尚无主键可查,但 body 里必带目标墓位 idRoom,
// 归属即按该墓位的 region 判定(与 /update 同口径);前端可选墓位已由区域名单收窄
// (墓位列表 region 等值 + 下拉 filterByOperatorRegions + 显式 region 参数由 requireRegionScope 拦),
// 因此本道闸只封住绕过界面直调接口的跳区代录,正常操作零行为变化(审查修复 20261021 三轮 P1-2),
const ownRoomScope = { table: 'room', idParam: 'idRoom' };
const ownTransferOutScope = { table: 'transfer_out', idField: 'idTransfer', idParam: 'idTransfer' };
const ownAdminfeeScope = { table: 'adminfee', idField: 'idAdminfee', idParam: 'idAdminfee' };

// 守卫声明字段含义:
//   menu         - 需具备该菜单的 useMenu(整前缀或 at 指定的子路径)
//   openPaths    - 配合 menu:该前缀下的这些子路径仅需登录(参照数据不能要求页面菜单权限)
//   anyMenu      - 任一指命菜单具备 useMenu 即放行(业务页与对应查询页共用同一接口)
//   queryDetail  - 配合 menu 或 anyMenu:查询前缀专用口径,详情取数路径按“任一详情页菜单”放行
//                  (详情路径名单见 rbac.DETAIL_AGGREGATE_ROUTES,本表与之双向对账,详见 auditRouteRegistry) 20261021 二轮 P1-3,
//   platformOnly - 仅平台管理员(gm_data_000 租户账户)
//   ownership    - 主键记录的区域归属校验;可单独出现(子路径归属校验,权限由同一条目的整前缀守卫担当),
//                  也可与上面任一权限同时出现
//   loginOnly    - 显式声明“仅需登录”,必须同时给出 reason(测试据此判定为有意豁免而非漏写)
// 条目字段 innerGuards:声明“该条目的 router 文件内部自己 router.use 了一道守卫”(名称表见 INNER_GUARD_KINDS)。
// 账户/账户权限五个 router 一直在文件顶部 router.use(rbac.requirePlatformAdmin),注册表条目却写着 loginOnly ——
// 同一个接口存在两套彼此不可见的口径:删掉文件里那一行、或改掉条目里那一行,语法与用例都不会报错,
// 现要求内部守卫必须在条目里显式登记,并由 router.stack 内省做双向对账(审查修复 20261021 二轮 P2-11),
// 条目字段 loginOnlyWrites:声明“该条目的写接口(POST/PUT/DELETE)历史上就只要求登录”,
// 必须写明理由;未声明的条目内出现未登记守卫的写接口会在启动时被 mountApiRoutes 拒绝,
// 这样“新增接口漏一行守卫”从线上的无鉴权裸奔变成启动即失败(审查修复 20261021 P1-4),
// 条目字段 globalScope:声明“该条目读写的是 gm_data_000 里的全局共享表(不按租户划分,通常也没有 region 列)”,
// 值填表名(如 gm_data_000.contract)。这类接口只要对租户开放一次,就是跨租户读写全平台数据,而“没给租户
// 勾该菜单”只是数据库里的一行配置,改一次配置即可绕过,故必须由代码兜底:体检要求条目存在一条整前缀
// platformOnly 守卫,并禁止再挂 ownership(全局表无从查 region,挂了也只会静默放行)。
// 「用户管理」子树(101101 账户信息 / 101102 合同列表)与设备白名单均属此类(审查修复 20261021 三轮 P1-1),
// 条目字段 insertOwnershipExempt:声明“本条目的 /insert 确实不能按区域归属收窄”,必须写明理由。
// 体检规则是“同条目 /update 已挂 ownership 时,/insert 不得空着”(三轮 P1-2),但批量建位的
// /insert 无主键可查、region 就在 body 里,属合法例外;声明了理由却已无需要豁免的 /insert 同样会报错,
// 避免理由与实际实现漂移,
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
    globalScope: 'gm_data_000.device',
    guards: [{ at: '', platformOnly: true }],
  },

  // ==================== 合同(菜单 101102 合同列表,属「用户管理」子树,仅 gm_data_000 平台账户) ====================
  // contract 表在 gm_data_000 全局库,且查询/更新语句不带任何租户条件(contract/query.js 的整库 SELECT、
  // contract/save.js 的按 idContract 直改),此前条目只校验菜单权限——等价于“哪个租户被勾上合同列表,
  // 哪个租户就能读改全平台所有租户的合同”;现按同子树的 account/accountPower 口径收口为仅平台管理员,
  // 种子平台账户即 isAccount=1 + dataBaseName=gm_data_000(rbac.isPlatformAdmin 判据),故对既有可用者零行为变化,
  {
    path: '/api/contract-save',
    router: contractSaveROutes,
    note: '合同新建/修改(仅平台管理员)',
    globalScope: 'gm_data_000.contract',
    guards: [
      { at: '', platformOnly: true },
      { at: '/insert', menu: 'contract' },
      { at: '/update', menu: 'contract' },
    ],
  },
  {
    path: '/api/contract-query',
    router: contractQueryROutes,
    note: '合同查询(仅平台管理员;contract 在 gm_data_000 全局库无租户与 region 列,不做区域归属)',
    globalScope: 'gm_data_000.contract',
    guards: [{ at: '', platformOnly: true }, { at: '', menu: 'contract' }],
  },
  {
    path: '/api/contract-delete',
    router: contractDeleteROutes,
    note: '合同删除(仅平台管理员)',
    globalScope: 'gm_data_000.contract',
    guards: [{ at: '', platformOnly: true }, { at: '', menu: 'contract' }],
  },

  // ==================== 账户(租户开户与资料:仅平台管理员) ====================
  // 权限口径实现在 account/*.js 文件顶部的 router.use(rbac.requirePlatformAdmin)(20260917 越权收口),
  // 注册表此前把它记成 loginOnly,与实现不符;现按真实口径登记并由 innerGuards 对账钉住(二轮 P2-11),
  // 双写(条目守卫 + router 内部)是有意的:行为不变,但口径在注册表里可见且互相对账,与 /api/device 同一手法,
  {
    path: '/api/account-save',
    router: accountSaveROutes,
    note: '账户新建/修改/建库(仅平台管理员)',
    globalScope: 'gm_data_000.account',
    innerGuards: ['platformAdmin'],
    guards: [{ at: '', platformOnly: true }],
  },
  {
    path: '/api/account-query',
    router: accountQueryROutes,
    note: '账户查询(仅平台管理员)',
    globalScope: 'gm_data_000.account',
    innerGuards: ['platformAdmin'],
    guards: [{ at: '', platformOnly: true }],
  },
  {
    path: '/api/account-delete',
    router: accountDeleteROutes,
    note: '账户注销(级联删除该租户操作员与授权,仅平台管理员)',
    globalScope: 'gm_data_000.account',
    innerGuards: ['platformAdmin'],
    guards: [{ at: '', platformOnly: true }],
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
    insertOwnershipExempt: '新建墓位尚无主键可反查 region,而 body 直接携带 region,已由全局 requireRegionScope 按名单拦下(不在名单即 403)',
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

  // ==================== 销售取数(供墓位业务详情聚合与销售查询页) ====================
  // 墓区销售登记页(菜单 103102)已于三轮下线,其新建/修改/作废接口随之从注册表摘除:
  // 那条旁路既没有预定闸门也不派生下葬记录,与新页口径分叉(三轮 P1-3),销售写操作只保留
  // /api/gravePlotBusiness-save 与 /api/gravePlotBusiness-cancelSale 两个入口,
  // 本前缀只留详情取数,菜单改挂存活的「墓区销售查询」(105101)作为非详情路径的兜底口径,
  {
    path: '/api/sale-query',
    router: saleQueryROutes,
    note: '销售记录取数(详情聚合;登记页已下线)',
    guards: [{ at: '/get-by-room', ownership: ownRoomScope }, { at: '', menu: 'saleQuery', queryDetail: true }],
  },

  // ==================== 墓位业务(菜单 103101) ====================
  {
    path: '/api/gravePlotBusiness-save',
    router: gravePlotBusinessSaveROutes,
    note: '墓位业务新建/修改',
    guards: [
      { at: '/insert', menu: 'gravePlotBusiness', ownership: ownRoomScope },
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

  // ==================== 下葬取数(供墓位业务详情聚合与下葬查询页) ====================
  // 墓区下葬登记页(菜单 103103)已下线:单条下葬记录的增删改均走 /api/gravePlotBusiness-{save,delete},
  // 旧旁路不维护墓位锁定/联系人同步/管理期限重排,与新页双写只会让两套口径继续分叉,
  {
    path: '/api/buried-query',
    router: buriedQueryROutes,
    note: '下葬记录取数(详情聚合;登记页已下线)',
    guards: [{ at: '', menu: 'buriedQuery', queryDetail: true, ownership: ownRoomScope }],
  },

  // ==================== 墓位迁出(菜单 103106) ====================
  {
    path: '/api/transferOut-save',
    router: transferOutSaveROutes,
    note: '迁出新建/修改',
    guards: [
      { at: '/insert', menu: 'transferOut', ownership: ownRoomScope },
      { at: '/update', menu: 'transferOut', ownership: ownRoomScope },
    ],
  },
  {
    path: '/api/transferOut-query',
    router: transferOutQueryROutes,
    // 详情放行(二轮 P1-3):前端 useRoomDetail 并行拉的第七类即本前缀裸 /(按墓位查迁出记录),
    // 此前只登记了 anyMenu 严格口径,仅有其它墓位菜单的操作员点详情会因这一路 403 使整个详情打不开;
    // 同时补上 ownRoomScope:裸 / 只按 idRoom 取数,原口径缺归属校验,限定区域的操作员可读它区墓位的迁出记录,
    note: '迁出记录取数(业务页与迁出查询页共用,含墓位详情迁出卡片)',
    guards: [{ at: '', anyMenu: ['transferOut', 'transferOutQuery'], queryDetail: true, ownership: ownRoomScope }],
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
      { at: '/insert', menu: 'adminfee', ownership: ownRoomScope },
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

  // ==================== 联系人取数(供墓位业务详情聚合与联系人查询页) ====================
  // 墓位联系登记页(菜单 103105)已下线:联系人的新增/修改/删除均走 /api/gravePlotBusiness-{save,delete}(type=contacts),
  // 旧旁路不做同墓位重名拦截也不同步 room.contacts 聚合,
  {
    path: '/api/contacts-query',
    router: contactsQueryROutes,
    note: '联系人取数(详情聚合;登记页已下线)',
    guards: [{ at: '', menu: 'contactsQuery', queryDetail: true, ownership: ownRoomScope }],
  },

  // ==================== 墓位预定(菜单 103104) ====================
  {
    path: '/api/reserve-save',
    router: reserveSaveROutes,
    note: '预定新建/修改',
    guards: [
      { at: '/insert', menu: 'reserve', ownership: ownRoomScope },
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
    note: '账户(租户)菜单权限保存(仅平台管理员)',
    globalScope: 'gm_data_000.account',
    innerGuards: ['platformAdmin'],
    guards: [{ at: '', platformOnly: true }],
  },
  {
    path: '/api/accountPower-query',
    router: accountPowerQueryROutes,
    note: '账户菜单权限读取(仅平台管理员)',
    globalScope: 'gm_data_000.account',
    innerGuards: ['platformAdmin'],
    guards: [{ at: '', platformOnly: true }],
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
  if (guard.queryDetail && !guard.menu && !guard.anyMenu) {
    throw new Error(`路由注册表守卫配置错误(${label}):queryDetail 必须搭配 menu 或 anyMenu 使用`);
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
    middlewares.push(rbac.requireQueryPowerWithDetail(guard.menu || guard.anyMenu));
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

// 路由内部守卫的名称表(审查修复 20261021 二轮 P2-11):条目 innerGuards 写的是左边这种与实现无关的口径名,
// 右边是它在 rbac 里的函数名;内省靠函数名比对(具名函数声明的 .name 不会被 require/导出搬运丢掉),
// 只涵盖 router.use(fn) 形态;handler 体内自行判定的写法(如 device.js 的 requireAdmin)不在栈上、检测不到,
// 那类口径必须由条目自己的 guards 声明承担(本机制的局限,已在注释里如实写明),
const INNER_GUARD_KINDS = {
  platformAdmin: 'requirePlatformAdmin',
};
const INNER_GUARD_NAMES = new Set(Object.values(INNER_GUARD_KINDS));

// 内省一个 router 文件里自己 router.use 上去的守卫(返回已识别的口径名升序列表),
function listRouterInnerGuards(router) {
  const stack = (router && router.stack) || [];
  const kinds = new Set();
  stack.forEach((layer) => {
    if (layer.route) {
      return;
    }
    const handle = layer.handle;
    if (typeof handle !== 'function' || !INNER_GUARD_NAMES.has(handle.name)) {
      return;
    }
    Object.keys(INNER_GUARD_KINDS).forEach((kind) => {
      if (INNER_GUARD_KINDS[kind] === handle.name) {
        kinds.add(kind);
      }
    });
  });
  return [...kinds].sort();
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

// 详情聚合放行名单与注册表逐项对账(审查修复 20261021 二轮 P1-3):两张表任一侧单独改动都会造成口径不一致 ——
// 白名单登了前缀但该前缀没挂 queryDetail(详情仍打不开),或挂了 queryDetail 却无白名单条目(宽松口径泄向非详情路径),
// 其中“白名单指向未挂载前缀”需要全表视角,故仅在体检真实注册表整体时运行(测试注入的 fixture 清单不含这些前缀,不应误报),
// 反向两项逐条目即可判定,对 fixture 同样生效,保留给反向用例做“牙齿” 20261021 二轮调整,
function auditDetailAggregateRoutes(routes, mountedPaths, isFullRegistry) {
  const violations = [];
  const detailRoutes = rbac.DETAIL_AGGREGATE_ROUTES || [];
  const queryDetailPaths = new Set();
  for (const entry of routes) {
    for (const guard of entry.guards || []) {
      if (guard.queryDetail) {
        queryDetailPaths.add(normalizePath(entry.path));
      }
    }
  }
  const detailPrefixes = new Set(detailRoutes.map((rule) => normalizePath(rule.prefix)));
  if (isFullRegistry) {
    detailPrefixes.forEach((prefix) => {
      if (!mountedPaths.has(prefix)) {
        violations.push(`详情白名单指向未挂载的前缀:${prefix}`);
      }
      if (!queryDetailPaths.has(prefix)) {
        violations.push(`详情白名单前缀未在注册表登记 queryDetail 守卫:${prefix}`);
      }
    });
  }
  queryDetailPaths.forEach((prefix) => {
    if (!detailPrefixes.has(prefix)) {
      violations.push(`挂了 queryDetail 的前缀没有对应的详情白名单条目:${prefix}`);
    }
  });
  // 白名单里每个 prefix+path 必须真实存有一条 GET 路由,否则登记的是死路径(宽松口径永远不命中,排障时很难看出),
  detailRoutes.forEach((rule) => {
    const entry = routes.find((item) => normalizePath(item.path) === normalizePath(rule.prefix));
    if (!entry) {
      return;
    }
    const expectedPath = normalizePath(rule.prefix + rule.path);
    const hasRoute = listRouterRoutes(entry.router).some(
      (route) => route.methods.includes('GET') && normalizePath(entry.path + route.subPath) === expectedPath,
    );
    if (!hasRoute) {
      violations.push(`详情白名单条目没有对应的 GET 路由:${rule.prefix}${rule.path}`);
    }
  });
  return violations;
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
    // 路由内部守卫与条目 innerGuards 声明双向对账(二轮 P2-11):
    // router 里 router.use 了一道已知守卫而条目没写 → 权限口径在注册表(唯一事实来源)里隐形,
    // 条目写了却 router 里找不到 → 声明已与实际实现漂移(多半是内部那行被删了),两个方向都必须报错,
    const declaredInner = Array.isArray(entry.innerGuards) ? entry.innerGuards.map((kind) => String(kind)) : [];
    declaredInner
      .filter((kind) => !Object.prototype.hasOwnProperty.call(INNER_GUARD_KINDS, kind))
      .forEach((kind) => violations.push(`条目 ${entry.path} 声明了未知的 innerGuards:${kind}(名称表见 INNER_GUARD_KINDS)`));
    const actualInner = listRouterInnerGuards(entry.router);
    const undeclaredInner = actualInner.filter((kind) => !declaredInner.includes(kind));
    if (undeclaredInner.length > 0) {
      violations.push(`条目 ${entry.path} 的 router 内部存在未登记的守卫:${undeclaredInner.join(',')}(权限口径必须在注册表可见)`);
    }
    const ghostInner = declaredInner.filter((kind) => !actualInner.includes(kind));
    if (ghostInner.length > 0) {
      violations.push(`条目 ${entry.path} 声明的 innerGuards 在 router 内部并不存在:${ghostInner.join(',')}(口径已与实际实现漂移)`);
    }
    // 全局共享表入口对账(审查修复 20261021 三轮 P1-1):字段含义见条目字段 globalScope 说明——
    // “租户没被授该菜单”是数据层配置,改一行就能绕过;将其升为启动期硬约束,新登记一个全局表接口
    // 却忘收权限时直接启动失败,而不是等到线上发生跨租户读取才发现,
    if (entry.globalScope) {
      const scopeLabel = String(entry.globalScope);
      if (!guards.some((guard) => !guard.at && guard.platformOnly)) {
        violations.push(`条目 ${entry.path} 读写全局共享表 ${scopeLabel},却未按整前缀声明 platformOnly(全局表接口漏一道锁即是跨租户读写全平台数据)`);
      }
      guards
        .filter((guard) => guard.ownership)
        .forEach((guard) =>
          violations.push(
            `条目 ${entry.path}${guard.at || ''} 为全局共享表 ${scopeLabel},不得声明 ownership(全局表没有 region 列可查,区域归属校验只会静默放行)`,
          ),
        );
    }
    // 新建与修改的区域归属必须成对(审查修复 20261021 三轮 P1-2 的机器约束):二轮收口水平越权时
    // 只给 /update、/delete 挂了 ownership,/insert 集体漏着——“能改不能查”堵了,
    // “不能改但能给别区新增”还开着。四个业务条目已补齐,本规则保证以后新模块再漏时启动即失败,
    // 而不是靠人记住同一张表要改两处;全局表条目本就无 region 可查(上方已禁止 ownership),跳过,
    if (!entry.globalScope) {
      const ownedUpdateGuard = guards.find((guard) => /\/update$/.test(guard.at || '') && guard.ownership);
      const unownedInserts = guards.filter((guard) => /\/insert$/.test(guard.at || '') && !guard.ownership);
      const hasExempt = typeof entry.insertOwnershipExempt === 'string' && entry.insertOwnershipExempt.length > 0;
      if (ownedUpdateGuard && unownedInserts.length > 0 && !hasExempt) {
        unownedInserts.forEach((guard) =>
          violations.push(
            `条目 ${entry.path}${guard.at} 未声明 ownership,而同条目 ${ownedUpdateGuard.at} 已按区域归属收窄:跨区新建等于绕开同一道闸(确有豁免理由请写进条目字段 insertOwnershipExempt)`,
          ),
        );
      }
      // 反向对账:豁免理由不得长驻——一旦 /insert 补上了归属或条目本就无新建,理由就该跟着删掉,
      if (hasExempt && (unownedInserts.length === 0 || !ownedUpdateGuard)) {
        violations.push(`条目 ${entry.path} 声明了 insertOwnershipExempt 但已无需要豁免的 /insert(豁免理由已与实际实现漂移)`);
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
  // 详情聚合放行名单与注册表逐项对账(审查修复 20261021 二轮 P1-3):需要对全表视角的部分只在体检真实注册表时运行,
  // 其余反向对账对 fixture 清单也成立,详见 auditDetailAggregateRoutes 注释 20261021 新增,
  violations.push(...auditDetailAggregateRoutes(routes, mountedPaths, routes === ROUTES));
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
  // 导出供用例复用:详情聚合放行(P1-3)的矩阵用例必须跑注册表里真实的守卫条目,
  // 而不是在测试里重抄一遍“先归属后菜单”的组装顺序,否则测试只能证明自己, 20261021 二轮新增,
  buildGuardMiddlewares,
  // 导出供用例与审计脚本内省路由内部守卫(二轮 P2-11),
  listRouterInnerGuards,
  INNER_GUARD_KINDS,
};
