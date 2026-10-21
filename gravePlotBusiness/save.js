const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 墓位业务保存:代码独立于 sale/reserve/buried 模块,但数据表复用原有业务表——
// type=sale 落 sale 表+联动 buried/room/contacts, type=reserve 落 reserve 表(联动墓位状态),
// type=buried 落 buried 表(锚定管理费日期/置已下葬/deceased 聚合/联系人同步,同下葬页登记),
// type=certificate 落 burial_cert 表(安葬证设置,仅本表不联动),
// type=remark 直接更新 room.remark(墓位备注,仅本列不联动),
// 默认落 graveplotbusiness 本业务表 20260923 修改 20260927 修改 20261002 修改,

// 联系人同步口径统一复用 public.buildContactsSyncStatements(与下葬/收管理费页同源),
// 旧本地副本与其逐行同构,已删除避免双处维护产生偏差 20261019 重复代码消除,

// 各形态的入参剔除/捕获清单已抽到 lib/gravePlotBody.js(经 public 门面再导出):
// 新建与修改两个 handler 原先各抄一份完全相同的 delete 块(共 6 处),抽为单一事实来源
// (审查修复 20261021 二轮 P2-15),

// 销售编号区内唯一校验:查同 region 是否已有其它墓位(含软删——编号一经发出永不复用)占用该编号,返回占用者 idRoom,无则 null 20261012 新增,
// 编号空间为整个区域(region),与取号接口同源;空编号/查不到墓位区域时不校验(交由后续流程) 20261012 新增,
async function findSerialNoConflict(dataBase, serialNo, excludeIdRoom) {
  const trimmed = serialNo === undefined || serialNo === null ? '' : String(serialNo).trim();
  if (trimmed === '' || excludeIdRoom === undefined || excludeIdRoom === null) {
    return null;
  }
  const regionRows = await pool.query(`select region from ${dataBase}.room where idRoom = ? limit 1`, [excludeIdRoom]);
  if (!regionRows || regionRows.length === 0) {
    return null;
  }
  const dupRows = await pool.query(
    `select idRoom from ${dataBase}.room where region = ? and serialNo = ? and idRoom <> ? limit 1`,
    [regionRows[0].region, trimmed, excludeIdRoom],
  );
  return dupRows && dupRows.length > 0 ? dupRows[0].idRoom : null;
}

// 新建墓位业务 20260923 新增/修改,
router.post('/insert', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const idRoom = public.parseNumericParam(req.body.idRoom);
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }
  const type = req.body.type;
  delete req.body.type;

  // 销售形态:落 sale 表,同步 room 置已销售+buyer/serialNo,付款人非空时同步新增 contacts 联系人,
  // 并向 buried 新增一条下葬记录(安葬者三字段+购墓人映射,同事务,不联动下葬状态机) 20260923 修改,
  if (type === 'sale') {
    // 安葬者五字段属 buried 表、联系人四字段属 contacts 表,先捕获并从 sale 写入字段中剔除 20260923 新增 20261011 补充死亡日期,
    const { deceased, deathDate, burialDate, deceasedIDCard, deceasedRelation, payer, payerPhone, payerIDCard, serialNo } = public.captureSaleFormFields(req.body);

    // 新建销售编号区内唯一校验:同区域已被其它墓位占用则拒绝保存并提示 20261012 新增,
    try {
      const conflictIdRoom = await findSerialNoConflict(req.data.dataBase, serialNo, idRoom);
      if (conflictIdRoom !== null) {
        return res.status(400).json({ error: '编号"' + String(serialNo).trim() + '"在本区域已被占用，请修改后再保存!' });
      }
    } catch (error) {
      return public.handleQueryError(res, error);
    }

    // 新建销售预定有效性校验：以 room.reservationExpireDate（墓位预定限期副本、与墓位卡片展示同源）为闸门——
    // 购墓人=预定联系人可提交；购墓人≠联系人时，仅当已超期（当前日期 yyyy-mm-dd > 预定限期）方可提交，未超期（含限期当天）拒绝并提示；room 无限期(未预定)不受限 20261017 新增, 20261018 改用 room.reservationExpireDate 作闸门,
    try {
      const roomReserveRows = await pool.query(
        `SELECT rm.reservationExpireDate,
            (SELECT rs.liaison FROM ${req.data.dataBase}.reserve rs
              WHERE rs.idRoom = rm.idRoom AND rs.isDeleted = 0 LIMIT 1) AS liaison
          FROM ${req.data.dataBase}.room rm
          WHERE rm.idRoom = ? LIMIT 1`,
        [idRoom],
      );
      const roomReserve = roomReserveRows && roomReserveRows.length > 0 ? roomReserveRows[0] : null;
      if (roomReserve && roomReserve.reservationExpireDate) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const expireDay = new Date(roomReserve.reservationExpireDate);
        expireDay.setHours(0, 0, 0, 0);
        // 未超期（当前日期 <= 预定限期，含限期当天）才校验购墓人=预定联系人；已超期（当前日期 > 限期）放行不受限 20261017 新增 20261018 含限期当天,
        if (expireDay.getTime() >= today.getTime()) {
          const buyerName = payer === undefined || payer === null ? '' : String(payer).trim();
          const liaisonName = roomReserve.liaison === undefined || roomReserve.liaison === null ? '' : String(roomReserve.liaison).trim();
          if (buyerName !== liaisonName) {
            return res.status(400).json({ error: '该墓位存在有效预定（预定联系人：' + liaisonName + '），购墓人与预定联系人不一致，不可提交!' });
          }
        }
      }
    } catch (error) {
      return public.handleQueryError(res, error);
    }

    req.body.table = req.data.dataBase + '.sale';
    req.body.operator = req.data.userName;
    // 金额去千分位逗号并剔除展示用的 realPriceString(守卫化取值:原写法在缺字段时抛 TypeError 会崩进程) 20261021 审查修复②,
    public.normalizePriceField(req.body);
    delete req.body.idBusiness;

    var sql = public.getInsertStatement(req.body);
    let sqlList = [];
    sqlList.push(sql);
    // 捕获 sale 新插入记录的 idSale(同连接),供 buried 插入引用 20260923 新增,
    sqlList.push('SET @idSale = LAST_INSERT_ID()');
    // buried 记录为手写 INSERT,不走 getInsertStatement 自动补全,显式补 createDate/modifyDate 20261004 新增;
    // 列清单同步补 deathDate(写死列名的 INSERT 不包名称即静默丢字段) 20261011 新增,
    const buriedDate = public.getCurrentDateTime();
    sqlList.push({
      sql: `INSERT INTO ${req.data.dataBase}.buried (idRoom, idSale, deceased, deathDate, burialDate, deceasedIDCard, deceasedRelation, contacts, contactsphone, contactsIDCard, operator, createDate, modifyDate)
        VALUES (?, @idSale, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      // deathDate 可空:前端未选时 normalizeBodyDates 已将空串转 null,键缺失时兼容为 null(不可直传 undefined,mysql2 绑定 undefined 会报错) 20261011 新增,
      params: [idRoom, deceased,
        public.blankToNull(deathDate),
        burialDate, deceasedIDCard, deceasedRelation,
        public.blankToEmpty(payer),
        public.blankToEmpty(payerPhone),
        public.blankToEmpty(payerIDCard),
        req.data.userName, buriedDate, buriedDate],
    });
    // room.deceased 聚合同步:活动下葬记录 deceased 空格分隔同步到 room.deceased(逻辑同下葬页新增),随事务一致 20260923 新增,
    sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));
    let json = {};
    json.table = req.data.dataBase + '.room';
    json.operator = req.data.userName;
    json.idfield = 'idRoom';
    json.idvalue = idRoom;
    json.saleStatus = 'statusType.saleStatusEnum.sold';
    json.buyer = public.blankToEmpty(payer);
    json.serialNo = public.blankToEmpty(serialNo);
    // 销售成交：预定信息整体清除——墓位预定状态复位为未预定（与新删除的 reserve 记录一致，避免墓位查询按已预定过滤误计）20261017 新增,
    json.reserveStatus = 'statusType.reserveStatusEnum.unreserved';
    // 销售成交：预定限期副本置空（room.reservationExpireDate = null，对应预定记录随下方软删一并清除）20261017 新增,
    json.reservationExpireDate = null;
    var sqlRoom = public.getUpdateByIdStatement(json);
    sqlList.push(sqlRoom);

    // 销售成交后清除该墓位对应的活动预定记录（reserve 软删 isDeleted=1，与全系统软删口径一致；本形态仅新建走此分支）20261017 新增,
    sqlList.push(public.getSoftDeleteByConditionStatement({
      table: req.data.dataBase + '.reserve',
      condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
      isDeleted: 1,
      operator: req.data.userName,
    }));

    // 下葬日期非空时置墓位已下葬状态(销带下葬场景补齐) 20261004 新增;管理期限并入下葬例程A统一维护(G1),不再走"有收款就不动"旧口径 20261018 调整,
    if (public.hasFilledValue(burialDate)) {
      sqlList.push({
        sql: `update ${req.data.dataBase}.room set intoStatus = ? where idRoom = ?`,
        params: ['statusType.intoStatusEnum.buried', idRoom],
      });
      // 销带下葬并入下葬例程A统一维护管理期限:变更后最早下葬日=min(现有活动下葬,本次下葬日);有收款整链重排、无收款置 startDate=endDate=min 20261018 G1 新增,
      // 20261021 审查修复中C:链首日与活动收款行的读、重排结果的写一并收进同一事务(先锁墓位行),消除事务外读旧快照再全量覆写的丢更新窗口,
      sqlList.push(async (conn) => {
        await public.lockFeeChainRoot(conn, req.data.dataBase, idRoom);
        const minRows = await public.queryWith(
          conn,
          `select min(burialDate) as minBurial from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0`,
          [idRoom],
        );
        const anchorDay = public.feeMinDay(
          minRows && minRows.length > 0 ? minRows[0].minBurial : null,
          burialDate,
        );
        await public.applyFeePeriodRecascadeTx(conn, req.data.dataBase, idRoom, req.data.userName, anchorDay);
      });
    }

    if (public.hasFilledValue(payer)) {
      const contactsJson = {
        table: req.data.dataBase + '.contacts',
        idRoom,
        contacts: payer,
        contactsPhone: public.blankToEmpty(payerPhone),
        contactsIDCard: public.blankToEmpty(payerIDCard),
        operator: req.data.userName,
      };
      sqlList.push(public.getInsertStatement(contactsJson));
      sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
    }

    // 销售形态落 room.serialNo:走撞号兜底事务(库层 uk_room_region_serial 兼 TOCTOU,审查修复 20261021 中B)
    return public.TransactionWithSerialGuard(sqlList, res);
  }

  // 预定形态:落 reserve 表(联系人/电话映射 liaison/liaisonPhone),同步 room 只置已预定(销售状态不动,同预定登记);
  // 同样一穴一条,该墓位已有预定记录则复用原行 20260923 修改, 20261011 改为一穴一条,
  if (type === 'reserve') {
    // 付款人字段映射为 reserve 的 liaison 列并剔除 reserve 没有的业务列(与修改分支共用同一函数),
    public.prepareReserveFormBody(req.body, false);
    delete req.body.idBusiness;

    req.body.table = req.data.dataBase + '.reserve';
    req.body.operator = req.data.userName;

    // 一穴一条:复用该墓位已有预定记录(含已取消的历史行),不另新增第二条;与预定登记页共用同一辅助函数 20261011 修改,
    // 20261021 审查修复二轮 P0-2:与预定登记页同口径改为事务内锁读(“查已有行→复用/新增”不再跑在事务外),
    const sqlList = [];
    sqlList.push(async (conn) => {
      const reserveWrite = await public.buildReserveUpsertStatements(req.data.dataBase, idRoom, req.body, conn);
      return public.execWith(conn, reserveWrite.statements);
    });
    const json = {
      table: req.data.dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoom,
      // 与预定登记同口径:只置预定状态,不得改写 saleStatus 20261011 修正,
      reserveStatus: 'statusType.reserveStatusEnum.reserved',
    };
    sqlList.push(public.getUpdateByIdStatement(json));
    // 墓位限期副本同步(同预定登记):本形态表单目前未开预定限期控件,本次写入的预定记录该列为空,
    // 同步后墓位副本与预定记录一致;日后本页补上控件则无需再改后端 20261011 新增,
    sqlList.push(public.getRoomReservationExpireSyncSql(req.data.dataBase, idRoom));

    return public.Transaction(sqlList, res);
  }

  // 下葬形态:落 buried 表,锚定管理费起止日期、置墓位已下葬、deceased 聚合、联系人同步(同下葬页登记) 20260923 新增,
  if (type === 'buried') {
    const contactsName = req.body.contacts;
    const contactsPhone = req.body.contactsphone !== undefined ? req.body.contactsphone : req.body.contactsPhone;
    const contactsIDCard = req.body.contactsIDCard;

    public.stripBuriedFormFields(req.body);
    // 安葬者三字段属 buried 表,保留直接写入(此前误删致记录丢失,同下葬页) 20260924 修复
    delete req.body.idBusiness;

    req.body.table = req.data.dataBase + '.buried';
    req.body.operator = req.data.userName;

    const sqlList = [public.getInsertStatement(req.body)];

    // 下葬变动统一维护管理期限(同下葬页新增):变更后最早下葬日=min(现有活动下葬,本次下葬日);无收款仅置 startDate/endDate=min,有收款整链重排 20261018 ⑤ 新增,
    // 20261021 审查修复中C:读写一并收进同一事务(先锁墓位行),
    sqlList.push(async (conn) => {
      await public.lockFeeChainRoot(conn, req.data.dataBase, idRoom);
      const minRows = await public.queryWith(
        conn,
        `select min(burialDate) as minBurial from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0`,
        [idRoom],
      );
      const anchorDay = public.feeMinDay(
        minRows && minRows.length > 0 ? minRows[0].minBurial : null,
        req.body.burialDate,
      );
      await public.applyFeePeriodRecascadeTx(conn, req.data.dataBase, idRoom, req.data.userName, anchorDay);
    });

    const json = {
      table: req.data.dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoom,
      intoStatus: 'statusType.intoStatusEnum.buried',
    };
    sqlList.push(public.getUpdateByIdStatement(json));

    sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));

    // 20261021 审查修复二轮 P0-2:联系人同步的读→算→写一并收进事务项(同下葬页新建),
    sqlList.push(async (conn) => {
      const contactsStatements = await public.buildContactsSyncStatements(
        req.data.dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, req.data.userName, conn,
      );
      if (contactsStatements.length === 0) {
        return 0;
      }
      const affected = await public.execWith(conn, contactsStatements);
      await public.execWith(conn, [public.getRoomContactsSyncSql(req.data.dataBase, idRoom)]);
      return affected;
    });

    return public.Transaction(sqlList, res);
  }

  // 联系人形态:落 contacts 表(联系人/电话/身份证号),同墓位活动联系人重名拒绝,同步 room.contacts 聚合(同墓位联系人页,代码独立) 20260924 新增,
  if (type === 'contacts') {
    const contactsName = String(req.body.contacts || '').trim();
    try {
      const dupRows = await pool.query(
        'select idContacts from ' + req.data.dataBase + '.contacts where idRoom = ? and trim(contacts) = ? and isDeleted = 0 limit 1',
        [idRoom, contactsName],
      );
      if (dupRows.length > 0) {
        return res.status(400).json({ error: '该墓位已存在同名联系人"' + contactsName + '"，请勿重复提交!' });
      }
    } catch (error) {
      return public.handleQueryError(res, error);
    }

    req.body.table = req.data.dataBase + '.contacts';
    req.body.operator = req.data.userName;
    delete req.body.idContacts;

    const statement = public.getInsertStatement(req.body);
    return public.Transaction([statement, public.getRoomContactsSyncSql(req.data.dataBase, idRoom)], res);
  }

  // 安葬证设置形态:落 burial_cert 表,仅插入本表不联动(参照墓位销售方式,字段先行清理) 20260927 新增,
  if (type === 'certificate') {
    // 仅落 burial_cert 本表,业务侧字段一律剔除(与修改分支共用同一函数),
    public.prepareCertificateFormBody(req.body, false);
    delete req.body.idBusiness;

    req.body.table = req.data.dataBase + '.burial_cert';
    req.body.operator = req.data.userName;

    const sql = public.getInsertStatement(req.body);
    return public.Transaction([sql], res);
  }

  // 默认(业务形态):仅插入本业务表,不联动 room 状态与 contacts 20260923 新增,
  public.stripDefaultFormFields(req.body);
  req.body.table = req.data.dataBase + '.graveplotbusiness';
  req.body.operator = req.data.userName;
  // 金额去千分位逗号并剔除展示列(守卫化取值同上,缺 realPrice 时原实现直接崩进程) 20261021 审查修复②,
  public.normalizePriceField(req.body);
  delete req.body.idBusiness;

  var sql = public.getInsertStatement(req.body);
  return public.Transaction([sql], res);
});

// 修改墓位业务:按 type 更新对应业务表——销售形态同步 contacts 联系人/room.buyer/serialNo,
// 并同步 buried 记录(条件同 idRoom+idSale:有则更新,无且填写了安葬信息则插入);
// 预定形态仅更新记录字段;下葬形态同步锚定/聚合/联系人(同下葬页修改);默认本业务表 20260923 修改,
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const type = req.body.type;
  delete req.body.type;

  // 销售形态:更新 sale 记录,先取修改前旧付款人/墓位用于定位同步 contacts 联系人与 room.buyer/serialNo 20260923 修改,
  if (type === 'sale') {
    const idSale = public.parseNumericParam(req.body.idBusiness);
    if (idSale === null) {
      return res.status(400).json({ error: 'idBusiness参数错误!' });
    }

    // 安葬者五字段与联系人四字段的捕获/剔除口径与新建逐字一致(原先两处各写一份),
    const { deceased, deathDate, burialDate, deceasedIDCard, deceasedRelation, payer, payerPhone, payerIDCard, serialNo } = public.captureSaleFormFields(req.body);

    req.body.table = req.data.dataBase + '.sale';
    req.body.operator = req.data.userName;
    delete req.body.realPriceString;
    req.body.idfield = 'idSale';
    req.body.idvalue = idSale;
    delete req.body.idBusiness;

    const statement = public.getUpdateByIdStatement(req.body);

    const saleTable = req.data.dataBase + '.sale';
    try {
      const results = await pool.query(`SELECT payer AS oldPayer, idRoom FROM ${saleTable} WHERE idSale = ? AND isDeleted = 0 LIMIT 1`, [idSale]);
      const row = results && results.length > 0 ? results[0] : null;
      const sqlList = [statement];
      const idRoom = row ? public.parseNumericParam(row.idRoom) : null;

      // 修改销售编号区内唯一校验:同区域若被其它墓位占用(排除本墓位)则拒绝保存并提示 20261012 新增,
      const conflictIdRoom = await findSerialNoConflict(req.data.dataBase, serialNo, idRoom);
      if (conflictIdRoom !== null) {
        return res.status(400).json({ error: '编号"' + String(serialNo).trim() + '"在本区域已被占用，请修改后再保存!' });
      }

      const newPayerValid = public.hasFilledValue(payer);
      const oldPayer = row ? row.oldPayer : null;
      const oldPayerValid = public.hasFilledValue(oldPayer);

      if (newPayerValid && idRoom !== null && oldPayerValid) {
        const contactsJson = {
          table: req.data.dataBase + '.contacts',
          condition: { sql: 'idRoom = ? AND contacts = ? AND isDeleted = 0', params: [idRoom, oldPayer] },
          contacts: payer,
          contactsPhone: public.blankToEmpty(payerPhone),
          contactsIDCard: public.blankToEmpty(payerIDCard),
          operator: req.data.userName,
        };
        sqlList.push(public.getUpdateByConditionStatement(contactsJson));
        sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
      }

      if (idRoom !== null) {
        const roomJson = {
          table: req.data.dataBase + '.room',
          condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
          buyer: public.blankToEmpty(payer),
          serialNo: public.blankToEmpty(serialNo),
          operator: req.data.userName,
        };
        sqlList.push(public.getUpdateByConditionStatement(roomJson));
      }

      // buried 同步:条件同 idRoom+idSale——有对应活动记录则更新安葬者三字段+购墓人三字段;
      // 无对应记录且本次填写了安葬信息(安葬者/下葬日期/身份证号任一非空)则补插一条,避免信息丢失;
      // 全空且无记录则跳过 20260923 新增,
      if (idRoom !== null) {
        const buriedTable = req.data.dataBase + '.buried';
        const existing = await pool.query(
          `SELECT idBuried FROM ${buriedTable} WHERE idRoom = ? AND idSale = ? AND isDeleted = 0 LIMIT 1`,
          [idRoom, idSale],
        );
        const buriedJson = {
          deceased: public.blankToEmpty(deceased),
          // 死亡/下葬日期可空:置 null 而非 ''(与其他字段不同——datetime 写空串在 sql_mode=STRICT_TRANS_TABLES 下会被 MySQL 拒),未填即抹空该列 20261011 新增/修复,
          deathDate: public.blankToNull(deathDate),
          burialDate: public.blankToNull(burialDate),
          deceasedIDCard: public.blankToEmpty(deceasedIDCard),
          deceasedRelation: public.blankToEmpty(deceasedRelation),
          contacts: public.blankToEmpty(payer),
          contactsphone: public.blankToEmpty(payerPhone),
          contactsIDCard: public.blankToEmpty(payerIDCard),
          operator: req.data.userName,
        };
        // 判定“本次填写了安葬信息”逐项判非 undefined/非 null/非空串:null 直接 String(null).trim() 会得到 'null' 属非空,
        // 沿用旧写法会使本判定恒为真、在无活动记录时误补插 20261011 修复(口径收进 public.hasFilledValue),
        const hasBuriedInfo = public.hasFilledValue(buriedJson.deceased)
          || public.hasFilledValue(buriedJson.burialDate)
          || public.hasFilledValue(buriedJson.deceasedIDCard);
        if (existing && existing.length > 0) {
          buriedJson.table = buriedTable;
          buriedJson.idfield = 'idBuried';
          buriedJson.idvalue = existing[0].idBuried;
          sqlList.push(public.getUpdateByIdStatement(buriedJson));
        } else if (hasBuriedInfo) {
          buriedJson.table = buriedTable;
          buriedJson.idRoom = idRoom;
          buriedJson.idSale = idSale;
          sqlList.push(public.getInsertStatement(buriedJson));
        }
        // room.deceased 聚合同步:活动下葬记录 deceased 空格分隔同步到 room.deceased(逻辑同下葬页修改),随事务一致 20260923 新增,
        sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));

        // 销带下葬并入下葬例程A统一维护管理期限(G1,口径同新建):排除被改 buried 取其余活动最早下葬日再并入本次下葬日(本次清空日期也会反映);有收款整链重排、无收款置 startDate=endDate=min 20261018 统一定义 20261018 G1 改造,
        // 20261021 审查修复中C:读写一并收进同一事务(先锁墓位行),本事务内已插入/更新的 buried 行也会被链首取值读到,口径与新建一致,
        const excludeIdBuried = existing && existing.length > 0 ? existing[0].idBuried : null;
        sqlList.push(async (conn) => {
          await public.lockFeeChainRoot(conn, req.data.dataBase, idRoom);
          const minRows = excludeIdBuried !== null
            ? await public.queryWith(
                conn,
                `select min(burialDate) as minBurial from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0 and idBuried <> ?`,
                [idRoom, excludeIdBuried],
              )
            : await public.queryWith(
                conn,
                `select min(burialDate) as minBurial from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0`,
                [idRoom],
              );
          const anchorDay = public.feeMinDay(
            minRows && minRows.length > 0 ? minRows[0].minBurial : null,
            burialDate,
          );
          await public.applyFeePeriodRecascadeTx(conn, req.data.dataBase, idRoom, req.data.userName, anchorDay);
        });
      }

      // 销售形态更新落 room.serialNo:走撞号兜底事务(同新建,审查修复 20261021 中B)
      return public.TransactionWithSerialGuard(sqlList, res);
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  }

  // 预定形态:更新 reserve 记录的联系人/电话/备注,并将预定限期同步到墓位副本,墓位状态不变(同预定修改) 20260923 修改,
  if (type === 'reserve') {
    const idReserve = public.parseNumericParam(req.body.idBusiness);
    if (idReserve === null) {
      return res.status(400).json({ error: 'idBusiness参数错误!' });
    }

    // 与新建同一函数:墓位不变所以不更新外键 idRoom,并额外剔除联系人三字段 20261011 修改,
    public.prepareReserveFormBody(req.body, true);

    req.body.table = req.data.dataBase + '.reserve';
    req.body.operator = req.data.userName;
    req.body.idfield = 'idReserve';
    req.body.idvalue = idReserve;
    delete req.body.idBusiness;

    const statement = public.getUpdateByIdStatement(req.body);
    // 墓位限期副本与预定记录同一事务(按 idReserve 反查墓位,写法同预定修改) 20261011 新增,
    return public.Transaction(
      [statement, public.getRoomReservationExpireSyncByIdReserveSql(req.data.dataBase, idReserve)],
      res,
    );
  }

  // 下葬形态:按 idBuried 更新下葬记录,锚定管理费日期、保持已下葬、deceased 聚合、联系人同步(同下葬页修改) 20260923 新增,
  if (type === 'buried') {
    const idBuried = public.parseNumericParam(req.body.idBusiness);
    const idRoom = public.parseNumericParam(req.body.idRoom);
    if (idBuried === null) {
      return res.status(400).json({ error: 'idBusiness参数错误!' });
    }
    if (idRoom === null) {
      return res.status(400).json({ error: 'idRoom参数错误!' });
    }

    const contactsName = req.body.contacts;
    const contactsPhone = req.body.contactsphone !== undefined ? req.body.contactsphone : req.body.contactsPhone;
    const contactsIDCard = req.body.contactsIDCard;

    // 修改前旧联系人:同步后不再被新值引用时用于软删旧记录 20260923 新增,
    // 20261021 审查修复二轮 P0-2:该快照与下面的联系人匹配原本都跑在事务外的池上、语句却排进本事务,
    // 并发提交同一墓位时会重复插联系人与漏软删;现合并为一个事务项,并排在 buried UPDATE 之前
    // (旧值一旦被本次提交覆盖就取不到了),
    const sqlList = [];
    sqlList.push(async (conn) => {
      const oldRows = await public.queryWith(
        conn,
        `select contacts, contactsphone from ${req.data.dataBase}.buried where idBuried = ? and isDeleted = 0 limit 1 for update`,
        [idBuried],
      );
      const oldContactsRow = oldRows && oldRows.length > 0 ? oldRows[0] : null;

      let contactsChanged = false;
      let affected = 0;
      const contactsStatements = await public.buildContactsSyncStatements(
        req.data.dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, req.data.userName, conn,
      );
      if (contactsStatements.length > 0) {
        affected += await public.execWith(conn, contactsStatements);
        contactsChanged = true;
      }

      // 旧记录清理:新联系人名与旧名不同(含清空)时软删旧记录(同下葬页修改) 20260923 新增,
      const oldContacts = oldContactsRow ? oldContactsRow.contacts : null;
      const oldPhone = oldContactsRow ? oldContactsRow.contactsphone : null;
      const oldContactsValid = public.hasFilledValue(oldContacts);
      const newName = contactsName === undefined || contactsName === null ? '' : String(contactsName).trim();
      if (oldContactsValid && String(oldContacts).trim() !== newName) {
        const conditionParts = ['idRoom = ?', 'contacts = ?', 'isDeleted = 0'];
        const conditionParams = [idRoom, String(oldContacts).trim()];
        if (public.hasFilledValue(oldPhone)) {
          conditionParts.push('contactsPhone = ?');
          conditionParams.push(String(oldPhone).trim());
        }
        affected += await public.execWith(conn, [public.getSoftDeleteByConditionStatement({
          table: req.data.dataBase + '.contacts',
          condition: { sql: conditionParts.join(' AND '), params: conditionParams },
          isDeleted: 1,
          operator: req.data.userName,
        })]);
        contactsChanged = true;
      }

      if (contactsChanged) {
        affected += await public.execWith(conn, [public.getRoomContactsSyncSql(req.data.dataBase, idRoom)]);
      }
      return affected;
    });

    public.stripBuriedFormFields(req.body);
    // 安葬者三字段属 buried 表,保留直接写入(此前误删致记录丢失,同下葬页) 20260924 修复
    req.body.table = req.data.dataBase + '.buried';
    req.body.operator = req.data.userName;
    req.body.idfield = 'idBuried';
    req.body.idvalue = idBuried;
    delete req.body.idBusiness;
    // 墓位不变,无需更新外键 idRoom
    delete req.body.idRoom;

    sqlList.push(public.getUpdateByIdStatement(req.body));

    // 下葬变动统一维护管理期限(同下葬页修改):排除被改记录取其余最早下葬日再并入本次下葬日;无收款仅置 startDate/endDate=min,有收款整链重排 20261018 ⑤ 新增,
    // 20261021 审查修复中C:读写一并收进同一事务(先锁墓位行),
    sqlList.push(async (conn) => {
      await public.lockFeeChainRoot(conn, req.data.dataBase, idRoom);
      const minRows = await public.queryWith(
        conn,
        `select min(burialDate) as minBurial from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0 and idBuried <> ?`,
        [idRoom, idBuried],
      );
      const anchorDay = public.feeMinDay(
        minRows && minRows.length > 0 ? minRows[0].minBurial : null,
        req.body.burialDate,
      );
      await public.applyFeePeriodRecascadeTx(conn, req.data.dataBase, idRoom, req.data.userName, anchorDay);
    });

    const json = {
      table: req.data.dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoom,
      intoStatus: 'statusType.intoStatusEnum.buried',
    };
    sqlList.push(public.getUpdateByIdStatement(json));

    sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));

    // 联系人同步 + 旧联系人清理已上提到本分支开头的事务项内(20261021 审查修复二轮 P0-2),

    return public.Transaction(sqlList, res);
  }

  // 联系人形态:按 idContacts 更新 contacts 记录(重名校验排除自身),同步 room.contacts 聚合(同墓位联系人页,代码独立) 20260924 新增,
  if (type === 'contacts') {
    const idContacts = public.parseNumericParam(req.body.idContacts);
    const idRoom = public.parseNumericParam(req.body.idRoom);
    if (idContacts === null) {
      return res.status(400).json({ error: 'idContacts参数错误!' });
    }
    if (idRoom === null) {
      return res.status(400).json({ error: 'idRoom参数错误!' });
    }

    const contactsName = String(req.body.contacts || '').trim();
    try {
      const dupRows = await pool.query(
        'select idContacts from ' + req.data.dataBase + '.contacts where idRoom = ? and trim(contacts) = ? and isDeleted = 0 and idContacts <> ? limit 1',
        [idRoom, contactsName, idContacts],
      );
      if (dupRows.length > 0) {
        return res.status(400).json({ error: '该墓位已存在同名联系人"' + contactsName + '"，请勿重复提交!' });
      }
    } catch (error) {
      return public.handleQueryError(res, error);
    }

    req.body.table = req.data.dataBase + '.contacts';
    req.body.operator = req.data.userName;
    req.body.idfield = 'idContacts';
    req.body.idvalue = idContacts;
    delete req.body.idContacts;

    const statement = public.getUpdateByIdStatement(req.body);
    return public.Transaction([statement, public.getRoomContactsSyncSql(req.data.dataBase, idRoom)], res);
  }

  // 墓位备注形态:直接更新 room.remark 本列,不联动其他表(墓位备注页单字段编辑) 20261002 新增,
  if (type === 'remark') {
    const idRoomRemark = public.parseNumericParam(req.body.idRoom);
    if (idRoomRemark === null) {
      return res.status(400).json({ error: 'idRoom参数错误!' });
    }

    const json = {
      table: req.data.dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoomRemark,
      remark: req.body.remark === undefined || req.body.remark === null ? '' : String(req.body.remark),
    };
    const statement = public.getUpdateByIdStatement(json);
    return public.Transaction([statement], res);
  }

  // 安葬证设置形态:按 idCert(idBusiness) 更新 burial_cert 本表,仅更新不联动 20260927 新增,
  if (type === 'certificate') {
    const idCert = public.parseNumericParam(req.body.idBusiness);
    if (idCert === null) {
      return res.status(400).json({ error: 'idBusiness参数错误!' });
    }

    // 业务侧字段剔除与新建共用同一函数;墓位不变故 idRoom 也不得进 SET 20261011 修改,
    public.prepareCertificateFormBody(req.body, true);

    req.body.table = req.data.dataBase + '.burial_cert';
    req.body.operator = req.data.userName;
    req.body.idfield = 'idCert';
    req.body.idvalue = idCert;
    delete req.body.idBusiness;

    const statement = public.getUpdateByIdStatement(req.body);
    return public.Transaction([statement], res);
  }

  // 默认(业务形态):仅更新本业务表 20260923 新增,
  const idBusiness = public.parseNumericParam(req.body.idBusiness);
  if (idBusiness === null) {
    return res.status(400).json({ error: 'idBusiness参数错误!' });
  }

  public.stripDefaultFormFields(req.body);
  req.body.table = req.data.dataBase + '.graveplotbusiness';
  req.body.operator = req.data.userName;
  delete req.body.realPriceString;
  //处理id
  req.body.idfield = 'idBusiness';
  req.body.idvalue = idBusiness;
  delete req.body.idBusiness;
  //
  const statement = public.getUpdateByIdStatement(req.body);
  return public.Transaction([statement], res);
});

