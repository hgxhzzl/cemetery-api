const express = require('express');
const router = express.Router();
const pool = require('../database');
const public = require('../public');
const rbac = require('../rbac');
const permissionTemplate = require('../lib/permissionTemplate');
module.exports = router;

// 菜单总开关(useMenu)单字段翻转:权限页"菜单"列勾选走本接口。
// 旧的 useCreate/useModify/useDelete/useExamine/useFinish/usePower 布尔列已迁移到功能权限矩阵
// (统一走下方 /config 整块写 powerConfig),故此处白名单收窄为仅 useMenu 20261023,
const allowedFields = new Set(['useMenu']);

router.post('/power', async (req, res) => {
  const field = req.body.field;
  const idPower = public.parseNumericParam(req.body.idPower);

  if (!allowedFields.has(field)) {
    return public.respondError(res, 400, 'Invalid field');
  }

  if (idPower === null) {
    return public.respondError(res, 400, 'idPower参数错误!');
  }

  // 非平台管理员仅可切换本租户操作员的权限 20260917 越权收口,
  const tenantSql = rbac.isPlatformAdmin(req)
    ? 'where idPower = ?'
    : 'where idPower = ? and idOperator in (select idOperator from gm_data_000.operator where dataBaseName = ?)';
  const sqlParams = rbac.isPlatformAdmin(req) ? [idPower] : [idPower, req.data.dataBase];
  const sql = `update gm_data_000.operator_power
    set ${field} = case when ${field} = 1 then 0 else 1 end
    ${tenantSql}`;

  try {
    const results = await pool.query(sql, sqlParams);
    // 权限开关落库后立即作废守卫缓存,不再让操作员在 30s TTL 内拿到旧权限(审查修复 20261021 P2 性能),
    rbac.invalidateAuthCaches();
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
});

// 功能级权限白名单整块写入(20261023 功能级权限改造新增):
// body { idPower, grants },grants 为该菜单当前完整的勾选集(形如
// { "sale": {"actions": {"create":1,"modify":1}}, "buried":{"actions":{"modify":1}} },只含被勾选项)。
// 采用白名单(缺省禁止):只落被显式开成 1 的动作,其余不写;
// 整块覆写而非单键切换——首次从 NULL 转非 NULL 时若只写一键会把其它全误锁,
// 故一次提交该菜单全部勾选项,后端重建整份 powerConfig 后参数化整列 UPDATE。
// 勾空(全部取消)→ 写 {} = 全禁,与"白名单缺省禁止"语义一致。
router.post('/config', async (req, res) => {
  const idPower = public.parseNumericParam(req.body.idPower);
  if (idPower === null) {
    return public.respondError(res, 400, 'idPower参数错误!');
  }
  const grants = req.body.grants;
  // grants 必须是对象(允许空对象 {} = 全禁);null/数组/标量一律拒,
  if (grants === null || typeof grants !== 'object' || Array.isArray(grants)) {
    return public.respondError(res, 400, 'grants 必须为权限勾选对象!');
  }

  // 租户越权约束沿用 /power 口径:非平台管理员仅可改本租户操作员的权限行,
  // SELECT 需要表别名 a/m;UPDATE 未声明别名,必须用无别名的独立条件,
  // 否则 MySQL 报 Unknown column 'a.idPower' → 500(所有菜单保存功能权限都会中)20261023 修复,
  const tenantCond = rbac.isPlatformAdmin(req)
    ? 'a.idPower = ?'
    : 'a.idPower = ? and a.idOperator in (select idOperator from gm_data_000.operator where dataBaseName = ?)';
  const updateCond = rbac.isPlatformAdmin(req)
    ? 'idPower = ?'
    : 'idPower = ? and idOperator in (select idOperator from gm_data_000.operator where dataBaseName = ?)';
  const tenantParams = rbac.isPlatformAdmin(req) ? [idPower] : [idPower, req.data.dataBase];

  try {
    // 取该权限行所属菜单名、所属操作员与功能模板:用于按 menu.powerConfig 校验功能/动作键,
    // 确认该菜单确实纳入功能级管控,并识别“改自己的授权”这种自锁场景 20261023 补强,
    const rows = await pool.query(
      `SELECT a.idOperator AS idOperator, m.name AS menuName, m.powerConfig AS menuTemplate FROM gm_data_000.operator_power a
       JOIN gm_data_000.menu m ON m.id = a.idMenu
       WHERE ${tenantCond} LIMIT 1`,
      tenantParams,
    );
    if (!Array.isArray(rows) || rows.length === 0) {
      return public.respondError(res, 403, '无权限:目标权限记录不存在或不属于当前租户!');
    }
    const menuName = String(rows[0].menuName);
    const menuTemplate = permissionTemplate.parseTemplate(rows[0].menuTemplate);
    if (!menuTemplate) {
      return public.respondError(res, 400, `菜单 '${menuName}' 未纳入功能级权限管控!`);
    }

    // 白名单校验+归一:grants 里每个 fn/action 必须存在于该菜单 menu.powerConfig 模板;仅保留值为 1 的动作,
    // 空 actions 的功能项剔除,避免落库残留无意义的空壳,
    const normalized = {};
    for (const [fn, fnVal] of Object.entries(grants)) {
      if (!permissionTemplate.isValidFnInTemplate(menuTemplate, fn)) {
        return public.respondError(res, 400, `非法功能键:${fn}`);
      }
      const actions = (fnVal && typeof fnVal === 'object' && fnVal.actions) || {};
      const grantedActions = {};
      let hasGrant = false;
      for (const [action, value] of Object.entries(actions)) {
        if (!permissionTemplate.isValidActionInTemplate(menuTemplate, fn, action)) {
          return public.respondError(res, 400, `非法动作键:${fn}.${action}`);
        }
        if (Number(value) === 1) {
          grantedActions[action] = 1;
          hasGrant = true;
        }
      }
      if (hasGrant) {
        normalized[fn] = { actions: grantedActions };
      }
    }

    // 防自锁:非平台管理员不能取消自己的“操作人员-授权”动作。
    // 授权动作是权限页所有写接口的入口,一旦自我移除,后续任何勾选都会 403 且无法自我恢复,
    // 只能由平台管理员或仍有授权动作的同事改回(此前表现为点掉授权后页面继续可点但全部报无权限)20261023 新增,
    const selfPowerRevoked =
      menuName === 'operator' &&
      Number(rows[0].idOperator) === Number(req.data.userId) &&
      !(normalized.operator && normalized.operator.actions && Number(normalized.operator.actions.power) === 1);
    if (!rbac.isPlatformAdmin(req) && selfPowerRevoked) {
      return public.respondError(res, 400, '不能取消自己的授权权限!');
    }

    // 整列覆写:勾空时 normalized 为 {}(全禁),与白名单缺省禁止一致;json 列接受合法 JSON 字符串参数,
    const results = await pool.query(
      `update gm_data_000.operator_power set powerConfig = ? where ${updateCond}`,
      [JSON.stringify(normalized), ...tenantParams],
    );
    // 功能级白名单变更后立即作废守卫缓存,使当前操作员下一次请求即按新配置判定,
    rbac.invalidateAuthCaches();
    return public.respondAffectedRows(res, results);
  } catch (error) {
    return public.handleQueryError(res, error);
  }
})
