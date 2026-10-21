// 口令与初始密码:哈希/校验、初始密码生成、提交口令强度校验(由 public.js 拆出,审查修复 20261021 P1-7)。
// 对外口径不变:public.js 门面仍再导出本模块全部成员,调用点无需改动。

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

//bcrypt哈希特征前缀,用于区分存量明文密码 20260915 安全改造,
const bcryptPrefix = /^\$2[aby]\$/;
// 新口径前缀:scrypt(审查修复 20261021 二轮 P1-6)
// 原写法用 bcryptjs(纯 JS 实现):实测 cost=10 时 hash 65ms、compare 60ms,且它的“异步”API
// 同样在主线程上跑(事件循环最大停摆 121ms),登录/改密/新建账户的每一次口令运算都会把
// 整个服务卡住一次;node 自带的 crypto.scrypt 在 libuv 线程池上执行,主线程不再停摆。
// 存量化解:旧 bcrypt 哈希($2a/$2b/$2y)与明文仍走原有比对分支,登录成功时顺手升级为 scrypt,
const scryptPrefix = 'scrypt$';
const SCRYPT_PARAMS = { N: 2 ** 15, r: 8, p: 1 };
const SCRYPT_KEYLEN = 32;
// scrypt 内存上限需大于 N*r*128 字节(32MB),默认 maxmem 正好是 32MB 会报“memory cost is too small”,
const SCRYPT_MAXMEM = 64 * 1024 * 1024;

const scryptAsync = (password, salt, keylen, options) =>
  new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keylen, options, (error, value) => (error ? reject(error) : resolve(value)));
  });

// 口令哈希:格式 scrypt$N$r$p$<saltB64>$<hashB64>
// 两段均用 base64 而不是 hex:operator/account.password 列是 varchar(100)(见 gm_data_000.sql),
// hex 形式会达到 146 字被截断导致登录永远失败;base64 字母表不含 $,不会被 split('$') 误分,
// 也不会被 normalizeSql 的 $N 归一误伤,本串总长 86 字,
exports.hashPassword = async function (password) {
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(String(password || ''), salt, SCRYPT_KEYLEN, {
    ...SCRYPT_PARAMS,
    maxmem: SCRYPT_MAXMEM,
  });
  return `${scryptPrefix}${SCRYPT_PARAMS.N}$${SCRYPT_PARAMS.r}$${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

//判断是否为bcrypt哈希(以 $2a/$2b/$2y 开头) 20260915 安全改造,
exports.isBcryptHash = function (value) {
  return bcryptPrefix.test(String(value || ''));
}

// 是否为新版 scrypt 哈希,
exports.isScryptHash = function (value) {
  return String(value || '').startsWith(scryptPrefix);
}

// 是否已经是一个哈希值(bcrypt 或 scrypt):用于区分“前端回填的旧哈希”与“本次提交的新明文”,
// 避免二次哈希把口令搞坏(原写法只判 bcrypt,哈希格式一旦切换就会漏判),
exports.looksHashed = function (value) {
  const text = String(value || '');
  return bcryptPrefix.test(text) || text.startsWith(scryptPrefix);
}

// 是否需要升级存储形式(非 scrypt 就当要升级:明文/bcrypt 都在登录成功后顺手换成 scrypt),
exports.needsPasswordUpgrade = function (value) {
  return !String(value || '').startsWith(scryptPrefix);
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

// 口令校验:scrypt 优先,其次 bcrypt(存量),都不是时兼容存量明文比对;恒 resolve(true/false) 20260915 安全改造,
// 20261021 审查修复二轮 P1-6:新增 scrypt 分支(线程池上算,不再卡主线程),
exports.verifyPassword = async function (input, stored) {
  const storedStr = String(stored || '');
  const inputStr = String(input || '');
  if (storedStr.startsWith(scryptPrefix)) {
    // 格式 scrypt$N$r$p$salt$hash:段数不对或解析失败一律视为不匹配(避免脏数据导致抛错),
    const parts = storedStr.slice(scryptPrefix.length).split('$');
    if (parts.length !== 5) {
      return false;
    }
    const [n, r, p, saltB64, hashB64] = parts;
    try {
      const expected = Buffer.from(hashB64, 'base64');
      const derived = await scryptAsync(inputStr, Buffer.from(saltB64, 'base64'), expected.length, {
        N: Number(n),
        r: Number(r),
        p: Number(p),
        maxmem: SCRYPT_MAXMEM,
      });
      // 等长且恒时比较:长度不等直接 false,timingSafeEqual 自体会抛错,
      return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
    } catch (error) {
      return false;
    }
  }

  if (bcryptPrefix.test(storedStr)) {
    return bcrypt.compare(inputStr, storedStr).catch(() => false);
  }

  return Promise.resolve(inputStr === storedStr);
}
