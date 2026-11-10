import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'docs');
fs.mkdirSync(out, { recursive: true });

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
    '--window-size=900,900',
  ],
  viewport: { width: 382, height: 600 },
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const page = await context.newPage();
  await page.setViewportSize({ width: 382, height: 600 });
  await page.goto(`chrome-extension://${extensionId}/src/popup/popup.html`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(out, 'popup-setup.png') });
  console.log(`wrote docs/popup-setup.png (${await page.evaluate(() => document.body.scrollWidth)}px)`);
} finally {
  await context.close();
}
