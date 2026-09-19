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
