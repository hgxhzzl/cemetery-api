# cemetery-api

这是一个运行在 MySQL 上的 Express 接口项目。

## 环境要求

- Node.js 18+
- MySQL 8+
- npm

## 安装依赖

```bash
npm install
```

## 环境变量

项目使用 [config.js](config.js) 读取运行配置，支持的环境变量示例见 [.env.example](.env.example)。

```env
PORT=3000
CORS_ORIGIN=http://localhost:3002
JWT_SECRET=replace-with-random-secret
JWT_EXPIRES_IN=12h
MYSQL_HOST=your-mysql-host
MYSQL_PORT=3306
MYSQL_USER=your-mysql-user
MYSQL_PASSWORD=your-mysql-password
MYSQL_DATABASE=gm_data_000
```

安全约束（20260917 凭据收口）：`JWT_SECRET`、`MYSQL_HOST`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` **必须全部通过环境变量提供**，后端不再内置任何默认凭据，缺失任一直接拒绝启动（不再区分开发/生产环境，避免误连远端真实数据库）。本地开发请复制 `.env.example` 为 `.env` 后填写真实值。

## MySQL 初始化

项目使用 [gm_data_000.sql](gm_data_000.sql) 作为初始化脚本。脚本现在会显式执行 `CREATE DATABASE IF NOT EXISTS gm_data_000` 和 `USE gm_data_000`，因此可直接导入。

如果你在本机已经能连上该库，可以直接执行：

```bash
npm run db:init:mysql
```

这个脚本会读取当前环境变量并执行 [gm_data_000.sql](gm_data_000.sql)。

## 数据库迁移

历史迁移脚本（登录态表 login_session、字段/权限/菜单修补等）均已在线上执行完毕并合入 [gm_data_000.sql](gm_data_000.sql)，scripts/ 下不再保留一次性迁移脚本。**新部署只需导入 [gm_data_000.sql](gm_data_000.sql) 即可获得完整最新结构**，无需执行额外迁移。

后续如引入新的模板库结构变更，再按需新增幂等迁移脚本。

### 20261021 三轮：下线销售/下葬/联系人登记页（存量库需执行一次）

墓区销售（103102）、墓区下葬（103103）、墓位联系（103105）三个登记页已由「墓位业务」（103101）的购墓人/下葬者/联系人形态取代，代码侧同步删除了 `/api/{sale,buried,contacts}-save`、`/api/{sale,buried,contacts}-delete` 六个接口与对应前端页面（三个 `-query` 前缀保留，墓位业务详情聚合与查询统计页仍依赖它们）。

`menu` / `account_power` / `operator_power` 都是模板库 `gm_data_000` 里的全局表，**存量库执行一次即覆盖全部租户**：

```sql
DELETE FROM gm_data_000.menu           WHERE id      IN ('103102', '103103', '103105');
DELETE FROM gm_data_000.account_power  WHERE idMenu  IN ('103102', '103103', '103105');
DELETE FROM gm_data_000.operator_power WHERE idMenu  IN ('103102', '103103', '103105');
```

发布顺序必须**先执行上面的 SQL，再（或同时）发前端**：前端路由唯一来源是菜单接口，若菜单行还在而页面组件已删，`utils/route` 的动态导入只能回落成“菜单能点、页面空白”的静默失败。业务数据表 `sale` / `buried` / `contacts` 不受影响，历史数据继续由墓位业务页与 105101/105102/105104 三个查询页读写。

### 20261023：下线墓区预定登记页（存量库需执行一次）

墓区预定（103104）已由「墓位业务」（103101）卡片上的「预定期」入口承接（预定新建/修改/删除一并在该页完成），代码侧同步删除了 `/api/reserve-save`、`/api/reserve-delete` 与前端 `pages/reserve` 页面（`/api/reserve-query` 保留，墓位详情聚合仍依赖它）。

推荐直接运行幂等下线脚本（同时会校验并补齐 103101 菜单模板中的 `reserve` 功能动作）：

```bash
cd cemetery-api
npm run db:offline-reserve-menu
```

脚本等价于下面三条 SQL（`menu` / `account_power` / `operator_power` 都是模板库 `gm_data_000` 的全局表，存量库执行一次即覆盖全部租户）：

```sql
DELETE FROM gm_data_000.menu           WHERE id     = '103104';
DELETE FROM gm_data_000.account_power  WHERE idMenu = '103104';
DELETE FROM gm_data_000.operator_power WHERE idMenu = '103104';
```

发布顺序同样是**先执行脚本，再（或同时）发前端**：否则已开通 103104 的租户会在侧边栏看到入口，点进去指向已删除的页面。`reserve` 业务表不受影响，历史预定记录仍由墓位业务页读取。

### 20261023：移除墓位业务的默认业务形态权限行（存量库需执行一次）

操作员权限页「墓位业务」功能矩阵里的“墓位业务”一行来自 `menu.powerConfig` 的 `business` 键，但该形态（默认落 `graveplotbusiness` 表）在前端没有入口、也没有任何可配按钮，已从模板与种子中移除。

推荐直接运行幂等脚本（同时清理 `operator_power.powerConfig` 里已授予的 `business` 键；删空保留 `{}` 全禁，不会回退成 NULL 全放行）：

```bash
cd cemetery-api
npm run db:remove-business-function
```

脚本等价于把 `gm_data_000.menu` 中 `gravePlotBusiness` 模板的 `business` 键删掉，并清理各 `operator_power` 行的同名授权键。执行后**重启后端**（启动时加载 `menu.powerConfig` 模板），权限页刷新即不再显示该行；其余功能（销售/下葬/备注/预定/联系人/安葬证）的配置与授权不受影响。

### 20261023：去掉安葬证的“新建”权限（存量库需执行一次）

安葬证设置（`certificate`）只有一个“确认提交”，首次设置与后续修改共用同一次保存，权限页不再提供“新建”勾选，模板只保留 `modify`；首次保存由后端 `gravePlotBusiness-save/update` 在 `idCert=0` 时回落到插入，前端也统一提交到修改入口。

```bash
cd cemetery-api
npm run db:remove-certificate-create
```

脚本幂等：从 `menu.powerConfig.gravePlotBusiness.certificate` 中过滤掉 `create`，并清理各 `operator_power.powerConfig` 已授予的 `certificate.create`（`certificate` 动作因此变空时删除该功能键，整体删空保留 `{}` 全禁）。执行后**重启后端**，权限页刷新即只剩安葬证的“修改”勾选。

建库行为说明：业务库由 `account-save/createDataBase` 从模板库动态对齐创建（`information_schema` 读取表/视图，业务表 `CREATE TABLE ... LIKE`，全局表不复制）；同名库已存在时返回 409 拒绝重建，不再执行 `DROP DATABASE`。

## 启动项目

```bash
npm run start
```

或：

```bash
node index.js
```

默认监听端口：`3000`

## 进程守护（PM2）

生产环境建议使用 PM2 保活并开机自启：

```bash
npm install -g pm2
pm2 start index.js --name cemetery-api
pm2 save       # 保存进程列表
pm2 startup    # 生成开机自启脚本(按提示执行输出的命令)
```

常用运维命令：

```bash
pm2 logs cemetery-api     # 实时日志
pm2 restart cemetery-api  # 重启
pm2 status                # 进程状态
```

说明：登录态已持久化到 `gm_data_000.login_session`，重启/多实例不丢登录态；但连接池上限 20 且无共享内存状态，多实例部署前需评估数据库连接数与负载。

## 日志与排障（20261022 三轮 P2-7 成文）

后端一律写 stdout/stderr，**不自建文件与轮转**：日志落盘、按天切割、过期清理交给 pm2（`pm2-logrotate`）或容器日志驱动。因此**进程重启即丢控制台历史**，长期留存只能靠 pm2-logrotate 或容器日志驱动（二选一），不要指望 `node index.js` 直跑的输出可回溯。

四类日志行**行首都带同一个请求关联号** `[reqId]`，这是把它们串起来的唯一线索：

| 行形态 | 触发条件 | 出处 |
|------|------|------|
| `[ISO时间] [reqId] GET /api/room-query/region 200 13ms` | 每个请求的访问日志 | [httpDefaults.js](httpDefaults.js) `requestLog` |
| `[ISO时间][warn] [reqId] POST ... 403 9ms` | 响应状态码 ≥ 400 自动升为 warn 行 | 同上 |
| `[ISO时间][warn][slow-request] [reqId] ...` | 整条链路耗时 ≥ `SLOW_REQUEST_MS`（默认 3000） | 同上 |
| `[slow-query][reqId] <tag> 823ms SELECT ...` | 单条语句 ≥ `SLOW_QUERY_MS`（默认 500），语句截断 200 字符 | [database.js](database.js) `markSlowQuery` |
| `[unhandledRejection][reqId] <堆栈>` | async handler 抛出的 rejection（Express 4 不捕获），并尽力补发 500 | [index.js](index.js) |

关联号规则：入站带合法 `X-Request-Id` 时**沿用**（把 nginx 与后端日志接成同一条时间线），否则生成 base36 短号；无论哪种都回写响应头 `X-Request-Id`，所以**前端报障时只要引用该号**就能在后端定位到这一次操作的全部日志行（含被挡的 403 原因行）。

常用命令（服务器）：

```bash
pm2 logs cemetery-api --lines 200          # 实时跟日志(out + error 两个流都会出)
grep -F "[mj3k1a9]" ~/.pm2/logs/cemetery-api-out.log ~/.pm2/logs/cemetery-api-error.log   # 按关联号取整条链路
grep "\[warn\]" ~/.pm2/logs/cemetery-api-error.log | tail -50   # 只看 4xx/5xx 与慢请求行
grep "\[slow-query\]" ~/.pm2/logs/cemetery-api-out.log | tail -30  # 缺索引的语句候选清单
```

排查顺序建议：先按 reqId 取到这一次操作的访问行与状态码 → 若是 5xx/慢请求再看同一次的 `[slow-query]` 行定位语句 → 只有堆栈没有 reqId 的行说明发生在请求上下文之外（启动期/定时器），按时间戳对齐。

隐私与调参口径：访问日志的 URL 走 `maskRequestTarget` 脱敏——参数名命中 `phone|mobile|password|pwd|idcard|name|account|contact|user` 或值形似手机号时只留前 3 后 4；慢语句日志**只记 SQL 不记参数值**；`region` 等业务标识原样保留以便定位。可调环境变量：`SLOW_REQUEST_MS`(3000)、`SLOW_QUERY_MS`(500)、`DB_POOL_LIMIT`(20)、`DB_POOL_QUEUE_LIMIT`(200)、`COUNT_CACHE_MS`(10000)。日志级别不做开关：warn 行靠 `[warn]` 标记区分，不引入日志框架。

## 部署护栏：健康探针与索引补齐（20261022 三轮 P2-6 / P1-5）

### 健康探针 `GET /health`

免鉴权、不读业务数据、**不做任何数据库查询**（纯进程存活探测，避免高频探活反过来拖垮 DB），因此挂在鉴权与响应信封中间件**之前**，响应也**不套** `{code}` 业务信封——运维按 HTTP `200` 判活即可。返回体：

```jsonc
{
  "status": "ok",
  "uptimeSeconds": 3821,          // 进程存活秒数
  "version": "cemetery-api@1.0.0",
  "node": "v22.x",
  "timestamp": "2026-10-22T...Z",
  "pool": { "total": 8, "idle": 6, "borrowed": 2, "waiting": 0 },  // 连接池占用/排队(mysql2 内部计数)
  "timeouts": { "requestTimeout": 45000, "headersTimeout": 12000, "keepAliveTimeout": 4000 }  // 启动时 applyServerTimeouts 回读的生效值
}
```

```bash
curl -s http://127.0.0.1:3000/health        # 期望 200 + 上面结构(不带 Authorization)
```

nginx / PM2 / 外部监控可直接对该路径做 `200` 探活；`pool.waiting` 持续大于 0 说明连接池被占满（配合 `[slow-query]` 行定位缺索引语句）。

### 索引补齐（务必逐库执行）

[gm_data_000.sql](gm_data_000.sql) 的 `KEY` 定义**只对新库生效**；新租户表由 [account/save.js](account/save.js) 的 `CREATE TABLE ... LIKE gm_data_000.<t>` 复制——**模板库补齐之后新开的租户才带索引，脚本落地前已上线的存量租户库不会被自动 touch**。因此每次升级结构后，在服务器对**全部租户库**跑一次幂等补齐：

```bash
npm run db:indexes:all      # = node scripts/add-indexes.js --all-tenants，逐个 gm_data_% 库补同一批二级索引 + 两处唯一约束
npm run db:indexes          # 仅补 .env 指定的单库(通常是模板库)
```

要点：

- 每项先查 `information_schema` 再决定是否 `ALTER`，**重复运行安全**；全局表（`operator/menu/account…`）在租户库不存在时会自动跳过，不会报错中断。
- `uk_room_region_serial`（区内编号唯一）、`uk_room_coord`（活动墓位坐标唯一）两处**唯一约束**遇到存量重复编号/重复坐标时**刻意不静默改数据**：改为把全量清单写到 `scripts/add-indexes-duplicates.txt`（已在 .gitignore，含 db/region/编号/坐标/冲突 idRoom），运维据清单人工改号或软删多余行后**重跑本脚本**才会建上唯一索引。
- 首次上线该修复前，建议先在测试库跑一次 `--all-tenants`，把是否已存在重复编号/重复坐标的告警清单确认干净（或据此安排人工并号），再在生产执行。

## 接口烟测

项目现在带了一个最小 smoke test 脚本，用来快速确认登录、菜单、几个查询接口，以及 `room-save` 的非法坐标拦截仍然正常。

```bash
npm run smoke
```

默认还会覆盖：

- 详情查询的 `404 数据不存在!`
- 非法详情参数的 `400`
- `operator-save/password` 在旧密码错误时返回 `{ code: 0, data: 0 }`

可选环境变量：

- `SMOKE_BASE_URL`：默认 `http://127.0.0.1:3000`
- `SMOKE_USERNAME`：默认 `13766891959`
- `SMOKE_PASSWORD`：默认 `1234`
- `SMOKE_RUN_MUTATION=1`：额外执行一条事务型成功检查，会对 `idAccount=100` 做一次同值更新，仅用于验证事务成功响应链路

## 自动化测试与 CI

```bash
npm test            # 单元 + 集成测试(mock 连接池,无需真实 MySQL)
npm run test:syntax # 全量 JS 语法检查
```

测试覆盖：参数化语句函数、聚合 SQL、sale/buried/reserve/transferOut/adminfee 事务联动语句序列、登出接口等 16 项。GitHub Actions（[.github/workflows/ci.yml](.github/workflows/ci.yml)）在 push/PR 时执行 `npm ci` + `npm test` + `npm run test:syntax`。

## 已验证的本地接口链路

以下链路用于 MySQL 环境回归：

- `POST /api/login`
- `POST /api/login/logout`
- `GET /api/get-menu-list-i18n`
- `GET /api/operator-query/id?idOperator=100`
- `GET /api/account-query?idAccount=100`
- `GET /api/room-query/idList?idRoom=1000001`
- `GET /api/contract-query`
- `POST /api/account-save/update`
- `POST /api/room-save/update`
- `POST /api/operator-save/power`
- `POST /api/accountPower-save/power`
- `GET /api/park-query/region`
- `GET /api/taginfo-query/tagset`

## 默认测试登录

当前本地回归使用的登录账号仍然是：

- `username: 13766891959`
- `password: 1234`

登录成功后，后续接口通过 `Authorization` 请求头传递返回的 Bearer token。

## 当前代码约定

数据库访问集中在 [database.js](database.js)：

- 使用 `mysql2/promise` 连接 MySQL
- 保留接近旧代码风格的 `query(sql, params, callback)` 适配层
- 兼容历史遗留的 `$1/$2/...` 形式占位符并在运行时转换为 `?`
- 提供 `withTransaction(sqlList)` 事务封装

公共响应和校验 helper 集中在 [public.js](public.js)：

- `parseNumericParam`
- `handleQueryError`
- `respondList`
- `respondDetail`
- `respondAffectedRows`
- `respondTransaction`
- `getInsertStatement` / `getUpdateByIdStatement` / `getUpdateByConditionStatement` / `getDeleteByIdSql`：参数化语句生成（入口浅拷贝，不修改调用方对象）
- `getRoomContactsSyncSql` / `getRoomDeceasedSyncSql`：room 聚合字段同步

登录态由 [loginState.js](loginState.js) 持久化到 `gm_data_000.login_session` 表（phone 主键），重新登录刷新 exp、登出删除记录使旧 token 立即失效。

## 授权模型（20260917 越权收口）

统一授权守卫集中在 [rbac.js](rbac.js)：

- **平台管理员**：`isAccount=1` 且 `dataBaseName='gm_data_000'` 的账户（isAccount 由登录时写入 token payload），可访问全部接口，不受菜单动作限制。
- **全局管理接口**（account 增删改查、accountPower、createDataBase）仅平台管理员可调用，非管理员返回 403。
- **租户约束**：operator 的 update/password/power/delete 与查询详情，非平台管理员仅可操作/查看本租户（token 的 dataBase）对象，跨租户返回 403；改密前先做租户校验，避免跨租户暴力验证他人密码。
- **RBAC 菜单动作**：业务接口在 [index.js](index.js) 注册时挂 `requirePowerByMenuName(菜单name)`，运行时查 gm_data_000.menu 表按 name 动态解析当前 idMenu 后校验 `operator_power.useMenu`；平台管理员短路放行，无权限返回 403。菜单 id 会因显示顺序调整而变化，代码一律用稳定 name（room/sale/buried/reserve/contacts/transferOut/adminfee/managementPeriod/contract/park/tagInfo/operator/saleQuery/buriedQuery/adminfeeQuery/contactsQuery），不要写死菜单 id；动作 → `operator_power` 列映射为 menu/create/modify/delete → useMenu/useCreate/useModify/useDelete，当前仅 useMenu=1 即视为具备全部操作权限。
- 旧 token 无 isAccount 字段时安全默认非平台管理员，需重新登录获取新 token。

## 响应与错误码约定（现状）

当前接口存在以下响应形态，新代码按下表使用：

| 形态 | 场景 | 来源 |
|------|------|------|
| `{ code: 0, data: { list, total? } }` | 列表/详情/事务成功 | `respondList` / `respondDetail` / `respondTransaction` |
| `{ code: 0, affectedRows }` | 更新/删除影响行数 | `respondAffectedRows` |
| `{ error: '...' }` | 参数错误(400)、数据不存在(404)、服务错误(500) | 参数校验与 `handleQueryError` |
| `{ code: 401, message }` | 登录失败(历史遗留) | `POST /api/login` |
| `{ error: '无权限...' }` | 越权访问(403):非平台管理员调全局接口、跨租户操作、缺菜单动作权限 | [rbac.js](rbac.js) 与租户校验 |

约定：`code: 0` 恒为成功；新增代码优先复用 public.js 响应 helper，错误场景沿用 `{ error }`；与前端完成协商前不强制统一历史形态，避免破坏既有契约。

### 收敛路线（已评估，待与前端协商）

前端（cemetery-admin）请求拦截器（`src/utils/request/index.ts` 第 50-55 行）仅识别 `code === 0`：成功返回 `data.data`；其余一律 `throw new Error('请求接口错误, 错误码: ' + code)`，不读取 `message`/`error` 字段。因此当前 `{ error }` 形态的错误文案不会在前端展示。

建议收敛方向：

1. 前端 `transformRequestHook` 报错分支改为优先透传后端文案：`throw new Error(data.message || data.error || ...)`；登录接口（`src/api/login.ts`）已独立处理，可不动。
2. 后端错误形态逐步统一为 `{ code: 非0, message }`（与 401 历史形态一致），`{ error }` 仅作过渡保留。

两端改动互不依赖、均向后兼容，可与前端确认后分步实施。

## 回归注意事项

- 带中文参数的接口回归，优先用 `node -e` + `fetch`。
- 不要优先用 PowerShell 的 `Invoke-RestMethod` 测中文参数，编码容易污染 `park`、`region` 等值。
- 主键和坐标参数仍建议先做数字校验，避免把空字符串和非法值漏到数据库层。

## 目录概览

- [index.js](index.js)：应用入口和路由注册
- [config.js](config.js)：运行配置
- [database.js](database.js)：MySQL 访问层
- [public.js](public.js)：共享 helper
- [loginState.js](loginState.js)：登录态会话管理
- [requestContext.js](requestContext.js)：请求级响应上下文
- [scripts/](scripts/)：SQL 迁移脚本、语法检查等辅助脚本
- [tests/](tests/)：单元与集成测试

## 现阶段限制

- 部分 query 模块仍为 callback 风格，与 async/await 新代码混用，渐进迁移中。
- 业务 SQL 已全部参数化；表名/库名由服务端拼装（非用户输入），不再存在值内联的字符串拼接 SQL。
- 视图（`v_region_park`）的 CREATE VIEW 语句在 createDataBase 中显式维护，模板库视图变化需人工同步（已有缺失告警兜底）。
- 单实例部署为主（连接池 limit 20），暂无进程守护/多实例编排说明。
