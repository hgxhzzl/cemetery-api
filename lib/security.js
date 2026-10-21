// 口令与初始密码:bcrypt 哈希/校验、初始密码生成、提交口令强度校验(由 public.js 拆出,审查修复 20261021 P1-7)。
// 对外口径不变:public.js 门面仍再导出本模块全部成员,调用点无需改动。

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

//bcrypt哈希特征前缀,用于区分存量明文密码 20260915 安全改造,
const bcryptPrefix = /^\$2[aby]\$/;

//密码哈希:统一使用 bcrypt 存储,登录与改密写入时调用 20260915 安全改造,
exports.hashPassword = function (password) {
  return bcrypt.hash(String(password || ''), 10);
}

//判断是否为bcrypt哈希(以 $2a/$2b/$2y 开头) 20260915 安全改造,
exports.isBcryptHash = function (value) {
  return bcryptPrefix.test(String(value || ''));
}

// 初始口令生成:不再拿手机号等可猜测信息当初始口令(登录名就是手机号,等于口令公开),
// 改为服务端随机生成(去掉易混字符 i/l/o/0/1),仅在新建成功的那一次响应里回显明文供管理员转告,库中只存 bcrypt 哈希 20261021 审查修复 中E,
const INITIAL_PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
exports.generateInitialPassword = function (length) {
  const len = Math.max(6, Number(length) || 10);
  let output = '';
  for (let i = 0; i < len; i += 1) {
    output += INITIAL_PASSWORD_ALPHABET[crypto.randomInt(INITIAL_PASSWORD_ALPHABET.length)];
  }
  return output;
}

// 提交口令的基础强度校验:至少 6 位且不得等于登录手机号;通过返回空串,否则返回提示信息 20261021 审查修复 中E,
exports.validateSubmittedPassword = function (password, phone) {
  const value = password === undefined || password === null ? '' : String(password);
  if (value.length < 6) {
    return '口令不得少于6位，请重新填写!';
  }
  if (phone && value === String(phone)) {
    return '口令不得与登录手机号相同，请重新填写!';
  }
  return '';
}

//密码校验:bcrypt哈希优先比对,非哈希时兼容存量明文比对;恒resolve(true/false) 20260915 安全改造,
exports.verifyPassword = function (input, stored) {
  const storedStr = String(stored || '');
  if (bcryptPrefix.test(storedStr)) {
    return bcrypt.compare(String(input || ''), storedStr).catch(() => false);
  }

  return Promise.resolve(String(input || '') === storedStr);
}
