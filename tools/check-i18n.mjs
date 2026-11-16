import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const failures = [];

function read(relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function normalize(text) {
  return text.replace(/\s+/g, ' ').trim();
}

/** Parse the plain object literal exported by src/lib/i18n-en.js. */
function loadDictionary() {
  const source = read('src/lib/i18n-en.js');
  const match = source.match(/export const EN = (\{[\s\S]*?\n\});/);
  if (!match) throw new Error('src/lib/i18n-en.js: cannot locate "export const EN = {...};"');
  const dict = new Function(`return (${match[1]});`)();
  const brandNames = new Set(['SubVault', 'WebDAV', 'KDBX', 'TOTP', 'KeePass', 'Chrome', 'Edge', 'Firefox', 'Bitwarden', 'LastPass', '1Password', 'PSL', 'PIN', 'English']);
  for (const [key, value] of Object.entries(dict)) {
    if (!key.trim()) failures.push('i18n-en.js: empty key');
    if (typeof value !== 'string' || !value.trim()) {
      failures.push(`i18n-en.js: empty translation for ${JSON.stringify(key)}`);
    }
    if (key === value && !brandNames.has(key)) {
      failures.push(`i18n-en.js: untranslated value for ${JSON.stringify(key)}`);
    }
  }
  return dict;
}

/** Collect Chinese UI strings from an HTML page (text nodes and common attributes). */
function collectHtmlStrings(relative, dict) {
  let html = read(relative);
  html = html.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ');
  const attrPattern = /\b(placeholder|title|aria-label|alt)="([^"]*[\u4e00-\u9fff][^"]*)"/g;
  for (const match of html.matchAll(attrPattern)) {
    const text = normalize(match[2]);
    if (text && !dict[text]) failures.push(`${relative}: missing attribute translation ${JSON.stringify(text)}`);
  }
  const text = html.replace(/<[^>]+>/g, '\n');
  for (const line of text.split('\n')) {
    const value = normalize(line);
    if (!value || !/[\u4e00-\u9fff]/.test(value)) continue;
    if (dict[value]) continue;
    // Long prose paragraphs are documentation, not UI strings; still report
    // them so the dictionary stays reviewable.
    failures.push(`${relative}: missing text translation ${JSON.stringify(value.slice(0, 120))}`);
  }
}

/** Extract the content-script UI_EN map and compare it with the shared dictionary. */
function checkContentDictionary(dict) {
  const source = read('src/content/content.js');
  const start = source.indexOf('const UI_EN = {');
  if (start < 0) {
    failures.push('src/content/content.js: UI_EN map not found');
    return;
  }
  const end = source.indexOf('\n  };', start);
  if (end < 0) {
    failures.push('src/content/content.js: UI_EN map end not found');
    return;
  }
  const literal = source.slice(source.indexOf('{', start), end + 4);
  let map;
  try {
    map = new Function(`return (${literal});`)();
  } catch (error) {
    failures.push(`src/content/content.js: UI_EN parse failed: ${error.message}`);
    return;
  }
  for (const [key, value] of Object.entries(map)) {
    if (!value || !String(value).trim()) {
      failures.push(`content UI_EN: empty translation for ${JSON.stringify(key)}`);
    }
    if (dict[key] && dict[key] !== value) {
      failures.push(`content UI_EN: differs from shared dictionary for ${JSON.stringify(key)}`);
    }
  }
}

function checkLocales() {
  for (const locale of ['zh_CN', 'en']) {
    const file = `_locales/${locale}/messages.json`;
    const messages = JSON.parse(read(file));
    for (const key of ['extName', 'extDesc']) {
      const message = messages[key]?.message;
      if (!message || !String(message).trim()) failures.push(`${file}: missing ${key}`);
    }
  }
}

const dict = loadDictionary();
collectHtmlStrings('src/popup/popup.html', dict);
collectHtmlStrings('src/options/options.html', dict);
checkContentDictionary(dict);
checkLocales();

if (failures.length) {
  console.error(`i18n check failed: ${failures.length} issue(s)`);
  for (const failure of failures.slice(0, 200)) console.error(`- ${failure}`);
  process.exit(1);
}
console.log(`i18n check passed: ${Object.keys(dict).length} translations`);
