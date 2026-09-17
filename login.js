const express = require('express');
const router = express.Router();
const bublicfun = require('./public.js');
const getToken = require('./token.js');
const loginState = require('./loginState');
// 创建 MySQL 连接池
const pool = require('./database.js');

module.exports = router;
// 用户登录:promise链展平为纯async,错误统一由catch兜底 20260917 风格统一,
router.post('/', async (req, res) => {
  const phone = req.body.username;
  const password = req.body.password; 
  try {
    // 检查用户名是否存在
    const results = await pool.query('SELECT a.idOperator as userid,a.name as username,a.phone as phone,b.endDate as endDate,'+
      'b.dataBaseName as dataBaseName,a.isAccount as isAccount,a.password as password '+
      'FROM gm_data_000.operator a,gm_data_000.account b '+
      'WHERE a.dataBaseName = b.dataBaseName and a.isDeleted = 0 and b.isDeleted = 0 and a.phone = ?', [phone]);
    if (results.length === 0) {
      return res.status(401).json({ code: 401, message: 'Invalid username or password' });
    }

    const user = results[0];
    // 验证密码是否匹配:bcrypt哈希优先比对,兼容存量明文 20260915 安全改造,
    const valid = await bublicfun.verifyPassword(password, user.password);
    if (!valid) {
      return res.status(401).json({ code: 401, message: 'Invalid username or password' });
    }
    // 存量明文密码校验通过后自动升级为bcrypt存储,升级失败不影响本次登录 20260915 安全改造,
    if (!bublicfun.isBcryptHash(user.password)) {
      bublicfun.hashPassword(user.password).then((hashed) => {
        pool.query('UPDATE gm_data_000.operator SET password = ? WHERE idOperator = ?', [hashed, user.userid], () => {});
      }).catch(() => {});
    }
    // 生成 JWT 令牌
    const userid = user.userid;
    const userName = user.username;
    const dataBaseName = user.dataBaseName;
    const token = getToken.setToken(phone,userName,dataBaseName,userid,Number(user.isAccount));
    const info = 'Bearer '+token;
    //取到到期时间戳
    const exp =  getToken.verTokenNew(info).exp;
    // 登录态持久化到 gm_data_000.login_session,写入失败登录流程终止 20260917 登录态DB化,
    await loginState.setActiveLogin(phone, exp);

    const json={};
    json.token = info;
    json.userName = userName;
    json.userPhone = phone;
    json.userId = user.userid;
    json.userInfo = {roles:[]};
    const sql = 'SELECT * FROM gm_data_000.operator_power a WHERE a.idOperator = ?';

    const roleResults = await pool.query(sql, [user.userid]);
    json.userInfo.roles = roleResults;

    return res.status(200).json({ code: 0, message: "登录成功", data: json });
  } catch (error) {
    return bublicfun.handleQueryError(res, error);
  }
});
// 用户登出:删除 login_session 登录态记录,当前 token 立即失效(后续请求活跃登录态校验不通过) 20260917 接线,
router.post('/logout', async (req, res) => {
  try {
    await loginState.deleteActiveLogin(req.data.phone);
    return res.status(200).json({ code: 0, message: '登出成功' });
  } catch (error) {
    return bublicfun.handleQueryError(res, error);
  }
});

