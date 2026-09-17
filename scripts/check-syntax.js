// 全量 JS 语法检查:CI 与本地校验共用,失败以非零码退出 20260917 新增,
const fs = require('fs');
const path = require('path');

const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir)) {
    const full = path.join(dir, entry);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      if (entry !== 'node_modules') {
        walk(full);
      }
    } else if (entry.endsWith('.js')) {
      files.push(full);
    }
  }
}
walk(path.join(__dirname, '..'));

let failed = 0;
for (const file of files) {
  try {
    new Function(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    failed++;
    console.error(`Syntax error in ${file}: ${error.message}`);
  }
}

if (failed > 0) {
  console.error(`Failed: ${failed}/${files.length} files`);
  process.exit(1);
}
console.log(`OK: ${files.length} files syntax valid`);
