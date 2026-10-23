// menu.powerConfig 功能模板列幂等补齐与初始化脚本 20261023 权限模板入库改造新增:
// 功能级权限模板不再维护在代码目录里,统一存 gm_data_000.menu.powerConfig(JSON):
//   { "功能名": ["动作", ...] },单功能菜单的功能键 = 菜单名;gravePlotBusiness 一页多功能(按 type 归一)。
// 本脚本做两件事:1) 老库缺列时 ALTER TABLE 补列;2) 初始化/修复模板。
// 默认只填空值(powerConfig IS NULL)并修复形状非法的脏值(如误写成授权形状 {fn:{actions:{...}}},
// 这类值后端解析为 null,与 NULL 一样会让启动体检报“未纳入功能级管控”),绝不覆盖形状合法的既有模板;
// 确需整表重置时加 --force 显式覆盖。
// 后端启动时会从该列加载模板,列缺失/模板为空会直接影响功能级鉴权,故升级顺序:先跑本脚本,再发新后端。
require('dotenv').config({ quiet: true });

const mysql = require('mysql2/promise');
const config = require('../config');

const DB_NAME = 'gm_data_000';
const TABLE_NAME = 'menu';
const COLUMN_NAME = 'powerConfig';

// 12 个功能级菜单的初始模板(与 gm_data_000.sql 的 menu INSERT 保持一致;独立预定菜单 103104 已下线)。
// 单功能菜单由 operator_power 旧的 useCreate/useModify/useDelete/usePower 布尔列迁移而来;
// tagInfo/park/receiptConfig/cardColor 的整体保存按钮名为“设置提交”,动作键统一用 setting,
// 配置类菜单都是单表单整体保存,不拆假粒度。
// 只读查询菜单(saleQuery 等)与 LAYOUT 容器不做功能级管控,保持 NULL。
const MENU_POWER_TEMPLATES = {
  account: { account: ['create', 'modify', 'delete'] },
  contract: { contract: ['create', 'modify', 'delete'] },
  tagInfo: { tagInfo: ['setting'] },
  park: { park: ['setting'] },
  operator: { operator: ['create', 'modify', 'delete', 'power'] },
  receiptConfig: { receiptConfig: ['setting'] },
  cardColor: { cardColor: ['setting'] },
  gravePlotBusiness: {
    // 销售删除与取消销售是同一功能,按钮统一叫“删除”,动作键用 delete;cancelSale 已下线 20261023 调整,
    sale: ['create', 'modify', 'delete'],
    buried: ['create', 'modify', 'delete'],
    contacts: ['create', 'modify', 'delete'],
    reserve: ['create', 'modify', 'delete'],
    // 安葬证设置只保留 modify：首次保存也走修改入口，权限页不再提供“新建”勾选 20261023 调整,
    certificate: ['modify'],
    remark: ['modify'],
    // business(默认业务形态)在前端没有入口与可配按钮,权限页不再渲染该行,模板一并移除 20261023 调整,
  },
  room: { room: ['create'] },
  transferOut: { transferOut: ['create', 'modify', 'delete'] },
  adminfee: { adminfee: ['create', 'modify', 'delete'] },
  managementPeriod: { managementPeriod: ['modify'] },
};

async function tableExists(connection, schema, table) {
  const rows = await connection.query(
    'SELECT COUNT(*) AS cnt FROM information_schema.TABLES WHERE table_schema = ? AND table_name = ?',
    [schema, table],
  );
  return Number(rows[0][0].cnt) > 0;
}

async function columnExists(connection, schema, table, column) {
  const rows = await connection.query(
    'SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS WHERE table_schema = ? AND table_name = ? AND column_name = ?',
    [schema, table, column],
  );
  return Number(rows[0][0].cnt) > 0;
}

async function ensureColumn(connection) {
  if (!(await tableExists(connection, DB_NAME, TABLE_NAME))) {
    throw new Error(`未找到 ${DB_NAME}.${TABLE_NAME},请确认 .env 指向的实例包含平台模板库`);
  }
  if (await columnExists(connection, DB_NAME, TABLE_NAME, COLUMN_NAME)) {
    console.log(`skip    ${DB_NAME}.${TABLE_NAME}.${COLUMN_NAME} (已存在)`);
    return;
  }
  await connection.query(
    `ALTER TABLE \`${DB_NAME}\`.\`${TABLE_NAME}\` ADD COLUMN \`${COLUMN_NAME}\` json NULL ` +
      "COMMENT '功能级权限模板({功能名:[动作...]});NULL=不做功能级管控' AFTER `en_US`",
  );
  console.log(`created ${DB_NAME}.${TABLE_NAME}.${COLUMN_NAME} (json)`);
}

// 判断库里的值是否已是合法模板形状 { 功能名: [动作...] }(json 列回对象,兼容字符串):
// 旧脚本/手写遗回的授权形状 { 功能名: { actions: {...} } } 必须修复,否则后端启动时直接报该菜单未纳入管控,
function isTemplateShape(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      return false;
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return false;
  }
  return Object.entries(parsed).some(([fn, actions]) => Boolean(fn) && Array.isArray(actions) && actions.length > 0);
}

async function seedTemplates(connection, force) {
  const menuRows = await connection.query(`SELECT name, powerConfig FROM \`${DB_NAME}\`.\`${TABLE_NAME}\``);
  const rowByName = new Map((menuRows[0] || []).map((row) => [String(row.name), row.powerConfig]));
  const missingMenus = Object.keys(MENU_POWER_TEMPLATES).filter((name) => !rowByName.has(name));
  if (missingMenus.length > 0) {
    console.warn(`warn    菜单行不存在,已跳过:${missingMenus.join(', ')}(请核对线上菜单表)`);
  }

  let updated = 0;
  let repaired = 0;
  let skipped = 0;
  for (const [menuName, template] of Object.entries(MENU_POWER_TEMPLATES)) {
    if (!rowByName.has(menuName)) {
      continue;
    }
    const existing = rowByName.get(menuName);
    const isEmpty = existing === null || existing === undefined;
    const invalid = !isEmpty && !isTemplateShape(existing);
    if (!force && !isEmpty && !invalid) {
      skipped += 1;
      console.log(`skip    ${menuName} (已有模板,如需重置请加 --force)`);
      continue;
    }
    const sql = `UPDATE \`${DB_NAME}\`.\`${TABLE_NAME}\` SET powerConfig = ? WHERE name = ?`;
    const [result] = await connection.query(sql, [JSON.stringify(template), menuName]);
    if (Number(result.affectedRows) > 0) {
      updated += 1;
      if (invalid) {
        repaired += 1;
        console.log(`repair  ${menuName} -> ${JSON.stringify(template)}(原值形状非法:${JSON.stringify(existing)})`);
      } else {
        console.log(`backfill ${menuName} -> ${JSON.stringify(template)}`);
      }
    } else {
      skipped += 1;
      console.log(`skip    ${menuName} (写入后无变化)`);
    }
  }
  console.log(`模板初始化完成:更新 ${updated} 个菜单(修复脏值 ${repaired} 个),跳过 ${skipped} 个`);
}

async function main() {
  const force = process.argv.includes('--force');
  const connection = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    charset: 'utf8mb4',
    multipleStatements: false,
  });

  try {
    console.log(`目标:${DB_NAME}.${TABLE_NAME}.${COLUMN_NAME}(menu 为全局共享表,固定操作 gm_data_000)`);
    await ensureColumn(connection);
    await seedTemplates(connection, force);
    console.log('\nmenu.powerConfig 模板就绪(下一步:重启后端使启动缓存加载新模板)。');
  } finally {
    await connection.end();
  }
}

module.exports = { MENU_POWER_TEMPLATES };

if (require.main === module) {
  main().catch((error) => {
    console.error(error.code || error.message || error);
    if (error.sqlMessage) {
      console.error(error.sqlMessage);
    }
    process.exit(1);
  });
}
