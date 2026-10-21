// 线上库二级索引幂等补齐脚本 20261019 性能优化新增:
// gm_data_000.sql 的 KEY 定义只对新库生效,已上线老库执行本脚本补齐同一批索引;
// 每项先查 information_schema.STATISTICS,不存在才 ALTER TABLE ADD INDEX,重复运行安全
require('dotenv').config();

const mysql = require('mysql2/promise');
const config = require('../config');

// 与 gm_data_000.sql 建表语句中的 KEY 定义一一对应,新增索引时两边同步维护
const indexList = [
  { table: 'room', name: 'idx_room_region_park', columns: ['region', 'park'] },
  { table: 'room', name: 'idx_room_coord', columns: ['region', 'park', 'yNum', 'xNum'] },
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

// 区内销售编号唯一约束补齐(审查修复 20261021 中B):MAX+1 取号存在 TOCTOU 并发撞号,
// 应用层 findSerialNoConflict 预检不变,另以数据库唯一索引兜底。空编号经生成列转 NULL 不参与唯一,
// 存量重复编号先查出清单、人工改号后重跑本脚本,不静默清号 20261021 新增,
async function ensureRoomSerialUnique(connection) {
  const colRows = await connection.query(
    'SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS ' +
      "WHERE table_schema = DATABASE() AND table_name = 'room' AND column_name = 'serialNoKey'",
  );
  if (Number(colRows[0][0].cnt) === 0) {
    await connection.query(
      'ALTER TABLE `room` ADD COLUMN `serialNoKey` varchar(40) ' +
        "GENERATED ALWAYS AS (nullif(`serialNo`, '')) VIRTUAL COMMENT '区内编号唯一约束载体(空编号为NULL不参与唯一)'",
    );
    console.log('created room.serialNoKey (生成列)');
  } else {
    console.log('skip    room.serialNoKey (已存在)');
  }
  if (await indexExists(connection, 'room', 'uk_room_region_serial')) {
    console.log('skip    room.uk_room_region_serial (已存在)');
    return;
  }
  const dupRows = await connection.query(
    'SELECT region, serialNo, COUNT(*) AS cnt, GROUP_CONCAT(idRoom) AS idRooms FROM `room` ' +
      "WHERE serialNo <> '' GROUP BY region, serialNo HAVING COUNT(*) > 1 ORDER BY region, serialNo",
  );
  // connection.query 返回 [rows, fields] 元组,原写法把元组当行数组使用(长度恒为 2)使重复检测永远误报, 20261021 修正,
  const serialDups = dupRows[0] || [];
  if (serialDups.length > 0) {
    console.warn(`warn    存量重复编号 ${serialDups.length} 组,未创建 uk_room_region_serial,请先人工改号后重跑:`);
    serialDups.slice(0, 20).forEach((row) => {
      console.warn(`  region=${row.region} serialNo=${row.serialNo} idRooms=${row.idRooms}`);
    });
    return;
  }
  await connection.query('ALTER TABLE `room` ADD UNIQUE KEY `uk_room_region_serial` (`region`, `serialNoKey`)');
  console.log('created room.uk_room_region_serial (region, serialNoKey)');
}

// 活动墓位坐标唯一约束补齐(审查修复 20261021 P1-3):同一区/园区内同一排号×号位不应同存多条活动墓位,
// 批量建位的去重校验在应用层,但两个事务同时建同一坐标仍可能在锁获取前交错(旧库无索引时无任何拦截),
// 以生成列承载唯一约束兜底:已软删/已迁出的行取 NULL 不参与唯一(迁出后原坐标可重新登记),
// 存量重复坐标先列出清单、人工处理后重跑本脚本,不静默删行 20261021 新增,
async function ensureRoomCoordUnique(connection) {
  const colRows = await connection.query(
    'SELECT COUNT(*) AS cnt FROM information_schema.COLUMNS ' +
      "WHERE table_schema = DATABASE() AND table_name = 'room' AND column_name = 'coordKey'",
  );
  if (Number(colRows[0][0].cnt) === 0) {
    await connection.query(
      'ALTER TABLE `room` ADD COLUMN `coordKey` varchar(80) GENERATED ALWAYS AS (' +
        "CASE WHEN `isDeleted` = 0 AND (`transferOutStatus` IS NULL OR `transferOutStatus` <> 'statusType.transferOutStatusEnum.out') " +
        "THEN concat(`region`, '|', `park`, '|', `yNum`, '|', `xNum`) ELSE NULL END) VIRTUAL " +
        "COMMENT '活动墓位坐标唯一约束载体(已删/已迁出为NULL不参与唯一)'",
    );
    console.log('created room.coordKey (生成列)');
  } else {
    console.log('skip    room.coordKey (已存在)');
  }
  if (await indexExists(connection, 'room', 'uk_room_coord')) {
    console.log('skip    room.uk_room_coord (已存在)');
    return;
  }
  const dupResult = await connection.query(
    'SELECT region, park, yNum, xNum, COUNT(*) AS cnt, GROUP_CONCAT(idRoom) AS idRooms FROM `room` ' +
      'WHERE isDeleted = 0 AND coordKey IS NOT NULL ' +
      'GROUP BY region, park, yNum, xNum HAVING COUNT(*) > 1 ORDER BY region, park, yNum, xNum',
  );
  const coordDups = dupResult[0] || [];
  if (coordDups.length > 0) {
    console.warn(`warn    存量重复坐标 ${coordDups.length} 组,未创建 uk_room_coord,请先人工处理(软删多余行或改坐标)后重跑:`);
    coordDups.slice(0, 20).forEach((row) => {
      console.warn(
        `  region=${row.region} park=${row.park} yNum=${row.yNum} xNum=${row.xNum} idRooms=${row.idRooms}`,
      );
    });
    return;
  }
  await connection.query('ALTER TABLE `room` ADD UNIQUE KEY `uk_room_coord` (`coordKey`)');
  console.log('created room.uk_room_coord (coordKey)');
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
    await ensureRoomSerialUnique(connection);
    await ensureRoomCoordUnique(connection);
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
