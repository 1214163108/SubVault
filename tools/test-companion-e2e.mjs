import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { createSharePackage } from '../src/lib/share.js';

const ROOT = path.resolve('.');
const dir = path.join(ROOT, '.tmp-companion', String(Date.now()));
fs.mkdirSync(dir, { recursive: true });
const good = path.join(dir, 'good.svshare');
const expired = path.join(dir, 'expired.svshare');
const pkg = await createSharePackage(
  [{ host: 'example.com', url: 'https://example.com', username: 'alice', password: 'alice-secret', notes: 'companion note' }],
  { password: 'share-pass-123', expiresAt: Date.now() + 3600_000 },
);
fs.writeFileSync(good, JSON.stringify(pkg));
fs.writeFileSync(expired, JSON.stringify({ ...pkg, expiresAt: Date.now() - 1000 }));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto('file://' + path.join(ROOT, 'companion', 'index.html'));

const out = {};
await page.setInputFiles('#file', expired);
await page.fill('#password', 'share-pass-123');
await page.click('#open');
out.expiredError = await page.locator('#error').innerText();

await page.setInputFiles('#file', good);
await page.fill('#password', 'wrong-pass');
await page.click('#open');
await page.waitForFunction(() => document.getElementById('error').textContent.includes('密码错误'));
out.wrongError = await page.locator('#error').innerText();

await page.fill('#password', 'share-pass-123');
await page.click('#open');
await page.waitForSelector('#entries .entry');
out.title = await page.locator('#entries h3').innerText();
out.username = await page.locator('.kv .mono').nth(0).innerText();
out.summary = await page.locator('#summary').innerText();
out.note = await page.locator('#entries .entry').innerText();
out.errors = errors;
out.pass =
  out.expiredError.includes('分享文件已过期') &&
  out.wrongError.includes('密码错误') &&
  out.title === 'example.com' &&
  out.username === 'alice' &&
  out.summary === '1 个账号' &&
  out.note.includes('companion note') &&
  out.errors.length === 0;
console.log(JSON.stringify(out, null, 2));
await browser.close();
fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
if (!out.pass) process.exit(1);
