// 统一授权守卫:平台管理员判定、全局管理接口授权、RBAC 菜单动作校验 20260917 越权收口,
const pool = require('./database');
const public = require('./public');

// 平台管理员:gm_data_000 租户的账户(isAccount=1);旧 token 无 isAccount 字段时安全默认非管理员,
function isPlatformAdmin(req) {
  return Number(req.data && req.data.isAccount) === 1 && req.data.dataBase === 'gm_data_000';
}

// 全局管理接口中间件:仅平台管理员可调用 20260917 越权收口,
function requirePlatformAdmin(req, res, next) {
  if (isPlatformAdmin(req)) {
    return next();
  }
  return res.status(403).json({ error: '无权限:仅平台管理员可操作!' });
}

// RBAC 动作 → operator_power 列名(白名单,非用户输入) 20260917 新增,
const POWER_FIELD_BY_ACTION = {
  menu: 'useMenu',
  create: 'useCreate',
  modify: 'useModify',
  delete: 'useDelete',
};

// RBAC 中间件:校验当前操作员在指定菜单下具备指定动作权限;平台管理员全放行,
function requirePower(menuId, action) {
  const field = POWER_FIELD_BY_ACTION[action];
  return async function (req, res, next) {
    if (isPlatformAdmin(req)) {
      return next();
    }
    try {
      const sql =
        'SELECT 1 FROM gm_data_000.operator_power a ' +
        'JOIN gm_data_000.operator b ON a.idOperator = b.idOperator ' +
        'WHERE b.idOperator = ? and b.isDeleted = 0 and a.idMenu = ? and a.useMenu = 1 and a.' + field + ' = 1';
      const rows = await pool.query(sql, [req.data.userId, menuId]);
      if (Array.isArray(rows) && rows.length > 0) {
        return next();
      }
      return res.status(403).json({ error: '无权限:当前账号缺少该菜单操作权限!' });
    } catch (error) {
      return public.handleQueryError(res, error);
    }
  };
}

module.exports = { isPlatformAdmin, requirePlatformAdmin, requirePower };
