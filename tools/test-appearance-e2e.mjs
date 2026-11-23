import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(path.resolve(import.meta.dirname, '..'), '.tmp-host', 'test-appearance-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const profile = path.join(root, '.tmp-appearance');
fs.rmSync(profile, { recursive: true, force: true });
const errors = [];
const server = http.createServer((req, res) => {
  if (req.url === '/login') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>Login</title></head><body>
      <form><input id="username" autocomplete="username" placeholder="账号">
      <input id="password" type="password" autocomplete="current-password" placeholder="密码">
      <button type="submit">登录</button></form></body></html>`);
    return;
  }
  res.writeHead(404); res.end('no');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const context = await chromium.launchPersistentContext(profile, {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  viewport: { width: 1280, height: 900 },
});
const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
const extensionId = worker.url().split('/')[2];
const setup = await context.newPage();
setup.on('pageerror', (error) => errors.push(String(error)));
await setup.goto(`chrome-extension://${extensionId}/src/options/options.html`);
await setup.waitForTimeout(500);
const result = await setup.evaluate(async () => {
  const api = (message) => chrome.runtime.sendMessage(message);
  const created = await api({ type: 'SV_SETUP', password: 'SubVault-Test-2026!Qm7#' });
  await api({ type: 'SV_SET_SETTINGS', settings: {
    lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0,
    theme: 'dark', material: 'glass', accentColor: 'ocean', glassStrength: 'ultra', uiRadius: 'round',
  }});
  await api({ type: 'SV_ADD_ENTRY', entry: {
    title: 'Demo', host: '127.0.0.1', username: 'alice', password: 'alice-secret',
  }});
  return created;
});
await setup.reload();
await setup.waitForTimeout(800);
await setup.click('[data-section="general"]');
await setup.waitForTimeout(400);
const appearance = await setup.evaluate(() => {
  const card = document.querySelector('.card');
  const root = document.documentElement;
  return {
    dataset: { ...root.dataset },
    activeAccent: document.querySelector('#accentPicker .accent-swatch.is-active')?.dataset.accentValue,
    cardRadius: getComputedStyle(card).borderRadius,
    cardBackdrop: getComputedStyle(card).backdropFilter || getComputedStyle(card).webkitBackdropFilter,
    glassValue: document.querySelector('#glassStrengthSelect').value,
    radiusValue: document.querySelector('#uiRadiusSelect').value,
  };
});
await setup.evaluate(async () => {
  await chrome.runtime.sendMessage({ type: 'SV_SET_SETTINGS', settings: { glassStrength: 'soft' } });
});
await setup.waitForTimeout(500);
const softBackdrop = await setup.evaluate(() => {
  const card = document.querySelector('.card');
  return getComputedStyle(card).backdropFilter || getComputedStyle(card).webkitBackdropFilter;
});
await setup.screenshot({ path: '.tmp-appearance-options.png', fullPage: false });
await setup.click('[data-accent-value="emerald"]');
await setup.waitForTimeout(350);
const interactiveAccent = await setup.evaluate(() => ({
  accent: document.documentElement.dataset.accent,
  active: document.querySelector('#accentPicker .accent-swatch.is-active')?.dataset.accentValue,
}));
await setup.selectOption('#uiRadiusSelect', 'square');
await setup.waitForTimeout(350);
const interactiveRadius = await setup.evaluate(() => ({
  radius: document.documentElement.dataset.radius,
  cardRadius: getComputedStyle(document.querySelector('.card')).borderRadius,
}));

const popup = await context.newPage();
await popup.setViewportSize({ width: 382, height: 640 });
await popup.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
await popup.bringToFront();
await popup.waitForTimeout(800);
const shield = popup.locator('#privacyShield');
if (await shield.isVisible().catch(() => false)) await shield.click();
const popupAppearance = await popup.evaluate(() => ({ ...document.documentElement.dataset }));
await popup.screenshot({ path: '.tmp-appearance-popup.png' });

const site = await context.newPage();
await site.goto(`http://127.0.0.1:${port}/login`);
await site.waitForTimeout(1200);
await site.locator('#username').click();
await site.waitForTimeout(600);
const contentAppearance = await site.evaluate(() => {
  const host = document.querySelector('#subvault-ui-root');
  const layer = host?.shadowRoot?.querySelector('.sv-layer');
  const trigger = host?.shadowRoot?.querySelector('.sv-trigger');
  return {
    dataset: host ? { ...host.dataset } : null,
    accent: layer ? getComputedStyle(layer).getPropertyValue('--sv-accent').trim() : '',
    triggerVisible: trigger ? !trigger.hidden : false,
    triggerBackground: trigger ? getComputedStyle(trigger).backgroundImage : '',
  };
});
await site.screenshot({ path: '.tmp-appearance-content.png' });
const checks = {
  setup: Boolean(result?.ok),
  dataset: appearance.dataset.accent === 'ocean' && appearance.dataset.glass === 'ultra' && appearance.dataset.radius === 'round' && appearance.dataset.theme === 'dark' && appearance.dataset.material === 'glass',
  controls: appearance.activeAccent === 'ocean' && appearance.glassValue === 'ultra' && appearance.radiusValue === 'round',
  radius: appearance.cardRadius === '22px',
  strongGlass: appearance.cardBackdrop.includes('52px'),
  softGlass: softBackdrop.includes('18px'),
  popup: popupAppearance.accent === 'emerald' && popupAppearance.glass === 'soft' && popupAppearance.radius === 'square',
  content: contentAppearance.dataset?.accent === 'emerald' && contentAppearance.dataset?.glass === 'soft' && contentAppearance.dataset?.radius === 'square',
  contentTrigger: contentAppearance.triggerVisible && (/color\(srgb|56, 189, 248|2, 132, 199/.test(contentAppearance.triggerBackground)),
};
result.checks = checks;
result.appearance = appearance;
result.interactiveAccent = interactiveAccent;
result.interactiveRadius = interactiveRadius;
result.softBackdrop = softBackdrop;
result.popupAppearance = popupAppearance;
result.contentAppearance = contentAppearance;
result.errors = errors;
result.pass = Object.values(checks).every(Boolean) && errors.length === 0;
console.log(JSON.stringify(result, null, 2));
await context.close();
server.close();
if (!result.pass) process.exit(1);
