const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
module.exports = router;

// 删除管理费收款:软删除选中的收款记录(按 idAdminfee 置 isDeleted=1);
// 删除后按剩余活动收款记录做期限链式顺延(口径同收管理费新建/修改),room.endDate 取链尾;
// 无剩余记录则结束日期回退为开始日期 20260910 新增, 20261018 改为整链重排,
router.post('/', async (req, res) => {
  const idAdminfee = public.parseNumericParam(public.readParam(req, 'idAdminfee'));
  if (idAdminfee === null) {
    return res.status(400).json({ error: 'idAdminfee参数错误!' });
  }

  const dataBase = req.data.dataBase;

  // 先取该收款记录所属墓位(仅用于定位后续语句),活动收款行的读取与顺延重排全部改到事务内 20261021 审查修复中C 修改,
  let idRoom = null;
  try {
    const results = await pool.query(`select idRoom from ${dataBase}.adminfee where idAdminfee = ?`, [idAdminfee]);
    idRoom = results && results.length > 0 ? public.parseNumericParam(results[0].idRoom) : null;
  } catch (error) {
    return public.handleQueryError(res, error);
  }
  if (idRoom === null) {
    return res.status(400).json({ error: 'idRoom参数错误!' });
  }

  // 软删除选中的收款记录(idAdminfee 已校验为纯数字,拼接安全)
  const statement = public.getSoftDeleteByIdStatement({
    table: dataBase + '.adminfee',
    idfield: 'idAdminfee',
    idvalue: idAdminfee,
    isDeleted: 1,
    operator: req.data.userName,
  });

  const sqlList = [statement];

  // 删后顺延全部收进同一事务:先锁墓位行,再在事务内读剩余活动收款行——软删语句已在本事务内先执行,
  // 读到的行天然排除本次删除项,既不再需要内存剔除,也不会拿事务外旧快照覆写并发写入的结果 20261021 审查修复中C 重写,
  // 无剩余记录→回到“无收款”态(有活动下葬则 startDate=endDate=min(burialDate),无下葬则两者置空);
  // 有剩余记录→以链首为基准整链重排,room.endDate 取链尾 20261018 口径不变,
  sqlList.push(async (conn) => {
    await public.lockFeeChainRoot(conn, dataBase, idRoom);
    const remaining = await public.listActiveFeeRowsWith(conn, dataBase, idRoom);
    const earliestStart = remaining
      .map((row) => public.feeDayStr(row.startDate))
      .filter((s) => s !== '')
      .sort()[0];
    const anchorDay = await public.findFeePeriodAnchorWith(conn, dataBase, idRoom, earliestStart);
    if (!anchorDay && remaining.length > 0) {
      // 无法确定链首(剩余记录均无开始日期且无活动下葬、room.startDate 也为空):退回旧口径,结束日期取剩余记录最大结束日期 20261018 补充,
      await public.execWith(conn, [{
        sql: `update ${dataBase}.room set endDate = coalesce((select max(endDate) from ${dataBase}.adminfee where idRoom = ? and isDeleted = 0), startDate) where idRoom = ?`,
        params: [idRoom, idRoom],
      }]);
      return;
    }
    await public.applyFeePeriodRecascadeTx(conn, dataBase, idRoom, req.data.userName, anchorDay, remaining);
  });

  return public.Transaction(sqlList, res);
});

