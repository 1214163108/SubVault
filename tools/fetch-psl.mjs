import fs from 'node:fs';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage();
await page.goto(
  'https://publicsuffix.org/list/public_suffix_list.dat',
  { waitUntil: 'load', timeout: 120_000 },
);
const text = await page.evaluate(() => document.body.innerText);
await browser.close();

if (!text.includes('===BEGIN ICANN DOMAINS===') || !text.includes('===BEGIN PRIVATE DOMAINS===')) {
  throw new Error(`unexpected PSL content (${text.length} bytes)`);
}
fs.writeFileSync('psl.dat', text, 'utf8');
console.log(`wrote psl.dat (${text.length} bytes)`);
