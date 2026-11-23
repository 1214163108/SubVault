import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'test-otp-detect-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const profile = path.join(root, '.tmp-otpdetect');
fs.rmSync(profile, { recursive: true, force: true });
const checks = {};

// 1:1 copy of Gitee's 2FA widget (vue-otp-input): six visual boxes plus one
// transparent <input class="vi" aria-label="verification input"> with no
// name / id / placeholder / autocomplete.
const GITEE = `<!doctype html><meta charset="utf-8"><title>双因素认证</title>
<style>
  body{font-family:system-ui;padding:40px}
  .vi__container{position:relative;display:flex;gap:8px;width:312px}
  .vi__character{width:44px;height:52px;border:1px solid #ccc;border-radius:6px;
    display:flex;align-items:center;justify-content:center;font-size:22px}
  .vi{position:absolute;inset:0;width:100%;opacity:0;caret-color:transparent}
</style>
<h1>双因素认证</h1>
<div data-testid="container" class="vi__container">
  <div class="vi__character"></div><div class="vi__character"></div><div class="vi__character"></div>
  <div class="vi__character"></div><div class="vi__character"></div><div class="vi__character"></div>
  <input aria-label="verification input" spellcheck="false" class="vi" inputmode="numeric" value="">
</div>
<a href="#">使用恢复代码进行验证</a>`;

// Segmented widget with no usable attributes at all.
const SEGMENTED = `<!doctype html><meta charset="utf-8"><title>code</title>
<div class="code-box"><input maxlength="1"><input maxlength="1"><input maxlength="1">
<input maxlength="1"><input maxlength="1"><input maxlength="1"></div>`;

// Ordinary inputs that must never be mistaken for OTP fields.
const PLAIN = `<!doctype html><meta charset="utf-8"><title>controls</title>
<input id="search" placeholder="搜开源" autocomplete="off">
<input id="user" placeholder="请输入用户名">
<input id="phone" placeholder="请输入你的手机号码">
<input id="qty" type="number" placeholder="数量">
<input id="zip" placeholder="邮编">
<textarea id="note" placeholder="备注"></textarea>`;

const server = http.createServer((req, res) => {
  const page = { '/gitee': GITEE, '/segmented': SEGMENTED, '/plain': PLAIN }[req.url];
  if (page) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page);
    return;
  }
  res.writeHead(404);
  res.end('no');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
});
const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
const id = worker.url().split('/')[2];
const options = await context.newPage();
await options.goto(`chrome-extension://${id}/src/options/options.html`);
await options.waitForTimeout(400);
await options.evaluate(async () => {
  await chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' });
  await chrome.runtime.sendMessage({
    type: 'SV_SET_SETTINGS',
    settings: {
      lockOnSystemLock: false,
      lockOnSystemIdle: false,
      autoLockMinutes: 0,
      privacyShieldOnBlur: false,
      otpToastSeconds: 30,
    },
  });
  await chrome.runtime.sendMessage({
    type: 'SV_ADD_ENTRY',
    entry: {
      host: '127.0.0.1',
      username: 'gitee-user',
      password: 'gitee-pass',
      totpSecret: 'JBSWY3DPEHPK3PXP',
    },
  });
});
await options.reload();
await options.waitForTimeout(300);

const cardState = (page) =>
  page.evaluate(() => {
    const host = document.querySelector('#subvault-ui-root');
    const card = host?.shadowRoot?.querySelector('[data-subvault-otp]');
    if (!card) return { found: false, visible: false, code: '' };
    return {
      found: true,
      visible: !card.hidden,
      code: (card.querySelector('[data-subvault-otp-code]')?.textContent || '').trim(),
      text: card.textContent.replace(/\s+/g, ' ').trim().slice(0, 70),
    };
  });

// Gitee: clicking a visual box focuses the transparent input.
const gitee = await context.newPage();
await gitee.goto(`http://127.0.0.1:${port}/gitee`);
await gitee.waitForTimeout(700);
checks.giteeBeforeFocus = (await cardState(gitee)).visible;
await gitee.locator('input.vi').click({ force: true });
await gitee.waitForTimeout(900);
const giteeCard = await cardState(gitee);
checks.giteeVisible = giteeCard.visible;
checks.giteeCode = /^\d{6}$/.test(giteeCard.code);
checks.giteeHasUsername = giteeCard.text.includes('gitee-user');

// Fill action writes the code into the transparent input.
await gitee.locator('#subvault-ui-root').evaluate((host) => {
  host.shadowRoot.querySelector('.sv-otp-fill')?.click();
});
await gitee.waitForTimeout(400);
checks.giteeFill = await gitee.evaluate(() => document.querySelector('input.vi').value);

// Segmented widget with no attributes at all.
const seg = await context.newPage();
await seg.goto(`http://127.0.0.1:${port}/segmented`);
await seg.waitForTimeout(700);
await seg.locator('input').first().click();
await seg.waitForTimeout(900);
checks.segmentedVisible = (await cardState(seg)).visible;

// Ordinary fields must not raise the card.
const plain = await context.newPage();
await plain.goto(`http://127.0.0.1:${port}/plain`);
await plain.waitForTimeout(700);
const falsePositives = {};
for (const selector of ['#search', '#user', '#phone', '#qty', '#zip', '#note']) {
  await plain.evaluate(() => {
    const host = document.querySelector('#subvault-ui-root');
    host?.shadowRoot?.querySelector('[data-subvault-otp]')?.setAttribute('hidden', '');
  });
  await plain.locator(selector).click();
  await plain.waitForTimeout(650);
  falsePositives[selector] = (await cardState(plain)).visible;
  await plain.evaluate(() => document.activeElement?.blur());
  await plain.waitForTimeout(150);
}
checks.falsePositives = falsePositives;
checks.noFalsePositive = Object.values(falsePositives).every((v) => v === false);

const pass =
  checks.giteeBeforeFocus === false &&
  checks.giteeVisible === true &&
  checks.giteeCode === true &&
  checks.giteeHasUsername === true &&
  /^\d{6}$/.test(checks.giteeFill) &&
  checks.segmentedVisible === true &&
  checks.noFalsePositive === true;

console.log(JSON.stringify({ pass, checks }, null, 2));
await context.close();
server.close();
process.exit(pass ? 0 : 1);
