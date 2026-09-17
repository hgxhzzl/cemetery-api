require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const config = require('../config');

// 仅导出表结构、不导出数据的表
const TABLES_WITHOUT_DATA = new Set(['adminfee', 'buried', 'contacts', 'contract', 'park', 'period_change', 'reserve', 'room', 'sale', 'taginfo', 'transfer_out']);

function pad(n) {
  return String(n).padStart(2, '0');
}

function formatNavicatDate(date) {
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function buildHeader() {
  return `/*
 Navicat Premium Data Transfer

 Source Server         : mysql
 Source Server Type    : MySQL
 Source Server Version : 80200
 Source Host           : ${config.database.host}:${config.database.port}
 Source Schema         : ${config.database.database}

 Target Server Type    : MySQL
 Target Server Version : 80200
 File Encoding         : 65001

 Date: ${formatNavicatDate(new Date())}
*/

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;
CREATE DATABASE IF NOT EXISTS \`${config.database.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci;
USE \`${config.database.database}\`;

`;
}

// 将行值序列化为 SQL 字面量
function quoteValue(value) {
  if (value === null || value === undefined) {
    return 'NULL';
  }

  if (Buffer.isBuffer(value)) {
    return `0x${value.toString('hex')}`;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : 'NULL';
  }

  if (typeof value === 'boolean') {
    return value ? '1' : '0';
  }

  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = pad(value.getMonth() + 1);
    const d = pad(value.getDate());
    const h = pad(value.getHours());
    const i = pad(value.getMinutes());
    const s = pad(value.getSeconds());
    return `'${y}-${m}-${d} ${h}:${i}:${s}'`;
  }

  const escaped = String(value)
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
    .replace(/\x1a/g, '\\Z');
  return `'${escaped}'`;
}

function buildTableSection(tableName, createTableSql, rows) {
  const lines = [];
  lines.push('-- ----------------------------');
  lines.push(`-- Table structure for ${tableName}`);
  lines.push('-- ----------------------------');
  lines.push(`DROP TABLE IF EXISTS \`${tableName}\`;`);
  lines.push(createTableSql.replace(/;\s*$/, '') + ';');
  lines.push('');

  if (rows.length > 0) {
    lines.push('-- ----------------------------');
    lines.push(`-- Records of ${tableName}`);
    lines.push('-- ----------------------------');
    for (const row of rows) {
      const values = Object.values(row).map(quoteValue).join(', ');
      lines.push(`INSERT INTO \`${tableName}\` VALUES (${values});`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

async function main() {
  const connection = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    dateStrings: true,
    charset: 'utf8mb4',
  });

  try {
    const [fullTables] = await connection.query('SHOW FULL TABLES');
    const tables = [];
    const views = [];

    for (const row of fullTables) {
      const keys = Object.keys(row);
      const name = row[keys[0]];
      const type = row[keys[1]];
      if (type === 'VIEW') {
        views.push(name);
      } else {
        tables.push(name);
      }
    }

    tables.sort();
    views.sort();

    const sections = [buildHeader()];
    const stats = [];

    for (const tableName of tables) {
      const [createRows] = await connection.query('SHOW CREATE TABLE ??', [tableName]);
      const createTableSql = createRows[0]['Create Table'];
      const [rows] = TABLES_WITHOUT_DATA.has(tableName)
        ? [[], []]
        : await connection.query('SELECT * FROM ??', [tableName]);
      sections.push(buildTableSection(tableName, createTableSql, rows));
      stats.push(`${tableName}: ${rows.length} rows${TABLES_WITHOUT_DATA.has(tableName) ? ' (data skipped)' : ''}`);
    }

    for (const viewName of views) {
      const [createRows] = await connection.query('SHOW CREATE VIEW ??', [viewName]);
      const createViewSql = createRows[0]['Create View'];
      // 移除 DEFINER 子句,避免导入环境缺少该用户时创建视图失败
      const portableViewSql = createViewSql.replace(/DEFINER=`[^`]*`@`[^`]*`\s+/i, '');
      sections.push('-- ----------------------------');
      sections.push(`-- View structure for ${viewName}`);
      sections.push('-- ----------------------------');
      sections.push(`DROP VIEW IF EXISTS \`${viewName}\`;`);
      sections.push(portableViewSql.replace(/;\s*$/, '') + ';');
      sections.push('');
      stats.push(`${viewName}: view`);
    }

    const [triggers] = await connection.query(
      "SELECT TRIGGER_NAME FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA = DATABASE()"
    );
    if (triggers.length > 0) {
      console.log(`WARN: ${triggers.length} trigger(s) found but not exported:`, triggers.map((t) => t.TRIGGER_NAME).join(', '));
    }

    const [routines] = await connection.query(
      "SELECT ROUTINE_NAME FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE()"
    );
    if (routines.length > 0) {
      console.log(`WARN: ${routines.length} routine(s) found but not exported:`, routines.map((r) => r.ROUTINE_NAME).join(', '));
    }

    const sql = sections.join('\n') + '\nSET FOREIGN_KEY_CHECKS = 1;\n';
    const targetPath = path.resolve(__dirname, '..', 'gm_data_000.sql');
    fs.writeFileSync(targetPath, sql, 'utf8');

    console.log(`Exported ${tables.length} table(s), ${views.length} view(s) to ${targetPath}`);
    console.log(stats.join('\n'));
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.code || error.message || error);
  if (error.sqlMessage) {
    console.error(error.sqlMessage);
  }
  process.exit(1);
});
