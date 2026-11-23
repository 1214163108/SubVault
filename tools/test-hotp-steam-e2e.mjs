/**
 * HOTP / Steam Guard coverage.
 *
 * Verifies that:
 *  - an otpauth://hotp URI stores type/counter and renders RFC 4226 codes,
 *  - "生成下一个（计数器 +1）" advances the stored counter exactly once,
 *  - a steam:// secret yields a 5 character Steam code and its own dialog title,
 *  - the popup shows HOTP codes with a counter badge and never auto-consumes one.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { chromium } from 'playwright';

const ROOT = path.resolve('.');
const BASE = path.join(ROOT, '.tmp-hotp-steam', String(Date.now()));
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(ROOT, '.tmp-host', 'test-hotp-steam-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const MASTER = 'SubVault-Test-2026!Qm7#';
// RFC 4226 test secret ("12345678901234567890" in Base32).
const SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const RFC_CODES = ['755224', '287082', '359152', '969429', '338314'];
const STEAM_ALPHABET = /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/;

try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* ignore */ }
fs.mkdirSync(BASE, { recursive: true });

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<html><body><input id="username" autocomplete="username"><input id="password" type="password"></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const errors = [];
const checks = {};
let context = null;

try {
  context = await chromium.launchPersistentContext(path.join(BASE, 'profile'), {
    headless: false,
    env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
    args: [
      `--disable-extensions-except=${ROOT}`,
      `--load-extension=${ROOT}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-position=-32000,-32000',
      '--window-size=980,900',
    ],
    locale: 'zh-CN',
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];

  const options = await context.newPage();
  options.on('pageerror', (error) => errors.push(String(error)));
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForSelector('#gate');
  const send = (message) => options.evaluate((payload) => chrome.runtime.sendMessage(payload), message);

  const setup = await send({ type: 'SV_SETUP', password: MASTER });
  if (!setup?.ok) throw new Error(`setup failed: ${setup?.error}`);
  await send({
    type: 'SV_SET_SETTINGS',
    settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0, privacyShieldOnBlur: false },
  });

  // ---- HOTP entry via otpauth URI -------------------------------------
  const hotpAdd = await send({
    type: 'SV_ADD_ENTRY',
    entry: {
      host: 'hotp.example.com',
      username: 'hotp-user',
      password: 'hotp-pass-1',
      totpSecret: `otpauth://hotp/HOTP:hotp-user?secret=${SECRET}&issuer=HOTP&counter=0`,
    },
  });
  checks.hotpAdd = Boolean(hotpAdd?.ok);
  const hotpList = await send({ type: 'SV_LIST_ENTRIES' });
  const hotpEntry = (hotpList.entries || []).find((entry) => entry.host === 'hotp.example.com');
  checks.hotpEntry = {
    hasTotp: Boolean(hotpEntry?.hasTotp),
    id: Boolean(hotpEntry?.id),
  };

  // ---- Steam entry via steam:// ---------------------------------------
  const steamAdd = await send({
    type: 'SV_ADD_ENTRY',
    entry: {
      host: 'steam.example.com',
      username: 'steam-user',
      password: 'steam-pass-1',
      totpSecret: `steam://${SECRET}`,
    },
  });
  checks.steamAdd = Boolean(steamAdd?.ok);

  // ---- direct message level checks ------------------------------------
  const hotp0 = await send({ type: 'SV_GET_TOTP_CODE', id: hotpEntry.id });
  checks.hotpCounter0 = { code: hotp0?.code, type: hotp0?.type, counter: hotp0?.counter };
  const hotpAdvanced = await send({ type: 'SV_GET_TOTP_CODE', id: hotpEntry.id, advance: true, counter: 1 });
  checks.hotpCounter1 = { code: hotpAdvanced?.code, type: hotpAdvanced?.type };
  const afterAdvance = await send({ type: 'SV_GET_TOTP_CODE', id: hotpEntry.id });
  checks.hotpCounterStored = { code: afterAdvance?.code, counter: afterAdvance?.counter };

  // The popup only lists accounts for the *active* tab's host, so seed the
  // local test server's host with one HOTP and one Steam entry.
  await send({
    type: 'SV_ADD_ENTRY',
    entry: {
      host: '127.0.0.1',
      username: 'hotp-user',
      password: 'hotp-pass-1',
      totpSecret: `otpauth://hotp/HOTP:hotp-user?secret=${SECRET}&issuer=HOTP&counter=0`,
    },
  });
  await send({
    type: 'SV_ADD_ENTRY',
    entry: {
      host: '127.0.0.1',
      username: 'steam-user',
      password: 'steam-pass-1',
      totpSecret: `steam://${SECRET}`,
    },
  });
  const popupHotpEntry = (await send({ type: 'SV_LIST_ENTRIES' })).entries.find(
    (entry) => entry.host === '127.0.0.1' && entry.username === 'hotp-user',
  );

  const steamEntry = (await send({ type: 'SV_LIST_ENTRIES' })).entries.find(
    (entry) => entry.host === 'steam.example.com',
  );
  const steamCode = await send({ type: 'SV_GET_TOTP_CODE', id: steamEntry.id });
  checks.steamCode = { code: steamCode?.code, type: steamCode?.type, digits: steamCode?.digits };

  // Site OTP must never surface HOTP automatically (it would burn counters).
  const siteOtp = await send({ type: 'SV_GET_SITE_TOTP', host: 'hotp.example.com', port: '' });
  checks.siteOtpSkipsHotp = Array.isArray(siteOtp?.entries) ? siteOtp.entries.length === 0 : true;

  // ---- options UI ------------------------------------------------------
  await options.reload();
  await options.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  await options.locator('[data-section="vault"]').click();
  await options.waitForSelector('.entry-card', { timeout: 15000 });
  await options.evaluate(() => { const shield = document.querySelector('#privacyShield'); if (shield) shield.hidden = true; });

  // Two entries share the "hotp-user" name, so scope the card by its host.
  const hotpCard = options
    .locator('.entry-card')
    .filter({ hasText: 'hotp.example.com' })
    .filter({ hasText: 'hotp-user' })
    .first();
  // The code must be readable inline, before opening the dialog.
  await options.waitForTimeout(1200);
  checks.inlineChip = (
    await hotpCard.locator('.entry-totp strong').first().innerText()
  ).trim();
  checks.inlineChipMeta = (
    await hotpCard.locator('.entry-totp span').first().innerText()
  ).trim();

  await hotpCard.locator('.entry-totp').first().click();
  await options.waitForSelector('#totpDialog[open]', { timeout: 10000 });
  await options.waitForTimeout(400);
  checks.dialogHotp = {
    title: (await options.locator('#totpTitle').innerText()).trim(),
    code: (await options.locator('#totpCode').innerText()).trim(),
    nextVisible: await options.locator('#totpNextBtn').isVisible(),
    progressHidden: await options.locator('#totpProgress').isHidden(),
    meta: (await options.locator('#totpMeta').innerText()).trim(),
  };

  await options.locator('#totpNextBtn').click();
  await options.waitForTimeout(600);
  checks.dialogHotpNext = {
    code: (await options.locator('#totpCode').innerText()).trim(),
    meta: (await options.locator('#totpMeta').innerText()).trim(),
  };
  await options.locator('#totpClose').click();
  await options.locator('#totpDialog').waitFor({ state: 'hidden', timeout: 5000 });

  // Reopening must show the advanced counter, proving persistence.
  await hotpCard.locator('.entry-totp').first().click();
  await options.waitForSelector('#totpDialog[open]', { timeout: 10000 });
  await options.waitForTimeout(500);
  checks.dialogHotpReopen = {
    code: (await options.locator('#totpCode').innerText()).trim(),
    meta: (await options.locator('#totpMeta').innerText()).trim(),
  };
  await options.locator('#totpClose').click();
  await options.locator('#totpDialog').waitFor({ state: 'hidden', timeout: 5000 });

  const steamCard = options.locator('.entry-card').filter({ hasText: 'steam-user' }).first();
  await steamCard.locator('.entry-totp').first().click();
  await options.waitForSelector('#totpDialog[open]', { timeout: 10000 });
  await options.waitForTimeout(400);
  checks.dialogSteam = {
    title: (await options.locator('#totpTitle').innerText()).trim(),
    code: (await options.locator('#totpCode').innerText()).trim(),
    nextHidden: await options.locator('#totpNextBtn').isHidden(),
    progressVisible: await options.locator('#totpProgress').isVisible(),
  };
  await options.locator('#totpClose').click();
  await options.locator('#totpDialog').waitFor({ state: 'hidden', timeout: 5000 });

  // ---- popup rows ------------------------------------------------------
  const beforePopup = await send({ type: 'SV_GET_TOTP_CODE', id: popupHotpEntry.id });
  checks.counterBeforePopup = beforePopup?.counter;
  // The popup resolves its host from the *active* tab, so the site tab must be
  // active while the popup page itself is opened in the background.
  const siteTab = await options.evaluate(async (targetPort) => {
    const tab = await chrome.tabs.create({ url: `http://127.0.0.1:${targetPort}/`, active: true });
    return tab.id;
  }, port);
  await options.waitForTimeout(1200);
  // Open the popup in a *background* tab: if it became the active tab it would
  // read its own URL as the site and show no host-specific state.
  await options.evaluate(
    (url) => chrome.tabs.create({ url, active: false }),
    `chrome-extension://${extensionId}/src/popup/popup.html`,
  );
  await options.waitForTimeout(1500);
  let popup = context.pages().find((page) => page.url().includes('/src/popup/popup.html'));
  if (!popup) {
    await options.waitForTimeout(1500);
    popup = context.pages().find((page) => page.url().includes('/src/popup/popup.html'));
  }
  if (!popup) throw new Error('popup page was not created');
  popup.on('pageerror', (error) => errors.push(String(error)));
  await popup.waitForTimeout(2000);
  checks.popupHasNoSearch = (await popup.locator('#popupSearch').count()) === 0;
  checks.popupSearchTitle = (await popup.locator('#siteTitleText').innerText()).trim();
  await popup.waitForTimeout(1200);
  checks.popupRows = await popup.evaluate(() => {
    const rows = [...document.querySelectorAll('.entry-row')];
    return rows.map((row) => ({
      user: row.querySelector('.entry-user')?.textContent?.trim() || '',
      otp: row.querySelector('.entry-otp strong')?.textContent?.trim() || '',
      meta: row.querySelector('.entry-otp span')?.textContent?.trim() || '',
      kind: row.querySelector('.entry-otp strong')?.dataset?.otpKind || '',
    }));
  });
  await options.evaluate((tabId) => chrome.tabs.remove(tabId), siteTab);

  // Rendering the popup must not consume a HOTP counter.
  const afterPopup = await send({ type: 'SV_GET_TOTP_CODE', id: popupHotpEntry.id });
  checks.counterAfterPopup = afterPopup?.counter;
  checks.popupDidNotAdvance =
    Number.isFinite(checks.counterBeforePopup) && afterPopup?.counter === checks.counterBeforePopup;

  checks.pass = Boolean(
    checks.hotpAdd
    && checks.hotpEntry.hasTotp
    && checks.hotpCounter0.code === RFC_CODES[0]
    && checks.hotpCounter0.type === 'hotp'
    && checks.hotpCounter1.code === RFC_CODES[1]
    && checks.hotpCounterStored.code === RFC_CODES[2]
    && checks.hotpCounterStored.counter === 2
    && checks.steamAdd
    && STEAM_ALPHABET.test(checks.steamCode.code || '')
    && checks.steamCode.type === 'steam'
    && checks.siteOtpSkipsHotp
    && /^\d{6}$/.test(checks.inlineChip || '')
    && checks.inlineChipMeta === '#2'
    && checks.dialogHotp.title.includes('HOTP')
    && checks.dialogHotp.code === RFC_CODES[2]
    && checks.dialogHotp.nextVisible
    && checks.dialogHotp.progressHidden
    && checks.dialogHotpNext.code === RFC_CODES[3]
    && checks.dialogHotpReopen.code === RFC_CODES[4]
    && checks.dialogSteam.title.includes('Steam Guard')
    && STEAM_ALPHABET.test(checks.dialogSteam.code || '')
    && checks.dialogSteam.nextHidden
    && checks.dialogSteam.progressVisible
    && checks.popupHasNoSearch
    && checks.popupSearchTitle === '本站账号'
    && checks.popupRows.some((row) => row.kind === 'hotp' && /^\d{6}$/.test(row.otp))
    && checks.popupRows.some((row) => row.kind === 'steam' && STEAM_ALPHABET.test(row.otp))
    && checks.popupDidNotAdvance
  );
} catch (error) {
  checks.error = String(error?.stack || error);
  checks.pass = false;
} finally {
  if (context) await context.close().catch(() => {});
  server.close();
}

console.log(JSON.stringify({ ...checks, errors }, null, 2));
process.exit(checks.pass && errors.length === 0 ? 0 : 1);
