const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 删除管理费收款:软删除选中的收款记录(按 idAdminfee 置 isDeleted=1);
// 删除后按剩余活动收款记录做期限链式顺延(口径同收管理费新建/修改),room.endDate 取链尾;
// 无剩余记录则结束日期回退为开始日期 20260910 新增, 20261018 改为整链重排,
router.get('/', async (req, res) => {
  const idAdminfee = public.parseNumericParam(req.query.idAdminfee);
  if (idAdminfee === null) {
    return res.status(400).json({ error: 'idAdminfee参数错误!' });
  }

  const dataBase = req.data.dataBase;

  // 先取该收款记录所属墓位与全部活动收款记录,供删除后按剩余记录顺延(软删语句在事务内、查询时尚未生效,故内存里剔除本次删除项) 20261018 修改,
  let idRoom = null;
  let activeRows;
  try {
    const results = await pool.query(`select idRoom from ${dataBase}.adminfee where idAdminfee = ?`, [idAdminfee]);
    idRoom = results && results.length > 0 ? public.parseNumericParam(results[0].idRoom) : null;
    if (idRoom === null) {
      return res.status(400).json({ error: 'idRoom参数错误!' });
    }
    activeRows = await public.listActiveFeeRows(dataBase, idRoom);
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  // 软删除选中的收款记录(idAdminfee 已校验为纯数字,拼接安全)
  const statement = public.getUpdateByIdStatement({
    table: dataBase + '.adminfee',
    idfield: 'idAdminfee',
    idvalue: idAdminfee,
    isDeleted: 1,
    operator: req.data.userName,
  });

  const remaining = (activeRows || []).filter((row) => String(row.idAdminfee) !== String(idAdminfee));
  const sqlList = [statement];

  // 无剩余记录:回到"无收款"态——有活动下葬则 startDate=endDate=min(burialDate),无下葬则两者置空(③) 20260910 新增 20261018 改为按 min 回退,
  if (remaining.length === 0) {
    try {
      const minRows = await pool.query(
        `select min(burialDate) as minBurial from ${dataBase}.buried where idRoom = ? and isDeleted = 0`,
        [idRoom],
      );
      const minBurial = public.feeMinDay(minRows && minRows.length > 0 ? minRows[0].minBurial : null);
      if (minBurial) {
        const anchorStr = public.fmtFeeDay(minBurial);
        sqlList.push({
          sql: `update ${dataBase}.room set startDate = ?, endDate = ? where idRoom = ?`,
          params: [anchorStr, anchorStr, idRoom],
        });
      } else {
        sqlList.push({
          sql: `update ${dataBase}.room set startDate = null, endDate = null where idRoom = ?`,
          params: [idRoom],
        });
      }
    } catch (error) {
      return public.handleQueryError(res, error);
    }
    return public.Transaction(sqlList, res);
  }

  // 有剩余记录:整链重排——锚定起始日优先 room.startDate,为空回落剩余记录最早开始日期;
  // 逐条与库中现值比对,偏离者出更新语句;room.endDate 取链尾、startDate 仅空时兜底(同新建/修改) 20261018 新增,
  try {
    const earliestStart = remaining
      .map((row) => public.feeDayStr(row.startDate))
      .filter((s) => s !== '')
      .sort()[0];
    const anchorDay = await public.findFeePeriodAnchor(dataBase, idRoom, earliestStart);
    if (anchorDay) {
      const { targets, tailDate } = public.computeFeePeriodCascade(anchorDay, remaining);
      targets.forEach(({ row, startDate: startStr, endDate: endStr }) => {
        if (public.feeDayStr(row.startDate) !== startStr || public.feeDayStr(row.endDate) !== endStr) {
          sqlList.push(public.getUpdateByIdStatement({
            table: dataBase + '.adminfee',
            idfield: 'idAdminfee',
            idvalue: row.idAdminfee,
            startDate: startStr,
            endDate: endStr,
            operator: req.data.userName,
          }));
        }
      });
      sqlList.push({
        sql: `update ${dataBase}.room set startDate = coalesce((select min(burialDate) from ${dataBase}.buried where idRoom = ? and isDeleted = 0), startDate, ?), endDate = ? where idRoom = ?`,
        params: [idRoom, public.fmtFeeDay(anchorDay), tailDate, idRoom],
      });
    } else {
      // 无法确定锚点(剩余记录均无开始日期且 room.startDate 为空):退回旧口径,结束日期取剩余记录最大结束日期 20261018 补充,
      sqlList.push({
        sql: `update ${dataBase}.room set endDate = coalesce((select max(endDate) from ${dataBase}.adminfee where idRoom = ? and isDeleted = 0 and idAdminfee <> ?), startDate) where idRoom = ?`,
        params: [idRoom, idAdminfee, idRoom],
      });
    }
  } catch (error) {
    return public.handleQueryError(res, error);
  }

  return public.Transaction(sqlList, res);
});

