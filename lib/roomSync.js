// 墓位回写同步:联系人/逝者姓名与预定到期字段的多表同步语句生成(由 public.js 拆出,审查修复 20261021 P1-7)。
// 对外口径不变:public.js 门面仍再导出本模块全部成员,调用点无需改动。

const pool = require('../database');
const { getInsertStatement, getUpdateByConditionStatement, getUpdateByIdStatement, assertIdentifier, assertNumericId } = require('./sqlBuilder');

// 本模块的语句模板全部把库名/ID 直接拼进文本(而不是占位符),所以在本模块内部自守一道:
// 不指望 28 个调用点都记得过 parseNumericParam,也不指望库名一定是验签结果
// 20261021 审查修复二轮 P0-1,
function assertScope(dataBase, idValue, label) {
  assertIdentifier(dataBase, 'database');
  return assertNumericId(idValue, label);
}

// 读口径适配(审查修复 20261021 二轮 P0-2):本模块的“先读后写”辅助函数原先只能在事务外
// 的池上读,并发提交同一墓位时两边都读不到对方未提交的行(联系人重复插入/预定复用错行);
// 现接受一个可选的事务连接,传入则在同一连接上读(返回 [rows, fields] 元组,取首元),
// 不传则保持旧行为,供确系单语句、无并发读写的入口继续直接使用,
async function readRows(runner, sql, params) {
  if (runner) {
    const result = await runner.query(sql, params || []);
    return Array.isArray(result) ? result[0] : result;
  }
  return pool.query(sql, params);
}

//同步墓位 room.contacts:聚合该墓位全部活动联系人姓名(空格分隔),截断 200 字符,无活动联系人时置空 20260913 新增,
exports.getRoomContactsSyncSql = function (dataBase, idRoom) {
  assertScope(dataBase, idRoom, 'idRoom');
  return (
    'update ' + dataBase + '.room r set r.contacts = (' +
    "select LEFT(GROUP_CONCAT(c.contacts order by c.idContacts asc separator ' '), 200) from " + dataBase + '.contacts c' +
    ' where c.idRoom = ' + idRoom + ' and c.isDeleted = 0' +
    ') where r.idRoom = ' + idRoom
  );
}

//同步墓位 room.deceased:聚合该墓位全部活动下葬记录安葬者姓名(空格分隔),截断 100 字符,无活动下葬记录时置空 20260917 新增,
exports.getRoomDeceasedSyncSql = function (dataBase, idRoom) {
  assertScope(dataBase, idRoom, 'idRoom');
  return (
    'update ' + dataBase + '.room r set r.deceased = (' +
    "select LEFT(GROUP_CONCAT(b.deceased order by b.idBuried asc separator ' '), 100) from " + dataBase + '.buried b' +
    ' where b.idRoom = ' + idRoom + ' and b.isDeleted = 0' +
    ') where r.idRoom = ' + idRoom
  );
}

//构建联系人同步语句:同墓位活动联系人按 名/电话 匹配,联系人名/电话/身份证号一并同步 20260917 修改,
//同名存在且电话/身份证号有变化则更新;同名不存在但同电话存在则更新联系人名与身份证号;名/电话均不存在则新增;联系人名为空不处理 20260916 新增,
//从 buried/save.js 提升为公共函数,供下葬/收管理费等页复用同一口径,避免各页手写产生偏差 20261017 新增,
// runner 为事务连接时,读与后续写同属一个事务(20261021 审查修复二轮 P0-2),
exports.buildContactsSyncStatements = async function (dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, operator, runner) {
  assertScope(dataBase, idRoom, 'idRoom');
  const nameValid = contactsName !== undefined && contactsName !== null && String(contactsName).trim() !== '';
  if (!nameValid) {
    return [];
  }

  const name = String(contactsName).trim();
  const phone = String(contactsPhone === undefined || contactsPhone === null ? '' : contactsPhone).trim();
  const idCard = String(contactsIDCard === undefined || contactsIDCard === null ? '' : contactsIDCard).trim();
  const table = dataBase + '.contacts';
  // 事务内读时直接带 FOR UPDATE:锁读与取数同一句(先取后锁会读到旧快照),同一墓位的并发提交串行处理,
  // 后提交者能看到前者的插行而不是重算一遍再插一条重复联系人 20261021 审查修复二轮 P0-2,
  const rows = await readRows(
    runner,
    `select idContacts, contacts, contactsPhone, contactsIDCard from ${table} where idRoom = ? and isDeleted = 0` +
      (runner ? ' for update' : ''),
    [idRoom],
  );

  const sameName = rows.find((item) => String(item.contacts || '').trim() === name);
  if (sameName) {
    // 同名活动联系人存在:电话或身份证号有变化才更新
    if (String(sameName.contactsPhone || '').trim() !== phone || String(sameName.contactsIDCard || '').trim() !== idCard) {
      return [getUpdateByConditionStatement({
        table,
        condition: { sql: 'idContacts = ? AND isDeleted = 0', params: [sameName.idContacts] },
        contactsPhone: phone,
        contactsIDCard: idCard,
        operator,
      })];
    }
    return [];
  }

  const samePhone = phone !== '' ? rows.find((item) => String(item.contactsPhone || '').trim() === phone) : null;
  if (samePhone) {
    // 同名不存在但电话相同:更新联系人名与身份证号
    return [getUpdateByConditionStatement({
      table,
      condition: { sql: 'idContacts = ? AND isDeleted = 0', params: [samePhone.idContacts] },
      contacts: name,
      contactsIDCard: idCard,
      operator,
    })];
  }

  // 名/电话均不存在:新增一条联系人
  return [getInsertStatement({
    table,
    idRoom,
    contacts: name,
    contactsPhone: phone,
    contactsIDCard: idCard,
    operator,
  })];
}

// ==================== 管理费期限链式顺延（收管理费新建/修改/删除共用口径） ====================
// 该墓位全部活动收款记录按 createDate 升序链式顺延：首条开始日期=墓位锚定起始日(room.startDate，即最早下葬日期；为空回落本次提交/剩余记录最早开始日期)，
// 其后每条开始=上一条结束，结束=开始+该条缴费年限；room.endDate 取链尾。提升自 adminfee/save.js 供删除入口复用，避免各入口手写顺延产生偏差 20261018 新增,

//墓位预定限期副本同步的语句模板:取该墓位活动预定记录的预定限期,无活动预定时自动置空,
//与 contacts/deceased 两个聚合同步同属"墓位冗余列由业务表反推"口径,预定登记/修改/取消三条路径均复用本模板避免各处手写产生偏差;
//MAX 兜底防一穴多条活动预定(历史脏数据)时子查询返回多行报错;whereClause 里的值均已经过 parseNumericParam 校验 20261011 新增,
function roomReservationExpireSyncSql(dataBase, whereClause) {
  return (
    'update ' + dataBase + '.room r set r.reservationExpireDate = (' +
    'select max(res.reservationExpireDate) from ' + dataBase + '.reserve res' +
    ' where res.idRoom = r.idRoom and res.isDeleted = 0' +
    ') where ' + whereClause
  );
}

//按墓位同步限期副本(预定登记/取消预定两个入口手里就是 idRoom) 20261011 新增,
exports.getRoomReservationExpireSyncSql = function (dataBase, idRoom) {
  assertScope(dataBase, idRoom, 'idRoom');
  return roomReservationExpireSyncSql(dataBase, 'r.idRoom = ' + idRoom);
}

//按预定记录反查所属墓位再同步限期副本(预定修改两个入口用):不依赖调用方是否传 idRoom——
//漏传时旧写法会静默不同步,造成 reserve 已改期、room 副本还是旧到期日 20261011 新增,
exports.getRoomReservationExpireSyncByIdReserveSql = function (dataBase, idReserve) {
  assertScope(dataBase, idReserve, 'idReserve');
  return roomReservationExpireSyncSql(
    dataBase,
    'r.idRoom = (select res2.idRoom from ' + dataBase + '.reserve res2 where res2.idReserve = ' + idReserve + ')',
  );
}

//预定记录一穴一条:同一墓位不累积多条预定信息——已有记录(含取消后的历史行)就复用原行按本次提交覆盖并把 isDeleted 回置 0,
//一条都没有才新增;复用时顺带把同穴其余活动记录软删(历史遗留的一穴多条),保证"一穴只留一条"从本次写入起成立 20261011 新增,
//入参 json 为已设好 table/operator 的预定记录字段(同 getInsertStatement 入参),idRoom 由调用方先过 parseNumericParam 校验,
// runner 为事务连接时“查已有行→复用/新增”均在事务内,避开两操作员同时登记同一墓位时各自读不到对方未插行而各插一条 20261021 审查修复二轮 P0-2,
exports.buildReserveUpsertStatements = async function (dataBase, idRoom, json, runner) {
  assertScope(dataBase, idRoom, 'idRoom');
  // 优先复用活动记录(isDeleted = 0),无活动记录时取最近一条已取消记录(历史不堆积的关键),
  // 事务内带 FOR UPDATE 读:一穴无活动记录时锁住该索引区间(间隙锁),并发登记只有一方能拿到“没有”这个结论,
  // 另一方等锁后重读即能看到前者刚插的行,从而复用而不是各插一条 20261021 审查修复二轮 P0-2,
  const rows = await readRows(
    runner,
    'select idReserve from ' + dataBase + '.reserve where idRoom = ? order by isDeleted asc, idReserve desc limit 1' +
      (runner ? ' for update' : ''),
    [idRoom],
  );
  if (!rows || rows.length === 0) {
    return { reused: false, statements: [getInsertStatement(json)] };
  }

  const idReserve = rows[0].idReserve;
  const updateJson = { ...json, idfield: 'idReserve', idvalue: idReserve, isDeleted: 0 };
  // idRoom 就是原行所属墓位、idReserve 为主键,两者不必再进 SET 子句 20261011 新增,
  delete updateJson.idRoom;
  delete updateJson.idReserve;

  return {
    reused: true,
    idReserve,
    statements: [
      // 复用已取消的历史行时把 isDeleted 回置 0(服务端主动“复活”,不是入参可控),因此显式放行该列 20261021 审查修复 P0-2,
      getUpdateByIdStatement(updateJson, { allow: ['isDeleted'] }),
      {
        sql: 'update ' + dataBase + '.reserve set isDeleted = 1 where idRoom = ? and idReserve <> ? and isDeleted = 0',
        params: [idRoom, idReserve],
      },
    ],
  };
}
