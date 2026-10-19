// 线上库二级索引幂等补齐脚本 20261019 性能优化新增:
// gm_data_000.sql 的 KEY 定义只对新库生效,已上线老库执行本脚本补齐同一批索引;
// 每项先查 information_schema.STATISTICS,不存在才 ALTER TABLE ADD INDEX,重复运行安全
require('dotenv').config();

const mysql = require('mysql2/promise');
const config = require('../config');

// 与 gm_data_000.sql 建表语句中的 KEY 定义一一对应,新增索引时两边同步维护
const indexList = [
  { table: 'room', name: 'idx_room_region_park', columns: ['region', 'park'] },
  { table: 'room', name: 'idx_room_serial', columns: ['region', 'serialNo'] },
  { table: 'room', name: 'idx_room_endDate', columns: ['endDate'] },
  { table: 'sale', name: 'idx_sale_idRoom', columns: ['idRoom', 'isDeleted'] },
  { table: 'sale', name: 'idx_sale_createDate', columns: ['createDate'] },
  { table: 'buried', name: 'idx_buried_idRoom', columns: ['idRoom', 'isDeleted'] },
  { table: 'buried', name: 'idx_buried_burialDate', columns: ['burialDate'] },
  { table: 'adminfee', name: 'idx_adminfee_idRoom', columns: ['idRoom', 'isDeleted', 'createDate'] },
  { table: 'adminfee', name: 'idx_adminfee_createDate', columns: ['createDate'] },
  { table: 'contacts', name: 'idx_contacts_idRoom', columns: ['idRoom', 'isDeleted'] },
  { table: 'reserve', name: 'idx_reserve_idRoom', columns: ['idRoom', 'isDeleted'] },
  { table: 'reserve', name: 'idx_reserve_expire', columns: ['reservationExpireDate'] },
  { table: 'transfer_out', name: 'idx_transfer_out_idRoom', columns: ['idRoom', 'isDeleted'] },
  { table: 'burial_cert', name: 'idx_burial_cert_idRoom', columns: ['idRoom', 'isDeleted'] },
  { table: 'period_change', name: 'idx_period_change_idRoom', columns: ['idRoom', 'isDeleted'] },
  { table: 'operator', name: 'idx_operator_phone', columns: ['phone'] },
  { table: 'operator_power', name: 'idx_operator_power', columns: ['idOperator', 'idMenu', 'useMenu'] },
  { table: 'menu', name: 'idx_menu_name', columns: ['name'] },
];

async function indexExists(connection, table, name) {
  const rows = await connection.query(
    'SELECT COUNT(*) AS cnt FROM information_schema.STATISTICS ' +
      'WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?',
    [table, name],
  );
  return Number(rows[0][0].cnt) > 0;
}

async function main() {
  const connection = await mysql.createConnection({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.database,
    charset: 'utf8mb4',
  });

  try {
    let created = 0;
    let skipped = 0;
    for (const item of indexList) {
      if (await indexExists(connection, item.table, item.name)) {
        skipped++;
        console.log(`skip    ${item.table}.${item.name} (已存在)`);
        continue;
      }
      // 表名/索引名/列名均来自上方静态清单而非外部输入,标识符反引号包裹即可
      await connection.query(
        `ALTER TABLE \`${item.table}\` ADD INDEX \`${item.name}\` (${item.columns.map((c) => `\`${c}\``).join(', ')})`,
      );
      created++;
      console.log(`created ${item.table}.${item.name} (${item.columns.join(', ')})`);
    }
    console.log(`索引补齐完成: created=${created}, skipped=${skipped}, total=${indexList.length}`);
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
