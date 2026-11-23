import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'test-v240-features-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const profile = path.join(root, '.tmp-v240');
fs.rmSync(profile, { recursive: true, force: true });
const checks = {};
const errors = [];

const server = http.createServer((req, res) => {
  if (req.url === '/otp') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><meta charset="utf-8"><title>OTP</title>
      <form><input name="username" autocomplete="username"><input name="password" type="password" autocomplete="current-password">
      <input name="otp" autocomplete="one-time-code" inputmode="numeric"></form>`);
    return;
  }
  res.writeHead(404); res.end('no');
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
const setup = await options.evaluate(async () => {
  await chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' });
  await chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0, theme: 'light', material: 'liquid', privacyShieldOnBlur: false } });
  const entries = [
    { host: 'example.com', username: 'alice', password: 'weakpass', tags: ['work'], totpSecret: 'JBSWY3DPEHPK3PXP' },
    { host: 'example.com', username: 'bob', password: 'bob-pass', tags: ['personal'] },
    { host: 'github.com', username: 'octo', password: 'github-pass', tags: ['work'] },
    { host: '127.0.0.1', username: 'otpuser', password: 'otp-pass', totpSecret: 'JBSWY3DPEHPK3PXP' },
  ];
  for (const entry of entries) await chrome.runtime.sendMessage({ type: 'SV_ADD_ENTRY', entry });
  return true;
});
checks.setup = setup;
await options.reload();
await options.waitForSelector('#gate', { state: 'hidden', timeout: 10000 });
await options.locator('[data-section="vault"]').click();
await options.waitForSelector('.entry-card');
await options.waitForTimeout(500);

checks.insights = {
  score: await options.locator('#healthScore').innerText(),
  hostBars: await options.locator('#hostChart .host-bar').count(),
  hostOptions: await options.locator('#hostFilter option').count(),
  tagOptions: await options.locator('#tagFilter option').count(),
};
await options.selectOption('#hostFilter', 'example.com');
checks.hostFilterRows = await options.locator('.entry-card').count();
await options.selectOption('#tagFilter', 'work');
checks.combinedRows = await options.locator('.entry-card').count();
await options.selectOption('#hostFilter', '');
await options.selectOption('#tagFilter', '');
await options.evaluate(() => { const s = document.querySelector('#privacyShield'); if (s) s.hidden = true; });

options.on('dialog', (d) => d.accept());
const cardBob = options.locator('.entry-card').filter({ hasText: 'bob' }).first();
await await cardBob.locator('.entry-actions button', { hasText: '删除' }).first().click();
await options.waitForSelector('#undoToast:not([hidden])', { timeout: 5000 });
await options.evaluate(() => { const s = document.querySelector('#privacyShield'); if (s) s.hidden = true; });
checks.undoToast = {
  title: await options.locator('#undoToastTitle').innerText(),
  detail: await options.locator('#undoToastDetail').innerText(),
};
await options.locator('#undoToastBtn').click();
await options.locator('#undoToast').waitFor({ state: 'hidden', timeout: 5000 });
checks.undoRestored = await options.locator('.entry-card').filter({ hasText: 'bob' }).count();

const cardOcto = options.locator('.entry-card').filter({ hasText: 'octo' }).first();
await await cardOcto.locator('.entry-actions button', { hasText: '删除' }).first().click();
await options.waitForSelector('#undoToast:not([hidden])');
await options.waitForTimeout(5300);
checks.undoAutoHidden = await options.locator('#undoToast').isHidden();
await options.locator('#openTrashBtn').click();
await options.waitForSelector('#trashDialog[open]', { timeout: 5000 });
checks.trashDialogOpen = await options.locator('#trashDialog').isVisible();
checks.trashRows = await options.locator('.trash-row').count();
await options.locator('.trash-row').first().getByRole('button', { name: '恢复' }).click();
await options.waitForTimeout(500);
checks.trashRestored = await options.locator('.entry-card').filter({ hasText: 'octo' }).count();
await options.locator('#trashClose').click();
await options.locator('#trashDialog').waitFor({ state: 'hidden', timeout: 3000 });

const cardBob2 = options.locator('.entry-card').filter({ hasText: 'bob' }).first();
await await cardBob2.locator('.entry-actions button', { hasText: '删除' }).first().click();
await options.waitForSelector('#undoToast:not([hidden])');
await options.locator('#openTrashBtn').click();
await options.waitForSelector('#trashDialog[open]', { timeout: 5000 });
checks.trashBadge = await options.locator('#trashCount').innerText();
await options.locator('#emptyTrashBtn').click();
await options.waitForTimeout(600);
checks.trashEmpty = await options.locator('#trashEmpty').isVisible();
checks.trashRowsAfterEmpty = await options.locator('.trash-row').count();
await options.locator('#trashClose').click();
await options.locator('#trashDialog').waitFor({ state: 'hidden', timeout: 3000 });

await options.locator('[data-section="security"]').click();
await options.waitForTimeout(300);
await options.locator('#genLengthInput').fill('12');
await options.locator('#genSymbols').uncheck();
await options.locator('#genDigits').uncheck();
await options.locator('#generatorPreviewBtn').click();
const preview = await options.locator('#genPreview').innerText();
checks.generatorPreview = { length: preview.length, hasSymbol: /[^A-Za-z]/.test(preview) };
await options.locator('[data-section="share"]').click();
await options.waitForTimeout(250);
await options.locator('#shareGenerate').click();
const generated = await options.locator('#sharePassword').inputValue();
checks.exportGenerator = { length: generated.length, type: await options.locator('#sharePassword').getAttribute('type') };

const site = await context.newPage();
site.on('console', (m) => console.log('SITE', m.type(), m.text()));
site.on('pageerror', (e) => console.log('SITEERR', e.message));
await site.goto(`http://127.0.0.1:${port}/otp`);
await site.waitForTimeout(2200);
checks.siteOtpAutoShown = await site.locator('[data-subvault-otp]:not([hidden])').count();
await site.locator('input[name="otp"]').click();
await site.waitForSelector('[data-subvault-otp]:not([hidden])', { timeout: 10000 });
checks.siteOtp = {
  code: (await site.locator('.sv-otp-code').innerText()).trim(),
  hasCopy: await site.locator('.sv-otp-copy-btn').isVisible(),
  bar: await site.locator('.sv-otp-bar').getAttribute('style'),
};

const popup = await context.newPage();
await popup.goto(`chrome-extension://${id}/src/popup/popup.html`);
await popup.waitForTimeout(1200);
const q1 = await popup.locator('#quickGenOutput').innerText();
await popup.locator('#quickGenRefresh').click();
await popup.waitForTimeout(150);
const q2 = await popup.locator('#quickGenOutput').innerText();
const quickLength = await popup.locator('#quickGenLength').inputValue();
await popup.locator('#quickGenSymbols').uncheck();
await popup.locator('#quickGenLength').fill('12');
await popup.waitForTimeout(600);
const q3 = await popup.locator('#quickGenOutput').innerText();
checks.popupQuickGen = {
  length: q1.trim().length,
  changed: q1 !== q2,
  iconButtonGone: await popup.locator('.actions-row > .icon-btn').count() === 0,
  optionsVisible: await popup.locator('.quick-gen-options').isVisible(),
  defaultLength: quickLength,
  customLength: q3.trim().length,
  customHasSymbol: /[^A-Za-z0-9]/.test(q3.trim()),
};

checks.errors = errors;
const pass = Object.entries(checks).every(([k, v]) => {
  if (k === 'insights') return v.score && v.hostBars >= 2 && v.hostOptions >= 3 && v.tagOptions >= 3;
  if (k === 'siteOtp') return /^\d{6}$/.test(v.code) && v.hasCopy && /width/.test(v.bar || '');
  if (k === 'popupQuickGen') return v.length >= 8 && v.changed && v.iconButtonGone && v.optionsVisible && v.customLength === 12 && !v.customHasSymbol;
  if (k === 'generatorPreview') return v.length === 12 && !v.hasSymbol;
  if (k === 'exportGenerator') return v.length === 12 && v.type === 'text';
  if (k === 'siteOtpAutoShown') return v === 0;
  if (typeof v === 'number') return v >= 0;
  return Boolean(v);
});
console.log(JSON.stringify({ checks, pass, errors }, null, 2));
await context.close();
server.close();
if (!pass) process.exit(1);
