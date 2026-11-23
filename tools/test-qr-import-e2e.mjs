/**
 * Offline QR import coverage.
 *
 * Chrome's BarcodeDetector is not available in every Chromium build, so the
 * options page falls back to the bundled jsQR decoder. This test removes
 * `window.BarcodeDetector` to force that path, feeds a generated PNG, and
 * checks that the otpauth URI lands in the TOTP field.
 */
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const ROOT = path.resolve('.');
const BASE = path.join(ROOT, '.tmp-qr-import', String(Date.now()));
// Keep the native host away from the real per-user vault during tests.
const syncDir = path.join(ROOT, '.tmp-host', 'test-qr-import-e2e-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });
const MASTER = 'SubVault-Test-2026!Qm7#';
const SECRET = 'JBSWY3DPEHPK3PXP';
const URI = `otpauth://totp/SubVault:qr-user?secret=${SECRET}&issuer=SubVault&period=30&digits=6`;
const FIXTURE = path.join(ROOT, 'tools', 'fixtures', 'qrcode-generator.js');

try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }); } catch { /* ignore */ }
fs.mkdirSync(BASE, { recursive: true });

const checks = {};

/** Extension pages run under a strict CSP, so page.waitForFunction is unusable. */
async function waitForHint(page, needle, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let text = '';
  while (Date.now() < deadline) {
    text = (await page.textContent('#entryTotpHint').catch(() => '')) || '';
    if (text.includes(needle)) return text.trim();
    await page.waitForTimeout(150);
  }
  throw new Error(`timed out waiting for hint "${needle}", last text: ${text.trim()}`);
}
const errors = [];
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
      '--window-size=1100,900',
    ],
    locale: 'zh-CN',
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];

  // Render a QR PNG in a scratch page that has no extension CSP.
  const scratch = await context.newPage();
  await scratch.goto('about:blank');
  await scratch.addScriptTag({ path: FIXTURE });
  const dataUrl = await scratch.evaluate((text) => {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    const scale = 8;
    const quiet = 4 * scale;
    const size = count * scale + quiet * 2;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = '#000000';
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(quiet + col * scale, quiet + row * scale, scale, scale);
        }
      }
    }
    return canvas.toDataURL('image/png');
  }, URI);
  const qrPath = path.join(BASE, 'otpauth.png');
  fs.writeFileSync(qrPath, Buffer.from(dataUrl.split(',')[1], 'base64'));
  const blankPath = path.join(BASE, 'blank.png');
  const blankDataUrl = await scratch.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 240;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 240, 240);
    return canvas.toDataURL('image/png');
  });
  fs.writeFileSync(blankPath, Buffer.from(blankDataUrl.split(',')[1], 'base64'));
  await scratch.close();
  checks.fixtureWritten = fs.statSync(qrPath).size > 500;

  const options = await context.newPage();
  options.on('pageerror', (error) => errors.push(String(error)));
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForSelector('#gate');
  const send = (message) => options.evaluate((payload) => chrome.runtime.sendMessage(payload), message);
  const setup = await send({ type: 'SV_SETUP', password: MASTER });
  if (!setup?.ok) throw new Error(`setup failed: ${setup?.error}`);
  await send({
    type: 'SV_SET_SETTINGS',
    settings: { lockOnSystemLock: false, lockOnSystemIdle: false, autoLockMinutes: 0 },
  });

  await options.reload();
  await options.waitForSelector('#gate', { state: 'hidden', timeout: 15000 });
  await options.evaluate(() => { const shield = document.querySelector('#privacyShield'); if (shield) shield.hidden = true; });

  checks.jsQrLoaded = await options.evaluate(() => typeof window.jsQR === 'function');
  // Force the jsQR fallback even when this Chromium ships BarcodeDetector.
  await options.evaluate(() => { delete window.BarcodeDetector; });
  checks.barcodeDetectorRemoved = await options.evaluate(() => !('BarcodeDetector' in window));

  await options.click('#headAddBtn');
  await options.waitForSelector('#entryDialog[open]');
  await options.setInputFiles('#entryTotpQrFile', qrPath);
  checks.hint = await waitForHint(options, '已识别');
  checks.totpValue = await options.inputValue('#entryTotp');
  checks.parsedOk = checks.totpValue === URI;

  // A picture without a QR must produce a readable error, not a silent no-op.
  await options.setInputFiles('#entryTotpQrFile', blankPath);
  checks.blankHint = await waitForHint(options, '没有识别到二维码');

  // Saving the imported secret must produce working codes.
  await options.fill('#entryHost', 'qr.example.com');
  await options.fill('#entryUsername', 'qr-user');
  await options.fill('#entryPassword', 'qr-pass-1');
  await options.fill('#entryTotp', URI);
  await options.click('#entrySave');
  await options.waitForSelector('#entryDialog', { state: 'hidden', timeout: 10000 });
  const list = await send({ type: 'SV_LIST_ENTRIES' });
  const entry = (list.entries || []).find((item) => item.host === 'qr.example.com');
  checks.entrySaved = Boolean(entry?.hasTotp);
  const code = entry ? await send({ type: 'SV_GET_TOTP_CODE', id: entry.id }) : null;
  checks.code = { code: code?.code, digits: code?.digits, period: code?.period };

  checks.pass = Boolean(
    checks.fixtureWritten
    && checks.jsQrLoaded
    && checks.barcodeDetectorRemoved
    && checks.parsedOk
    && checks.hint.includes('已识别 otpauth 链接')
    && checks.blankHint.includes('没有识别到二维码')
    && checks.entrySaved
    && /^\d{6}$/.test(checks.code.code || '')
    && checks.code.digits === 6
    && checks.code.period === 30
  );
} catch (error) {
  checks.error = String(error?.stack || error);
  checks.pass = false;
} finally {
  if (context) await context.close().catch(() => {});
}

console.log(JSON.stringify({ ...checks, errors }, null, 2));
process.exit(checks.pass && errors.length === 0 ? 0 : 1);
