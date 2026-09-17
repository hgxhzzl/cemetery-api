require('dotenv').config();

function toNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

// 敏感配置检测:必须通过环境变量提供,不允许内置默认值;缺失即拒绝启动,避免误连远端真实数据库 20260917 凭据收口,
function buildSecurityWarnings() {
  const warnings = [];
  const fatal = [];
  if (!process.env.JWT_SECRET) {
    fatal.push('JWT_SECRET 未配置,必须通过环境变量提供,不允许内置默认密钥');
  }
  if (!process.env.MYSQL_PASSWORD && !process.env.DB_PASSWORD) {
    fatal.push('MYSQL_PASSWORD 未配置,必须通过环境变量提供,不允许内置默认密码');
  }
  if (!process.env.MYSQL_HOST && !process.env.DB_HOST) {
    fatal.push('MYSQL_HOST 未配置,必须通过环境变量提供');
  }
  if (!process.env.MYSQL_USER && !process.env.DB_USER) {
    fatal.push('MYSQL_USER 未配置,必须通过环境变量提供');
  }
  if (!process.env.MYSQL_DATABASE && !process.env.DB_NAME) {
    fatal.push('MYSQL_DATABASE 未配置,必须通过环境变量提供');
  }
  return { warnings, fatal };
}

const security = buildSecurityWarnings();

const config = {
  app: {
    port: toNumber(process.env.PORT, 3000),
    corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:3002',
  },
  auth: {
    jwtSecret: process.env.JWT_SECRET,
    tokenExpiresIn: process.env.JWT_EXPIRES_IN || '12h',
  },
  database: {
    host: process.env.MYSQL_HOST || process.env.DB_HOST,
    port: toNumber(process.env.MYSQL_PORT || process.env.DB_PORT, 3306),
    user: process.env.MYSQL_USER || process.env.DB_USER,
    password: process.env.MYSQL_PASSWORD || process.env.DB_PASSWORD,
    database: process.env.MYSQL_DATABASE || process.env.DB_NAME,
  },
  securityWarnings: security.warnings,
  // 敏感配置缺失项:非空时启动必须拒绝(process.exit) 20260917 凭据收口,
  securityFatal: security.fatal,
};

module.exports = config;