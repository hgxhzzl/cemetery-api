// SQL 与模块口径的静态体检(审查修复 20261021 P2):这类问题运行时不报错,只能靠源码扫描兜住,
// 1) 含口令列的表(account/operator)绝不允许被 select * 带进响应体;
// 2) public.js 已拆成 lib/*.js + 再导出门面,任何调用点写成门面里没有的名字时,
//    取到的是 undefined 而不是加载期错误,故必须有一条“调用点 ⊆ 门面导出”的断言,
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'lib']);

function collectSourceFiles(dir, list = [], extraSkipDirs = []) {
  const skip = new Set([...SKIP_DIRS, ...extraSkipDirs]);
  fs.readdirSync(dir, { withFileTypes: true }).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skip.has(entry.name)) {
        collectSourceFiles(full, list, extraSkipDirs);
      }
      return;
    }
    if (entry.name.endsWith('.js')) {
      list.push(full);
    }
  });
  return list;
}

function stripComments(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

// 凭据表清单:仅这两张表带 password 列(见 gm_data_000.sql),其余业务表整行返回是前端实际需要,
const CREDENTIAL_TABLES = ['account', 'operator'];

test('sqlHygiene: 含口令列的表不得被 select * 查询', () => {
  const offenders = [];
  const unresolved = [];

  collectSourceFiles(ROOT, [], ['tests']).forEach((file) => {
    if (file.includes(`${path.sep}scripts${path.sep}`)) {
      // scripts/ 下是运维导出工具,按库整体导数据本就需要同库全表全列,不在本断言约束范围内,
      return;
    }
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    const relative = path.relative(ROOT, file);

    [...text.matchAll(/select\s+(?:\*|[\w`]+\.\*)\s+from\s+([^\s,;)]+)/gi)].forEach(([, rawTable]) => {
      const token = rawTable.replace(/[`'"\]]/g, '');
      const variable = /^\$\{(\w+\.)?([A-Za-z0-9_]+)\}$/.exec(token);
      if (variable) {
        // 表名走变量时无法静态确定,退而求其二:在本文件里找该变量的赋值语句,看是否指向凭据表,
        const hitAssignment = [...text.matchAll(new RegExp(`\\b${variable[2]}\\s*=\\s*[^;\\n]*`, 'g'))].some(([, line]) =>
          CREDENTIAL_TABLES.some((table) => new RegExp(`\\b${table}\\b`, 'i').test(line)),
        );
        if (hitAssignment) {
          offenders.push(`${relative}: select * from ${token}(变量指向凭据表)`);
          return;
        }
        unresolved.push(`${relative}: select * from ${token}`);
        return;
      }

      const identifier = token.split('.').pop();
      if (CREDENTIAL_TABLES.includes(identifier)) {
        offenders.push(`${relative}: select * from ${token}`);
      }
    });
  });

  assert.deepStrictEqual(offenders, [], `存在 select * 命中凭据表:\n- ${offenders.join('\n- ')}`);
  // 无法静态定性的变量形式单独列出作为待查项(不直接判失败,但新增必须可见),
  if (unresolved.length > 0) {
    console.log('[sqlHygiene] 待人工确认的变量表名:\n- ' + unresolved.join('\n- '));
  }
});

test('sqlHygiene: 全仓 public.* 调用点必须能在门面导出中解析到', () => {
  const facade = require('../public');
  const localNames = new Set(['public', 'publicFun', 'bublicfun', 'pub']);
  const unresolved = [];

  collectSourceFiles(ROOT).forEach((file) => {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    if (!/require\([^)]*public/.test(text)) {
      return;
    }
    [...text.matchAll(/(?:^|[^\w$.])([A-Za-z0-9_$]+)\.([A-Za-z0-9_$]+)\b/g)].forEach(([, obj, name]) => {
      if (localNames.has(obj) && name !== 'js' && !(name in facade)) {
        unresolved.push(`${path.relative(ROOT, file)}: ${obj}.${name}`);
      }
    });
    // 解构导入(public.js 拆 lib 后新增的写法)同样必须在门面里存在,
    [...text.matchAll(/const\s*\{([^}]*)\}\s*=\s*require\((['"])[^'"]*public[^'"]*\2\)/g)].forEach(([, list]) => {
      list
        .split(',')
        .map((item) => item.split(':')[0].trim())
        .filter(Boolean)
        .forEach((name) => {
          if (!(name in facade)) {
            unresolved.push(`${path.relative(ROOT, file)}: { ${name} }`);
          }
        });
    });
  });

  assert.deepStrictEqual(unresolved, [], `调用点引用了门面不存在的成员:\n- ${[...new Set(unresolved)].join('\n- ')}`);
});
