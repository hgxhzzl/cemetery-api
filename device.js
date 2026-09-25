// 登录设备白名单:全局白名单模式(所有员工共用一批指定电脑),持久化到 gm_data_000.device 20260924 新增,
// 设备哈希由客户端 Agent 计算上报:SHA256(硬盘序列号|主板序列号|MachineGuid),物理属性为主防软件层伪造,
const express = require('express');

const router = express.Router();
const bublicfun = require('./public.js');
const pool = require('./database.js');

module.exports = { router, ensureTable, isDeviceAllowed, registerDevice, disableDevice };

// 幂等建表:启动时确保 device 存在,与 loginState.ensureTable 同模式 20260924 新增,
async function ensureTable() {
  await pool.query(
    'CREATE TABLE IF NOT EXISTS gm_data_000.device (' +
      "idDevice int NOT NULL AUTO_INCREMENT COMMENT '设备ID', " +
      "deviceHash varchar(64) NOT NULL COMMENT '设备哈希(SHA256:硬盘序列号+主板序列号+MachineGuid)', " +
      "deviceName varchar(100) DEFAULT NULL COMMENT '电脑名', " +
      "useStatus tinyint DEFAULT 1 COMMENT '启用状态:1启用/0停用', " +
      "createDate datetime DEFAULT NULL COMMENT '登记时间', " +
      "updateDate datetime DEFAULT NULL COMMENT '更新时间', " +
      'PRIMARY KEY (idDevice), UNIQUE KEY uk_deviceHash (deviceHash)' +
      ") ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='登录设备白名单表'",
  );
}

// 白名单校验:哈希命中且启用才放行,供 login.js 在账号密码通过后调用
async function isDeviceAllowed(deviceHash) {
  if (!deviceHash) return false;
  const rows = await pool.query(
    'SELECT COUNT(*) AS cnt FROM gm_data_000.device WHERE deviceHash = ? AND useStatus = 1',
    [deviceHash],
  );
  return Array.isArray(rows) && rows.length > 0 && Number(rows[0].cnt) > 0;
}

// 登记设备:白名单新增,幂等(哈希已存在时恢复启用并刷新电脑名,重装系统后重新登记即重新入列)
async function registerDevice(deviceHash, deviceName) {
  await pool.query(
    'INSERT INTO gm_data_000.device (deviceHash, deviceName, useStatus, createDate, updateDate) ' +
      'VALUES (?, ?, 1, NOW(), NOW()) ' +
      'ON DUPLICATE KEY UPDATE deviceName = VALUES(deviceName), useStatus = 1, updateDate = NOW()',
    [deviceHash, deviceName || ''],
  );
}

// 停用设备:旧电脑淘汰时软删(useStatus=0),不物理删行保留登记痕迹
async function disableDevice(deviceHash) {
  await pool.query('UPDATE gm_data_000.device SET useStatus = 0, updateDate = NOW() WHERE deviceHash = ?', [
    deviceHash,
  ]);
}

// 仅平台管理员(isAccount=1)可操作设备白名单:登记/停用是管理动作,普通操作员无权改动指定电脑范围
function requireAdmin(req, res) {
  if (Number(req.data?.isAccount) !== 1) {
    res.status(403).json({ code: 403, message: '仅平台管理员可操作设备白名单' });
    return false;
  }
  return true;
}

// 设备登记:管理员在指定电脑上登录后调用,把该电脑哈希写入白名单(替代手工抄哈希插 SQL)
router.post('/bind', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const deviceHash = String(req.body.deviceHash || '');
    if (!/^[0-9a-f]{64}$/.test(deviceHash)) {
      return res.status(400).json({ code: 400, message: '设备哈希格式不正确' });
    }
    await registerDevice(deviceHash, String(req.body.deviceName || ''));
    return res.status(200).json({ code: 0, message: '设备登记成功' });
  } catch (error) {
    return bublicfun.handleQueryError(res, error);
  }
});

// 白名单列表:管理员运维查看(哪台电脑何时登记、是否启用)
router.post('/list', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const rows = await pool.query(
      'SELECT idDevice, deviceHash, deviceName, useStatus, createDate, updateDate FROM gm_data_000.device ORDER BY idDevice DESC',
    );
    return res.status(200).json({ code: 0, message: '查询成功', data: { list: rows } });
  } catch (error) {
    return bublicfun.handleQueryError(res, error);
  }
});

// 停用设备:旧电脑淘汰时下线,重新启用走 /bind 重新登记
router.post('/disable', async (req, res) => {
  try {
    if (!requireAdmin(req, res)) return;
    const deviceHash = String(req.body.deviceHash || '');
    if (!/^[0-9a-f]{64}$/.test(deviceHash)) {
      return res.status(400).json({ code: 400, message: '设备哈希格式不正确' });
    }
    await disableDevice(deviceHash);
    return res.status(200).json({ code: 0, message: '设备已停用' });
  } catch (error) {
    return bublicfun.handleQueryError(res, error);
  }
});
