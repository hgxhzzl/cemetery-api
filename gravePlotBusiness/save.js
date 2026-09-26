const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 墓位业务保存:代码独立于 sale/reserve/buried 模块,但数据表复用原有业务表——
// type=sale 落 sale 表+联动 buried/room/contacts, type=reserve 落 reserve 表(联动墓位状态),
// type=buried 落 buried 表(锚定管理费日期/置已下葬/deceased 聚合/联系人同步,同下葬页登记),
// 默认落 graveplotbusiness 本业务表 20260923 修改,

// 构建联系人同步语句:同墓位活动联系人按 名/电话 匹配,联系人名/电话/身份证号一并同步
// (复制自下葬页逻辑,代码独立;同名存在且电话/身份证号有变化则更新;同名不存在但同电话存在则更新联系人名与身份证号;
// 名/电话均不存在则新增;联系人名为空不处理) 20260923 新增,
async function buildContactsSyncStatements(dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, operator) {
  const nameValid = contactsName !== undefined && contactsName !== null && String(contactsName).trim() !== '';
  if (!nameValid) {
    return [];
  }

  const name = String(contactsName).trim();
  const phone = String(contactsPhone === undefined || contactsPhone === null ? '' : contactsPhone).trim();
  const idCard = String(contactsIDCard === undefined || contactsIDCard === null ? '' : contactsIDCard).trim();
  const table = dataBase + '.contacts';
  const rows = await pool.query(
    `select idContacts, contacts, contactsPhone, contactsIDCard from ${table} where idRoom = ? and isDeleted = 0`,
    [idRoom],
  );

  const sameName = rows.find((item) => String(item.contacts || '').trim() === name);
  if (sameName) {
    if (String(sameName.contactsPhone || '').trim() !== phone || String(sameName.contactsIDCard || '').trim() !== idCard) {
      return [public.getUpdateByConditionStatement({
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
    return [public.getUpdateByConditionStatement({
      table,
      condition: { sql: 'idContacts = ? AND isDeleted = 0', params: [samePhone.idContacts] },
      contacts: name,
      contactsIDCard: idCard,
      operator,
    })];
  }

  return [public.getInsertStatement({
    table,
    idRoom,
    contacts: name,
    contactsPhone: phone,
    contactsIDCard: idCard,
    operator,
  })];
}

// 下葬形态通用:清理非 buried 表字段(前端统一业务模型按形态在后端拆分) 20260923 新增,
function stripBuriedBody(req) {
  delete req.body.payer;
  delete req.body.payerPhone;
  delete req.body.payerIDCard;
  delete req.body.realPrice;
  delete req.body.realPriceString;
  delete req.body.payee;
  delete req.body.serialNo;
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

  // 销售形态:落 sale 表,同步 room 置已销售+buyer/cardno,付款人非空时同步新增 contacts 联系人,
  // 并向 buried 新增一条下葬记录(安葬者三字段+购墓人映射,同事务,不联动下葬状态机) 20260923 修改,
  if (type === 'sale') {
    // 安葬者三字段属 buried 表,先捕获供 buried 插入,避免混入 sale 插入字段 20260923 新增,
    const deceased = req.body.deceased;
    const burialDate = req.body.burialDate;
    const deceasedIDCard = req.body.deceasedIDCard;
    const deceasedRelation = req.body.deceasedRelation;
    delete req.body.deceased;
    delete req.body.burialDate;
    delete req.body.deceasedIDCard;
    delete req.body.deceasedRelation;

    // sale 表无联系人列,剔除前端随单提交的联系人字段,联系人由下方 contacts 表语句单独同步 20260924 修复,
    delete req.body.contacts;
    delete req.body.contactsphone;
    delete req.body.contactsPhone;
    delete req.body.contactsIDCard;

    const payer = req.body.payer;
    const payerPhone = req.body.payerPhone;
    const payerIDCard = req.body.payerIDCard;
    const serialNo = req.body.serialNo;

    req.body.table = req.data.dataBase + '.sale';
    req.body.operator = req.data.userName;
    let price = req.body.realPrice.toString();
    price = price.replace(/,/g, '');
    req.body.realPrice = price;
    delete req.body.realPriceString;
    delete req.body.idBusiness;

    var sql = public.getInsertStatement(req.body);
    let sqlList = [];
    sqlList.push(sql);
    // 捕获 sale 新插入记录的 idSale(同连接),供 buried 插入引用 20260923 新增,
    sqlList.push('SET @idSale = LAST_INSERT_ID()');
    sqlList.push({
      sql: `INSERT INTO ${req.data.dataBase}.buried (idRoom, idSale, deceased, burialDate, deceasedIDCard, deceasedRelation, contacts, contactsphone, contactsIDCard, operator)
        VALUES (?, @idSale, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [idRoom, deceased, burialDate, deceasedIDCard, deceasedRelation,
        payer === undefined || payer === null ? '' : payer,
        payerPhone === undefined || payerPhone === null ? '' : payerPhone,
        payerIDCard === undefined || payerIDCard === null ? '' : payerIDCard,
        req.data.userName],
    });
    // room.deceased 聚合同步:活动下葬记录 deceased 空格分隔同步到 room.deceased(逻辑同下葬页新增),随事务一致 20260923 新增,
    sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));
    let json = {};
    json.table = req.data.dataBase + '.room';
    json.operator = req.data.userName;
    json.idfield = 'idRoom';
    json.idvalue = idRoom;
    json.saleStatus = 'statusType.saleStatusEnum.sold';
    json.buyer = payer === undefined || payer === null ? '' : payer;
    json.cardno = serialNo === undefined || serialNo === null ? '' : serialNo;
    var sqlRoom = public.getUpdateByIdStatement(json);
    sqlList.push(sqlRoom);

    if (payer !== undefined && payer !== null && String(payer).trim() !== '') {
      const contactsJson = {
        table: req.data.dataBase + '.contacts',
        idRoom,
        contacts: payer,
        contactsPhone: payerPhone === undefined || payerPhone === null ? '' : payerPhone,
        contactsIDCard: payerIDCard === undefined || payerIDCard === null ? '' : payerIDCard,
        operator: req.data.userName,
      };
      sqlList.push(public.getInsertStatement(contactsJson));
      sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
    }

    return public.Transaction(sqlList, res);
  }

  // 预定形态:落 reserve 表(联系人/电话映射 liaison/liaisonPhone),同步 room 置预定/已预定(同预定登记) 20260923 修改,
  if (type === 'reserve') {
    req.body.liaison = req.body.payer;
    req.body.liaisonPhone = req.body.payerPhone;
    delete req.body.payer;
    delete req.body.payerPhone;
    delete req.body.realPrice;
    delete req.body.realPriceString;
    delete req.body.payerIDCard;
    delete req.body.payee;
    delete req.body.serialNo;
    delete req.body.deceased;
    delete req.body.burialDate;
    delete req.body.deceasedIDCard;
    delete req.body.deceasedRelation;
    delete req.body.idBusiness;

    req.body.table = req.data.dataBase + '.reserve';
    req.body.operator = req.data.userName;

    const sqlList = [public.getInsertStatement(req.body)];
    const json = {
      table: req.data.dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoom,
      saleStatus: 'statusType.saleStatusEnum.reserve',
      reserveStatus: 'statusType.reserveStatusEnum.reserved',
    };
    sqlList.push(public.getUpdateByIdStatement(json));

    return public.Transaction(sqlList, res);
  }

  // 下葬形态:落 buried 表,锚定管理费起止日期、置墓位已下葬、deceased 聚合、联系人同步(同下葬页登记) 20260923 新增,
  if (type === 'buried') {
    const contactsName = req.body.contacts;
    const contactsPhone = req.body.contactsphone !== undefined ? req.body.contactsphone : req.body.contactsPhone;
    const contactsIDCard = req.body.contactsIDCard;

    stripBuriedBody(req);
    // 安葬者三字段属 buried 表,保留直接写入(此前误删致记录丢失,同下葬页) 20260924 修复
    delete req.body.idBusiness;

    req.body.table = req.data.dataBase + '.buried';
    req.body.operator = req.data.userName;

    const sqlList = [public.getInsertStatement(req.body)];

    // 管理费起止日期锚定:开始日期=该墓位活动下葬记录最早下葬日期;结束日期仅在为空时取同值(同下葬页) 20260923 新增,
    const anchorDateSql =
      `update ${req.data.dataBase}.room set ` +
      `startDate = (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0), ` +
      `endDate = coalesce(endDate, (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0)) ` +
      `where idRoom = ?`;
    sqlList.push({ sql: anchorDateSql, params: [idRoom, idRoom, idRoom] });

    const json = {
      table: req.data.dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoom,
      intoStatus: 'statusType.intoStatusEnum.buried',
    };
    sqlList.push(public.getUpdateByIdStatement(json));

    sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));

    try {
      const contactsStatements = await buildContactsSyncStatements(
        req.data.dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, req.data.userName,
      );
      if (contactsStatements.length > 0) {
        sqlList.push(...contactsStatements);
        sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
      }
    } catch (error) {
      return public.handleQueryError(res, error);
    }

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

  // 默认(业务形态):仅插入本业务表,不联动 room 状态与 contacts 20260923 新增,
  delete req.body.deceased;
  delete req.body.burialDate;
  delete req.body.deceasedIDCard;
  delete req.body.deceasedRelation;
  delete req.body.contacts;
  delete req.body.contactsphone;
  delete req.body.contactsIDCard;
  req.body.table = req.data.dataBase + '.graveplotbusiness';
  req.body.operator = req.data.userName;
  let price = req.body.realPrice.toString();
  price = price.replace(/,/g, '');
  req.body.realPrice = price;
  delete req.body.realPriceString;
  delete req.body.idBusiness;

  var sql = public.getInsertStatement(req.body);
  return public.Transaction([sql], res);
});

// 修改墓位业务:按 type 更新对应业务表——销售形态同步 contacts 联系人/room.buyer/cardno,
// 并同步 buried 记录(条件同 idRoom+idSale:有则更新,无且填写了安葬信息则插入);
// 预定形态仅更新记录字段;下葬形态同步锚定/聚合/联系人(同下葬页修改);默认本业务表 20260923 修改,
router.post('/update', async (req, res) => {
  public.normalizeBodyDates(req.body);
  const type = req.body.type;
  delete req.body.type;

  // 销售形态:更新 sale 记录,先取修改前旧付款人/墓位用于定位同步 contacts 联系人与 room.buyer/cardno 20260923 修改,
  if (type === 'sale') {
    const idSale = public.parseNumericParam(req.body.idBusiness);
    if (idSale === null) {
      return res.status(400).json({ error: 'idBusiness参数错误!' });
    }

    // 安葬者三字段属 buried 表,先捕获供 buried 同步,避免混入 sale 更新字段 20260923 新增,
    const deceased = req.body.deceased;
    const burialDate = req.body.burialDate;
    const deceasedIDCard = req.body.deceasedIDCard;
    const deceasedRelation = req.body.deceasedRelation;
    delete req.body.deceased;
    delete req.body.burialDate;
    delete req.body.deceasedIDCard;
    delete req.body.deceasedRelation;

    // sale 表无联系人列,剔除前端随单提交的联系人字段,联系人由下方 contacts 表语句单独同步 20260924 修复,
    delete req.body.contacts;
    delete req.body.contactsphone;
    delete req.body.contactsPhone;
    delete req.body.contactsIDCard;

    const payer = req.body.payer;
    const payerPhone = req.body.payerPhone;
    const payerIDCard = req.body.payerIDCard;
    const serialNo = req.body.serialNo;

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

      const newPayerValid = payer !== undefined && payer !== null && String(payer).trim() !== '';
      const oldPayer = row ? row.oldPayer : null;
      const oldPayerValid = oldPayer !== undefined && oldPayer !== null && String(oldPayer).trim() !== '';

      if (newPayerValid && idRoom !== null && oldPayerValid) {
        const contactsJson = {
          table: req.data.dataBase + '.contacts',
          condition: { sql: 'idRoom = ? AND contacts = ? AND isDeleted = 0', params: [idRoom, oldPayer] },
          contacts: payer,
          contactsPhone: payerPhone === undefined || payerPhone === null ? '' : payerPhone,
          contactsIDCard: payerIDCard === undefined || payerIDCard === null ? '' : payerIDCard,
          operator: req.data.userName,
        };
        sqlList.push(public.getUpdateByConditionStatement(contactsJson));
        sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
      }

      if (idRoom !== null) {
        const roomJson = {
          table: req.data.dataBase + '.room',
          condition: { sql: 'idRoom = ? AND isDeleted = 0', params: [idRoom] },
          buyer: payer === undefined || payer === null ? '' : payer,
          cardno: serialNo === undefined || serialNo === null ? '' : serialNo,
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
          deceased: deceased === undefined || deceased === null ? '' : deceased,
          burialDate: burialDate === undefined || burialDate === null ? '' : burialDate,
          deceasedIDCard: deceasedIDCard === undefined || deceasedIDCard === null ? '' : deceasedIDCard,
          deceasedRelation: deceasedRelation === undefined || deceasedRelation === null ? '' : deceasedRelation,
          contacts: payer === undefined || payer === null ? '' : payer,
          contactsphone: payerPhone === undefined || payerPhone === null ? '' : payerPhone,
          contactsIDCard: payerIDCard === undefined || payerIDCard === null ? '' : payerIDCard,
          operator: req.data.userName,
        };
        const hasBuriedInfo = String(buriedJson.deceased).trim() !== '' || String(buriedJson.burialDate).trim() !== '' || String(buriedJson.deceasedIDCard).trim() !== '';
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
      }

      return public.Transaction(sqlList, res);
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  }

  // 预定形态:仅更新 reserve 记录的联系人/电话/备注,墓位状态不变(同预定修改) 20260923 修改,
  if (type === 'reserve') {
    const idReserve = public.parseNumericParam(req.body.idBusiness);
    if (idReserve === null) {
      return res.status(400).json({ error: 'idBusiness参数错误!' });
    }

    req.body.liaison = req.body.payer;
    req.body.liaisonPhone = req.body.payerPhone;
    delete req.body.payer;
    delete req.body.payerPhone;
    delete req.body.realPrice;
    delete req.body.realPriceString;
    delete req.body.payerIDCard;
    delete req.body.payee;
    delete req.body.serialNo;
    delete req.body.deceased;
    delete req.body.burialDate;
    delete req.body.deceasedIDCard;
    delete req.body.deceasedRelation;
    delete req.body.contacts;
    delete req.body.contactsphone;
    delete req.body.contactsIDCard;
    // 墓位不变,无需更新外键 idRoom
    delete req.body.idRoom;

    req.body.table = req.data.dataBase + '.reserve';
    req.body.operator = req.data.userName;
    req.body.idfield = 'idReserve';
    req.body.idvalue = idReserve;
    delete req.body.idBusiness;

    const statement = public.getUpdateByIdStatement(req.body);
    try {
      const results = await pool.query(statement.sql, statement.params);
      return public.respondAffectedRows(res, results);
    } catch (error) {
      return public.handleQueryError(res, error);
    }
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
    let oldContactsRow = null;
    try {
      const oldRows = await pool.query(
        `select contacts, contactsphone from ${req.data.dataBase}.buried where idBuried = ? and isDeleted = 0 limit 1`,
        [idBuried],
      );
      oldContactsRow = oldRows && oldRows.length > 0 ? oldRows[0] : null;
    } catch (error) {
      return public.handleQueryError(res, error);
    }

    const sqlList = [];
    stripBuriedBody(req);
    // 安葬者三字段属 buried 表,保留直接写入(此前误删致记录丢失,同下葬页) 20260924 修复
    req.body.table = req.data.dataBase + '.buried';
    req.body.operator = req.data.userName;
    req.body.idfield = 'idBuried';
    req.body.idvalue = idBuried;
    delete req.body.idBusiness;
    // 墓位不变,无需更新外键 idRoom
    delete req.body.idRoom;

    sqlList.push(public.getUpdateByIdStatement(req.body));

    // 管理费起止日期锚定(同下葬页修改) 20260923 新增,
    const anchorDateSql =
      `update ${req.data.dataBase}.room set ` +
      `startDate = (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0), ` +
      `endDate = coalesce(endDate, (select min(burialDate) from ${req.data.dataBase}.buried where idRoom = ? and isDeleted = 0)) ` +
      `where idRoom = ?`;
    sqlList.push({ sql: anchorDateSql, params: [idRoom, idRoom, idRoom] });

    const json = {
      table: req.data.dataBase + '.room',
      operator: req.data.userName,
      idfield: 'idRoom',
      idvalue: idRoom,
      intoStatus: 'statusType.intoStatusEnum.buried',
    };
    sqlList.push(public.getUpdateByIdStatement(json));

    sqlList.push(public.getRoomDeceasedSyncSql(req.data.dataBase, idRoom));

    // 联系人同步 + 旧联系人清理(同下葬页修改) 20260923 新增,
    try {
      let contactsChanged = false;
      const contactsStatements = await buildContactsSyncStatements(
        req.data.dataBase, idRoom, contactsName, contactsPhone, contactsIDCard, req.data.userName,
      );
      if (contactsStatements.length > 0) {
        sqlList.push(...contactsStatements);
        contactsChanged = true;
      }

      const oldContacts = oldContactsRow ? oldContactsRow.contacts : null;
      const oldPhone = oldContactsRow ? oldContactsRow.contactsphone : null;
      const oldContactsValid = oldContacts !== null && oldContacts !== undefined && String(oldContacts).trim() !== '';
      const newName = contactsName === undefined || contactsName === null ? '' : String(contactsName).trim();
      if (oldContactsValid && String(oldContacts).trim() !== newName) {
        const conditionParts = ['idRoom = ?', 'contacts = ?', 'isDeleted = 0'];
        const conditionParams = [idRoom, String(oldContacts).trim()];
        if (oldPhone !== null && oldPhone !== undefined && String(oldPhone).trim() !== '') {
          conditionParts.push('contactsPhone = ?');
          conditionParams.push(String(oldPhone).trim());
        }
        sqlList.push(public.getUpdateByConditionStatement({
          table: req.data.dataBase + '.contacts',
          condition: { sql: conditionParts.join(' AND '), params: conditionParams },
          isDeleted: 1,
          operator: req.data.userName,
        }));
        contactsChanged = true;
      }

      if (contactsChanged) {
        sqlList.push(public.getRoomContactsSyncSql(req.data.dataBase, idRoom));
      }
    } catch (error) {
      return public.handleQueryError(res, error);
    }

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

  // 默认(业务形态):仅更新本业务表 20260923 新增,
  const idBusiness = public.parseNumericParam(req.body.idBusiness);
  if (idBusiness === null) {
    return res.status(400).json({ error: 'idBusiness参数错误!' });
  }

  delete req.body.deceased;
  delete req.body.burialDate;
  delete req.body.deceasedIDCard;
  delete req.body.deceasedRelation;
  delete req.body.contacts;
  delete req.body.contactsphone;
  delete req.body.contactsIDCard;
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

