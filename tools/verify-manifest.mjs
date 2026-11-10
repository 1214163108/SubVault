import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const warnings = [];

function readJson(relative) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, relative), 'utf8'));
  } catch (error) {
    errors.push(`${relative}: ${error.message}`);
    return null;
  }
}

function exists(relative) {
  if (!fs.existsSync(path.join(root, relative))) {
    errors.push(`缺少文件：${relative}`);
    return false;
  }
  return true;
}

const manifest = readJson('manifest.json');
if (!manifest) process.exit(1);

if (manifest.manifest_version !== 3) errors.push('manifest_version 必须是 3');
if (!manifest.background?.service_worker) errors.push('缺少 background.service_worker');
if (manifest.background?.type !== 'module') errors.push('service worker 必须以 module 运行');
if (!manifest.content_scripts?.length) errors.push('缺少 content_scripts');

const required = [
  manifest.background?.service_worker,
  manifest.action?.default_popup,
  manifest.options_ui?.page,
  ...Object.values(manifest.icons || {}),
  ...Object.values(manifest.action?.default_icon || {}),
  ...(manifest.content_scripts || []).flatMap((script) => [...(script.js || []), ...(script.css || [])]),
].filter(Boolean);

for (const file of new Set(required)) exists(file);

for (const permission of ['storage', 'alarms', 'activeTab', 'privacy', 'idle']) {
  if (!manifest.permissions?.includes(permission)) errors.push(`缺少权限：${permission}`);
}

if (manifest.content_scripts?.some((script) => script.run_at !== 'document_start')) {
  warnings.push('content script 未在 document_start 运行，接管原生自动填充可能滞后');
}

const htmlFiles = ['src/popup/popup.html', 'src/options/options.html'];
for (const htmlFile of htmlFiles) {
  const file = path.join(root, htmlFile);
  if (!fs.existsSync(file)) continue;
  const html = fs.readFileSync(file, 'utf8');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^(https?:|data:|#)/.test(ref)) continue;
    const target = path.resolve(path.dirname(file), ref.split('?')[0]);
    if (!fs.existsSync(target)) errors.push(`${htmlFile} 引用不存在的文件：${ref}`);
  }
}

const jsRoot = path.join(root, 'src');
const seen = new Set();
function scanImports(file) {
  if (seen.has(file) || !fs.existsSync(file)) return;
  seen.add(file);
  const source = fs.readFileSync(file, 'utf8');
  for (const match of source.matchAll(/from\s+['"](\.{1,2}\/[^'"]+)['"]/g)) {
    const target = path.resolve(path.dirname(file), match[1]);
    if (!fs.existsSync(target)) errors.push(`${path.relative(root, file)} 引用不存在：${match[1]}`);
    else scanImports(target);
  }
}
for (const entry of ['src/background/service-worker.js', 'src/popup/popup.js', 'src/options/options.js']) {
  scanImports(path.join(root, entry));
}

if (!manifest.host_permissions?.includes('http://*/*') || !manifest.host_permissions?.includes('https://*/*')) {
  warnings.push('host_permissions 未覆盖全部 http/https 页面');
}

console.log(`Manifest: ${manifest.name} v${manifest.version}`);
console.log(`权限: ${(manifest.permissions || []).join(', ')}`);
console.log(`检查文件: ${seen.size} 个 JS 模块, ${required.length} 个清单文件`);
for (const warning of warnings) console.log(`警告: ${warning}`);
if (errors.length > 0) {
  for (const error of errors) console.error(`错误: ${error}`);
  process.exit(1);
}
console.log('清单与资源引用检查通过。');
