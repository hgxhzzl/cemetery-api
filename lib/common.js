// 通用小工具:日期字段判定与日期值归一、当前时间字符串、请求参数读取与数值解析、金额格式化(由 public.js 拆出,审查修复 20261021 P1-7)。
// 对外口径不变:public.js 门面仍再导出本模块全部成员,调用点无需改动。



const dateFieldPattern = /(date|time)$/i;

//将ISO-8601时间(带T和Z)转为MySQL标准格式YYYY-MM-DD HH:mm:ss,按本地时区转换避免偏移8小时 20260827联调修复,
function normalizeDateValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value)) {
    return value;
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function normalizeValues(values) {
  return values.map((value) => normalizeDateValue(value));
}

// 这两个日期值归一函数原先只在 public.js 内部自用(未导出),拆模块后成为 sqlBuilder 的跨模块依赖,
// 因此必须升级为模块级导出;门面 public.js 会一并再导出,不影响任何既有调用点 20261021 审查修复 P1-7,
exports.normalizeDateValue = normalizeDateValue;
exports.normalizeValues = normalizeValues;

//生成MySQL标准格式当前时间YYYY-MM-DD HH:mm:ss,避免toLocaleString受系统locale影响 20260915 优化,
function getCurrentDateTime() {
  const date = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

exports.getCurrentDateTime = getCurrentDateTime;

//日期类字段空字符串转NULL,避免Incorrect date/datetime value错误 20260827联调修复,
exports.normalizeBodyDates = function (body) {
  if (!body || typeof body !== 'object') {
    return body;
  }

  Object.keys(body).forEach((key) => {
    if (!dateFieldPattern.test(key)) {
      return;
    }

    if (body[key] === '') {
      body[key] = null;
      return;
    }

    body[key] = normalizeDateValue(body[key]);
  });

  return body;
}

// 写口参数取值:破坏性接口已从 GET 迁到 POST(参数放 body),但取值仍兼容 query,
// 避免前后端不同发布窗口里一边改完另一边未跟上造成 400 20261021 审查修复 P0-1,
exports.readParam = function (req, name) {
  const bodyValue = req.body ? req.body[name] : undefined;
  if (bodyValue !== undefined && bodyValue !== null && bodyValue !== '') {
    return bodyValue;
  }
  return req.query ? req.query[name] : undefined;
}

exports.parseNumericParam = function (value) {
  const normalizedValue = String(value || '').trim();
  if (!/^\d+$/.test(normalizedValue)) {
    return null;
  }

  return normalizedValue;
}

// 请求日志脱敏(审查修复 20261021 P2):原写法直接 console.log(req.originalUrl),而本项目的查询串/路径
// 里大量出现手机号、账户名、联系人姓名(登录名就是手机号),这些内容会进日志文件与日志平台,
// 留存周期远超业务数据本身;现按“参数名命中敏感词”与“值形似手机号”双重判定脱敏,
// 只保留可定位问题的前 3 后 4,仅供排查使用;本函数不打完整参数值,也不影响业务 SQL 参数,
const sensitiveQueryKeyPattern = /(phone|mobile|password|passwd|pwd|idcard|idno|cardno|name|account|contact|user)/i;
const phoneValuePattern = /^(\d{3})\d{4}(\d{4})$/;

exports.maskQueryValue = function (key, value) {
  const hit = phoneValuePattern.exec(String(value || ''));
  if (hit) {
    return `${hit[1]}****${hit[2]}`;
  }
  if (sensitiveQueryKeyPattern.test(String(key || ''))) {
    return '***';
  }
  return value;
}

exports.maskRequestTarget = function (target) {
  const text = String(target || '');
  const index = text.indexOf('?');
  if (index === -1) {
    // 无查询串时仍需处理“手机号直接拼在路径上”的历史接口,11 位连续数字一律中间脱敏,
    return text.replace(/(\d{3})\d{4}(\d{4})/g, '$1****$2');
  }

  const head = text.slice(0, index);
  const maskedQuery = text
    .slice(index + 1)
    .split('&')
    .filter(Boolean)
    .map((item) => {
      const eq = item.indexOf('=');
      if (eq === -1) {
        return item;
      }
      return `${item.slice(0, eq)}=${exports.maskQueryValue(item.slice(0, eq), item.slice(eq + 1))}`;
    })
    .join('&');

  return `${exports.maskRequestTarget(head)}${maskedQuery ? '?' + maskedQuery : ''}`;
}

exports.format = function (num) {
  var reg=/\d{1,3}(?=(\d{3})+$)/g;
  return (num + '').replace(reg, '$&,');
}
