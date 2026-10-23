// SQL 与模块口径的静态体检(审查修复 20261021 P2):这类问题运行时不报错,只能靠源码扫描兜住,
// 1) 含口令列的表(account/operator)绝不允许被 select * 带进响应体;
// 2) public.js 已拆成 lib/*.js + 再导出门面,任何调用点写成门面里没有的名字时,
//    取到的是 undefined 而不是加载期错误,故必须有一条“调用点 ⊆ 门面导出”的断言,
// 3) 租户库名闸门与拼串型语句构造器的自守调用必须存在(20261021 审查修复二轮 P0-1),
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

// “先读后写”的两个辅助函数必须拿到事务连接,否则语句排进事务、读却跑在池上,
// 并发提交同一墓位时双方都读不到对方未提交的行(重复插联系人/一穴两条预定),
// 20261021 审查修复二轮 P0-2,
test('sqlHygiene: 读后生成语句的辅助函数必须传事务连接', () => {
  const helpers = ['buildContactsSyncStatements', 'buildReserveUpsertStatements'];
  const offenders = [];

  collectSourceFiles(ROOT, [], ['tests', 'lib']).forEach((file) => {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    helpers.forEach((name) => {
      let index = text.indexOf(name + '(');
      while (index !== -1) {
        const tail = text.slice(index + name.length, index + name.length + 400);
        if (!/,\s*conn\s*[),]/.test(tail)) {
          offenders.push(`${path.relative(ROOT, file)}: ${name} 未传事务连接`);
        }
        index = text.indexOf(name + '(', index + name.length + 1);
      }
    });
  });

  assert.deepStrictEqual(offenders, [], `以下调用点仍在事务外读数据:\n- ${offenders.join('\n- ')}`);
});

// 改密/改账户这类会顺带作废登录态的写入口,撤销动作必须排在 commit 之后,
// 静态近似口径:每个 deleteActiveLogin  occurrence 的近前必须能看到 onCommitted 或 await withTransaction,
test('sqlHygiene: 会话撤销不得排在写事务提交之前', () => {
  ['operator/save.js', 'account/save.js'].forEach((relative) => {
    const text = stripComments(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
    let index = text.indexOf('deleteActiveLogin');
    assert.ok(index !== -1, `${relative} 应保留会话撤销逻辑(不应静默删掉)`);
    while (index !== -1) {
      const before = text.slice(Math.max(0, index - 700), index);
      assert.ok(
        /onCommitted|await pool\.withTransaction/.test(before),
        `${relative}: 第 ${index} 字处撤销会话尚未排在提交之后,事务回滚时会误下线`,
      );
      index = text.indexOf('deleteActiveLogin', index + 1);
    }
  });
});

// 预定关联只能走对本页行的相关子查询,不得回到“先全表聚合 reserve 再 JOIN”的派生表写法
// (这类语句语法不报错、功能也对,只是存量越大越慢,靠人眼盯容易回退),
// 20261021 审查修复二轮 P1-8,
test('sqlHygiene: 墓位列表不得再带 reserve 全表聚合派生表', () => {
  const offenders = [];
  ['room/query.js', 'gravePlotBusiness/query.js'].forEach((relative) => {
    const text = stripComments(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
    [...text.matchAll(/FROM\s+\$\{[^}]*\}\.reserve[^;]*?GROUP\s+BY\s+idRoom/gi)].forEach(([fragment]) => {
      offenders.push(`${relative}: ${fragment.slice(0, 80)}`);
    });
  });

  assert.deepStrictEqual(offenders, [], `存在对 reserve 的全表 GROUP BY 派生表:\n- ${offenders.join('\n- ')}`);
});

// 库名拼串的全站唯一入口就是“验签后 + 签票前”两个切面,谁把闸门删了语法与用例都不会报错,
// 因此在这里用源码断言把它钉住(新增第三处签票入口时需同步参加本断言),
test('sqlHygiene: 租户库名闸门必须挂在验签与签票两个入口', () => {
  const gates = [
    ['index.js', /tenant\.isAllowed\(req\.data\.dataBase\)/],
    ['login.js', /tenant\.isAllowed\(dataBaseName\)/],
    ['index.js', /tenant\.ensureLoaded\(\)/],
    ['index.js', /tenant\.startAutoRefresh\(\)/],
    // 传输层与日志两个入口(审查修复 20261021 二轮 P2-16 / P2-23):两者实现都在 httpDefaults.js,
    // 但 index.js 不调用就等于没生效,而语法与用例都不会报错,因此同样需要源码级钉住,
    ['index.js', /httpDefaults\.attachRequestId/],
    ['index.js', /httpDefaults\.applyServerTimeouts\(server\)/],
  ];
  gates.forEach(([file, pattern]) => {
    const text = stripComments(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    assert.ok(pattern.test(text), `${file} 缺少 ${pattern.source} 调用,租户库名校验已被绕过`);
  });
});

// lib/roomSync.js 的语句模板把 idRoom/idReserve 直接拼进文本(28 个调用点各自靠 parseNumericParam 纪律),
// 因此要求每个导出模板首行就 assertScope(库名标识符 + 数值 ID),不依赖调用方,
test('sqlHygiene: 墓位同步语句模板必须自带库名/ID 断言', () => {
  const text = stripComments(fs.readFileSync(path.join(ROOT, 'lib', 'roomSync.js'), 'utf8'));
  const exported = [...text.matchAll(/exports\.(getRoom\w+Sync\w*|build\w+Statements)\s*=\s*(?:async\s+)?function\s*\(([^)]*)\)/g)];
  assert.ok(exported.length >= 5, `墓位同步模板导出数不应少于 5 个,实际 ${exported.length}`);
  const missing = exported
    .filter(([, name, args]) => {
      const body = text.slice(text.indexOf(`exports.${name}`));
      const head = body.slice(0, 400);
      // 只校带库名/ID 入参的模板,参数名包含 dataBase 或 idRoom/idReserve,
      return /dataBase/.test(args) && !/assertScope\(/.test(head);
    })
    .map(([name]) => name);
  assert.deepStrictEqual(missing, [], `以下语句模板未做库名/ID 断言: ${missing.join(', ')}`);
});

// 响应信封棘轮(审查修复 20261021 二轮 P2-12):全站响应应统一走 lib/respond.js 的 { code, message, ... } 信封,
// 但仓库里仍有大量 `res.status(4xx).json({ error: ... })` 手写体在靠 public.normalizeEnvelope 运行时补齐 code——
// 能兼容但口径不统一(前端按 code 判分支时这类响应全靠运行时补齐,静态阅读时容易被当成另一个体系),
// 一次性改写风险远大于收益(每处都要核对状态码与文案),因此先钉住现状不允许增长:只减不增,
// 基线由 115 降到 100 是三轮下线销售/下葬/联系人登记页(6 个模块)自然带走的 15 处,并非手工改写,
// 20261023 权限模板入库改造复测存量降至 98,随基线同步下调(仍只减不增);
// 20261023 下线预定登记页(删除 reserve/save.js、reserve/delete.js)再自然带走 3 处,基线同步降至 95,
// 存量清零后把下面的断言改为 strictEqual(0) 即可升级为硬约束, 20261021 新增,
const ENVELOPE_BASELINE = 95;

test('sqlHygiene: 手写 { error } 响应体不得多于信封基线(lib/ 必须为零)', () => {
  const hits = [];
  collectSourceFiles(ROOT, [], ['tests', 'scripts']).forEach((file) => {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    [...text.matchAll(/\.json\(\s*\{\s*error\b/g)].forEach(() => {
      hits.push(path.relative(ROOT, file));
    });
  });

  assert.ok(
    hits.length <= ENVELOPE_BASELINE,
    `手写 { error } 响应体已从基线 ${ENVELOPE_BASELINE} 增长到 ${hits.length} 处,新增响应请走 public.respondError/buildSuccessBody`,
  );
  if (hits.length < ENVELOPE_BASELINE) {
    // 存量下降时给下一个改动者一个明确动作(而不是让人猜基线是不是还能再降),
    console.log(`[sqlHygiene] 手写 { error } 已降至 ${hits.length} 处,请把 ENVELOPE_BASELINE 下调到 ${hits.length}`);
  }

  // lib/ 是本轮拆出来的公共层,不允许再带历史手写写法:此处必须为 0,
  const libHits = collectSourceFiles(path.join(ROOT, 'lib')).filter((file) =>
    /\.json\(\s*\{\s*error\b/.test(stripComments(fs.readFileSync(file, 'utf8'))),
  );
  assert.deepStrictEqual(libHits, [], `lib/ 不应出现手写 { error } 响应:\n- ${libHits.map((file) => path.relative(ROOT, file)).join('\n- ')}`);
});

// 拼串型 SQL 里多打一个运算符不会被语法检查发现:'...' + + '...' 被解析成“字符串 + 一元正号(字符串)”，
// 结果是一个 NaN 直接拼进语句,运行时只报 SQL 语法错而定位成本极高(20261021 二轮 P2-14 改造时真实踩到),
// 现用静态扫描把“引号后连写两个加号”钉住, 20261021 新增,
test('sqlHygiene: 拼串语句不得出现连写的两个加号', () => {
  const offenders = [];
  collectSourceFiles(ROOT, [], ['scripts', 'tests']).forEach((file) => {
    const text = stripComments(fs.readFileSync(file, 'utf8'));
    [...text.matchAll(/'[^'\n]*'\s*\+\s*\+/g)].forEach(([fragment]) => {
      offenders.push(`${path.relative(ROOT, file)}: ${fragment.slice(-40)}`);
    });
  });

  assert.deepStrictEqual(offenders, [], `存在拼串断链(连写两个加号)的语句:\n- ${offenders.join('\n- ')}`);
});
