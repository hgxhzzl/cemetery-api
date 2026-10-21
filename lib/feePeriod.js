// 管理费期限链:日界解析与顺延计算、链式顺建语句、事务内费用链加锁与工具(由 public.js 拆出,审查修复 20261021 P1-7)。
// 对外口径不变:public.js 门面仍再导出本模块全部成员,调用点无需改动。

const pool = require('../database');
const { assertIdentifier, getSoftDeleteByConditionStatement, getUpdateByIdStatement } = require('./sqlBuilder');

// 空值安全转本地零点 Date：库列 datetime 经 mysql2 回传 Date、提交值为 YYYY-MM-DD 串；无效返回 null 20261018 新增,
// 日期字符串按本地时区逐段解析(审查修复 20261021 P1-6):`new Date('YYYY-MM-DD')` 按 ES 规定走 UTC 零点,
// 服务端时区为负偏移时会使整条管理费链日期少一天(池已改 dateStrings 后回传值一律是字符串),
const localDayPattern = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?/;
function toFeeDay(value) {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  }
  const matched = localDayPattern.exec(String(value).trim());
  if (matched) {
    const local = new Date(
      Number(matched[1]),
      Number(matched[2]) - 1,
      Number(matched[3]),
      Number(matched[4] || 0),
      Number(matched[5] || 0),
      Number(matched[6] || 0),
    );
    return Number.isNaN(local.getTime()) ? null : local;
  }
  const parsed = new Date(String(value).replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function addFeeYears(dateObj, years) {
  const shifted = new Date(dateObj.getTime());
  shifted.setFullYear(shifted.getFullYear() + years);
  return shifted;
}

exports.fmtFeeDay = function (dateObj) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${dateObj.getFullYear()}-${pad(dateObj.getMonth() + 1)}-${pad(dateObj.getDate())}`;
}

// 空值安全的天级格式化，用于"库中现值 vs 链算目标值"的等值比较 20261018 新增,
exports.feeDayStr = function (value) {
  const d = toFeeDay(value);
  return d ? exports.fmtFeeDay(d) : '';
}

// 链式计算：orderedRows 须已按 createDate 升序且携带本次提交的最新年限值；
// 年限为空/≤0 的记录保留其原结束日期(晚于链起点时)否则结束=开始——防止无年限历史记录把整条链拽回 20261018 新增,
exports.computeFeePeriodCascade = function (anchorDay, orderedRows) {
  let cursor = anchorDay;
  const targets = [];
  orderedRows.forEach((row) => {
    const start = cursor;
    const years = Number(row.termYears) || 0;
    let end;
    if (years > 0) {
      end = addFeeYears(start, years);
    } else {
      const original = toFeeDay(row.endDate);
      end = original && original.getTime() > start.getTime() ? original : start;
    }
    targets.push({ row, startDate: exports.fmtFeeDay(start), endDate: exports.fmtFeeDay(end) });
    cursor = end;
  });
  return { targets, tailDate: exports.fmtFeeDay(cursor) };
}

// 管理费期限链的链首日期取值与活动收款行读取仅提供事务内版本(见下方“事务内费用链工具”),
// 杜绝“事务外读旧快照→事务内全量覆写”的丢失更新窗口 20261021 审查修复中C(原事务外版本 findFeePeriodAnchor/listActiveFeeRows 下线),

// 安全取多个日期值(可混合 Date/字符串/null)中的最早本地零点 Date；全无效返回 null 20261018 ⑤ 新增,
exports.feeMinDay = function (...values) {
  let earliest = null;
  values.forEach((v) => {
    const d = toFeeDay(v);
    if (d && (!earliest || d.getTime() < earliest.getTime())) {
      earliest = d;
    }
  });
  return earliest;
}

// 该墓位是否存在可用于锚定的活动下葬记录(即有下葬日期的活动 buried)——收管理费前置校验用(② 无锚定下葬不可收款)；
// 仅“有日期下葬”才作锚:避免无日期 buried 行使 min(burialDate) 为空、收款后又被下次下葬变动归零软删 20261018 新增,
exports.hasActiveBurial = async function (dataBase, idRoom, runner) {
  const sql = `select 1 as hit from ${dataBase}.buried where idRoom = ? and isDeleted = 0 and burialDate is not null limit 1`;
  // runner 为事务连接时在本事务里读(与后续写同一快照),不再从池上另拿一条连接;
  // 两个取数入口的返回形式不同(池包装层直接回行数组,连接回 [rows, fields] 元组),故不能合走 queryWith,
  // 20261021 审查修复二轮 P0-2,
  const rows = runner ? await exports.queryWith(runner, sql, [idRoom]) : await pool.query(sql, [idRoom]);
  return !!(rows && rows.length > 0);
}

// 下葬增/删/改后统一维护该墓位管理期限（⑤/Rule2）：anchorDay 为变更后最早活动下葬日期（由调用方按增/删/改语义算好传入）——
// 无活动下葬记录(anchorDay 为空)时 room.startDate/endDate 置空,并软删该墓位全部活动收款记录(无埋则 adminfee 一并软删,Rule2)；
// 无活动收款记录时仅将 room.startDate/endDate 同置 anchorDay（无条件覆盖）；
// 有收款记录时以 anchorDay 为链首整链重排 adminfee 起止，并写回 room.startDate=anchorDay、room.endDate=链尾 20261018 ⑤ 新增, 20261018 Rule2 归零软删 adminfee,
// 20261021 拆分:语句构造抽为纯函数(已读出的收款行为入参),事务外/事务内两个入口共用同一套重排口径,
function buildFeePeriodStatements(dataBase, idRoom, operator, anchorDay, feeRows) {
  if (!anchorDay) {
    return [
      getSoftDeleteByConditionStatement({
        table: dataBase + '.adminfee',
        condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
        isDeleted: 1,
        operator,
      }),
      {
        sql: `update ${dataBase}.room set startDate = null, endDate = null where idRoom = ?`,
        params: [idRoom],
      },
    ];
  }
  const anchorStr = exports.fmtFeeDay(anchorDay);
  if (!feeRows || feeRows.length === 0) {
    return [{
      sql: `update ${dataBase}.room set startDate = ?, endDate = ? where idRoom = ?`,
      params: [anchorStr, anchorStr, idRoom],
    }];
  }
  const { targets, tailDate } = exports.computeFeePeriodCascade(anchorDay, feeRows);
  const statements = [];
  targets.forEach(({ row, startDate: startStr, endDate: endStr }) => {
    if (exports.feeDayStr(row.startDate) !== startStr || exports.feeDayStr(row.endDate) !== endStr) {
      statements.push(getUpdateByIdStatement({
        table: dataBase + '.adminfee',
        idfield: 'idAdminfee',
        idvalue: row.idAdminfee,
        startDate: startStr,
        endDate: endStr,
        operator,
      }));
    }
  });
  statements.push({
    sql: `update ${dataBase}.room set startDate = ?, endDate = ? where idRoom = ?`,
    params: [anchorStr, tailDate, idRoom],
  });
  return statements;
}

// ==================== 事务内费用链工具(审查修复 20261021 中C) ====================
// 背景:各下葬/销售/收款入口先在事务外读链首日期与活动收款行,再在事务内写重排结果;两请求并发时
// 后来者拿旧快照计算并全量覆写 adminfee/room 起止日期,导致丢失更新。以下工具把“读→算→写”收进同一事务,
// 并先以墓位行 FOR UPDATE 串行化同墓位的费用链事务 20261021 新增,

// 事务连接上的参数化查询:mysql2 Promise 连接返回 [rows, fields] 元组,此处统一取 rows 20261021 新增,
exports.queryWith = async function (connection, sql, params) {
  const result = await connection.query(sql, params || []);
  return Array.isArray(result) ? result[0] : result;
}

// 墓位行锁:仅作并发闸门不改数据;同一事务重复获取为无操作 20261021 新增,
exports.lockFeeChainRoot = async function (connection, dataBase, idRoom) {
  const db = assertIdentifier(dataBase, 'database');
  await connection.query(`select idRoom from ${db}.room where idRoom = ? for update`, [idRoom]);
}

// 事务内读取活动收款行并加行锁(阻止并发事务同墓位收款插入/修改) 20261021 新增,
exports.listActiveFeeRowsWith = async function (connection, dataBase, idRoom) {
  const db = assertIdentifier(dataBase, 'database');
  return exports.queryWith(
    connection,
    `select idAdminfee, termYears, startDate, endDate from ${db}.adminfee
      where idRoom = ? and isDeleted = 0 order by createDate asc, idAdminfee asc for update`,
    [idRoom],
  );
}

// 事务内取链首日期(统一定义):一律优先取该墓位最早活动下葬日期 min(burialDate)——直接以下葬事实为准,不读可能滞后的 room.startDate 副本;
// 无活动下葬记录时回落 room.startDate(先收款后下葬/历史场景),仍为空再回落调用方提供的兜底日期;均无则返回 null 由调用方兜底 20261021 审查修复中C,
exports.findFeePeriodAnchorWith = async function (connection, dataBase, idRoom, fallbackDate) {
  const db = assertIdentifier(dataBase, 'database');
  const minRows = await exports.queryWith(
    connection,
    `select min(burialDate) as minBurial from ${db}.buried where idRoom = ? and isDeleted = 0`,
    [idRoom],
  );
  const minBurial = minRows && minRows.length > 0 ? toFeeDay(minRows[0].minBurial) : null;
  if (minBurial) {
    return minBurial;
  }
  const roomRows = await exports.queryWith(connection, `select startDate from ${db}.room where idRoom = ? limit 1`, [idRoom]);
  const roomStart = roomRows && roomRows.length > 0 ? toFeeDay(roomRows[0].startDate) : null;
  if (roomStart) {
    return roomStart;
  }
  return toFeeDay(fallbackDate);
}

// 事务内版重排:读→算→写同一连接同一快照;feeRows 为调用方已读出的活动收款行时可省一次查询 20261021 新增,
exports.applyFeePeriodRecascadeTx = async function (connection, dataBase, idRoom, operator, anchorDay, feeRows) {
  const rows = anchorDay ? (feeRows || (await exports.listActiveFeeRowsWith(connection, dataBase, idRoom))) : null;
  await exports.execWith(connection, buildFeePeriodStatements(dataBase, idRoom, operator, anchorDay, rows));
}

// 逐条执行语句集(字符串/{sql,params} 两种形态),供事务内工具与函数型事务项执行 20261021 新增,
// 返回累计真实影响行数(20261021 审查修复二轮 P0-2):函数型事务项原先一律 return undefined,
// 使“事务内自己执行”的写语句在回包里被计成 0 行,现在可把本返回值直接当作项返回值,
exports.execWith = async function (connection, statements) {
  let affectedRows = 0;
  for (const item of statements || []) {
    if (typeof item === 'function') {
      await item(connection);
      continue;
    }
    const result = typeof item === 'string' ? await connection.query(item) : await execStatement(connection, item);
    const packet = Array.isArray(result) ? result[0] : result;
    const count = Number(packet && packet.affectedRows);
    if (Number.isFinite(count)) {
      affectedRows += count;
    }
  }
  return affectedRows;
}

async function execStatement(connection, item) {
  if (item && typeof item.sql === 'string') {
    return connection.query(item.sql, Array.isArray(item.params) ? item.params : []);
  }
  throw new Error('Invalid statement item');
}

// “下葬变动→管理期限”事务内统一例程:先锁墓位行,再在事务内取剩余活动下葬的链首日期,可选回调补充依赖 remain 的分支语句
// (如回置未下葬),最后整链重排;返回剩余活动下葬条数供调用方必要时记录 20261021 新增,
exports.runFeeChainTx = async function (
  connection,
  { dataBase, idRoom, operator, remainSql, remainParams, anchorExtraDates, onRemain },
) {
  await exports.lockFeeChainRoot(connection, dataBase, idRoom);
  let remain = 0;
  let minBurial = null;
  if (remainSql) {
    const rows = await exports.queryWith(connection, remainSql, remainParams);
    remain = rows && rows.length > 0 ? Number(rows[0].cnt) : 0;
    minBurial = rows && rows.length > 0 ? rows[0].minBurial : null;
  }
  if (typeof onRemain === 'function') {
    await onRemain(connection, remain);
  }
  const anchorDay = exports.feeMinDay(minBurial, ...(anchorExtraDates || []));
  await exports.applyFeePeriodRecascadeTx(connection, dataBase, idRoom, operator, anchorDay);
  return { remain, anchorDay };
}
