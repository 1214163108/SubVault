import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;

for (const [htmlFile, jsFile] of [
  ['src/popup/popup.html', 'src/popup/popup.js'],
  ['src/options/options.html', 'src/options/options.js'],
]) {
  const html = fs.readFileSync(path.join(root, htmlFile), 'utf8');
  const js = fs.readFileSync(path.join(root, jsFile), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  const referenced = new Set();
  for (const match of js.matchAll(/\$\('([^']+)'\)/g)) referenced.add(match[1]);
  for (const match of js.matchAll(/getElementById\('([^']+)'\)/g)) referenced.add(match[1]);

  const duplicateIds = [...html.matchAll(/\bid="([^"]+)"/g)]
    .map((match) => match[1])
    .filter((id, index, list) => list.indexOf(id) !== index);

  const missing = [...referenced].filter((id) => !ids.has(id));
  const unused = [...ids].filter((id) => !referenced.has(id));
  console.log(`${htmlFile}: ${ids.size} ids, ${referenced.size} referenced`);
  if (duplicateIds.length) {
    failed = true;
    console.log(`  重复 id: ${[...new Set(duplicateIds)].join(', ')}`);
  }
  if (missing.length) {
    failed = true;
    console.log(`  JS 引用但 HTML 不存在: ${missing.join(', ')}`);
  }
  if (unused.length) {
    console.log(`  HTML 中未被 JS 直接引用（正常）: ${unused.slice(0, 20).join(', ')}${unused.length > 20 ? '…' : ''}`);
  }
}

if (failed) process.exit(1);
console.log('DOM id 检查通过。');
