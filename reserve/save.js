const express = require('express');
const router = express.Router();
const public = require('../public');
module.exports = router;

// 墓区预定登记:写入预定记录并将墓位预定状态置为已预定(销售状态不动),事务保证两表一致;
// 同一墓位只保留一条预定记录(已取消的不另加一条,重新预定时复用原行) 20260902 新增, 20261011 改为一穴一条,
// 20261011 修正:预定只写 reserveStatus,不再改写 saleStatus(预定不等于售出),
router.post('/insert', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }
  // 预定限期必填:库列已统一为可空(NULL),必填由应用层拦住——否则落进 NULL 后预定何时失效无从判断,墓位会一直锁住无法再销售 20261011 新增,
  if (!String(req.body.reservationExpireDate || '').trim()) {
    return res.status(400).json({ error: 'reservationExpireDate参数错误!' });
  }

  req.body.table = req.data.dataBase + '.reserve';
  req.body.operator = req.data.userName;

  delete req.body.idReserve;

  // 一穴一条:该墓位已有预定记录则复用原行覆盖字段,不再新增第二条 20261011 修改,
  // 20261021 审查修复二轮 P0-2:“查已有行→决定复用还是新增”原先跑在事务外的池上,
  // 两个操作员同时给同一墓位登记预定时都读到“没有”,会各插一条活动预定;
  // 现收进事务项,在同一连接上 FOR UPDATE 读后再构造语句,
  const sqlList = [];
  sqlList.push(async (conn) => {
    const reserveWrite = await public.buildReserveUpsertStatements(req.data.dataBase, idRoom, req.body, conn);
    return public.execWith(conn, reserveWrite.statements);
  });
  const json = {};
  json.table = req.data.dataBase + '.room';
  json.operator = req.data.userName;
  json.idfield = 'idRoom';
  json.idvalue = idRoom;
  // 只置预定状态:saleStatus 保持墓位原有销售状态(预定不等于售出,售出与否仍由销售/取消销售流程维护) 20261011 修正,
  json.reserveStatus = 'statusType.reserveStatusEnum.reserved';
  const sqlRoom = public.getUpdateByIdStatement(json);
  sqlList.push(sqlRoom);
  // 墓位冗余列同步:预定限期反写 room,与置预定状态同一事务,墓位侧无需联查 reserve 即可读到期日 20261011 新增,
  sqlList.push(public.getRoomReservationExpireSyncSql(req.data.dataBase, idRoom));

  return public.Transaction(sqlList, res);
});

// 修改预定:更新预定记录的联系人/电话/预定限期/备注等字段,并将限期同步到墓位副本,墓位状态不变 20260907 新增, 20261011 字段改名,
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idReserve = public.parseNumericParam(req.body.idReserve);
  if (idReserve === null) {
    return res.status(400).json({ error: 'idReserve参数错误!' });
  }
  // 预定限期必填口径与新建一致,避免修改时把已有日期抹空 20261011 新增,
  if (!String(req.body.reservationExpireDate || '').trim()) {
    return res.status(400).json({ error: 'reservationExpireDate参数错误!' });
  }

  req.body.table = req.data.dataBase + '.reserve';
  req.body.operator = req.data.userName;
  req.body.idfield = 'idReserve';
  req.body.idvalue = idReserve;
  delete req.body.idReserve;
  // 墓位不变,无需更新外键 idRoom:限期副本同步由 idReserve 反查所属墓位,不依赖该参数 20261011 修改,
  delete req.body.idRoom;

  const statement = public.getUpdateByIdStatement(req.body);
  // 改期后墓位副本同事务跟着改(写法同管理费收款页的主表+room 双写事务),并按 idReserve 反查墓位而不拿调用方参数当条件 20261011 新增,
  return public.Transaction(
    [statement, public.getRoomReservationExpireSyncByIdReserveSql(req.data.dataBase, idReserve)],
    res,
  );
});
