import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';

const root = path.resolve(import.meta.dirname, '..');
const syncDir = path.join(root, '.tmp-host', 'save-data');
fs.rmSync(syncDir, { recursive: true, force: true });
fs.mkdirSync(syncDir, { recursive: true });

const html = `<!doctype html><html><body>
  <form id="login" onsubmit="event.preventDefault()">
    <label>用户名 <input name="username" autocomplete="username" /></label>
    <label>密码 <input name="password" type="password" autocomplete="current-password" /></label>
    <button type="submit">登录</button>
  </form>
</body></html>`;

const spaHtml = `<!doctype html><html><body>
  <form id="login">
    <label>用户名 <input name="username" autocomplete="username" /></label>
    <label>密码 <input name="password" type="password" autocomplete="current-password" /></label>
    <button id="spa-login" type="button">登录</button>
  </form>
</body></html>`;

const spanHtml = `<!doctype html><html><body>
  <form id="login">
    <label>用户名 <input name="username" autocomplete="username" /></label>
    <label>密码 <input name="password" type="password" autocomplete="current-password" /></label>
    <div id="span-login"><span>登 录</span></div>
  </form>
</body></html>`;

const server = http.createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  const pathname = request.url.split('?')[0];
  if (pathname === '/iframe-host') {
    response.end('<!doctype html><html><body><h1>Dashboard</h1><iframe src="/"></iframe></body></html>');
    return;
  }
  response.end(pathname === '/spa' ? spaHtml : pathname === '/span' ? spanHtml : html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const context = await chromium.launchPersistentContext('', {
  headless: false,
  env: { ...process.env, SUBVAULT_SYNC_DIR: syncDir },
  args: [
    `--disable-extensions-except=${root}`,
    `--load-extension=${root}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-position=-32000,-32000',
    '--window-size=1000,900',
  ],
});

try {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = worker.url().split('/')[2];
  const options = await context.newPage();
  await options.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await options.waitForFunction(() => Boolean(window.chrome?.runtime?.id));
  const setup = await options.evaluate(() =>
    chrome.runtime.sendMessage({ type: 'SV_SETUP', password: 'save-password' }),
  );
  if (!setup?.ok) throw new Error(`setup: ${setup?.error}`);
  await options.evaluate(() =>
    chrome.runtime.sendMessage({
      type: 'SV_SET_SETTINGS',
      settings: {
        savePrompt: true,
        lockOnSystemLock: false,
        lockOnSystemIdle: false,
        autoOpenOnFocus: false,
      },
    }),
  );

  async function submitForm(page, username, password, selector = 'button[type="submit"]') {
    await page.locator('input[name="username"]').fill(username);
    await page.locator('input[name="password"]').fill(password);
    await page.locator(selector).click();
    await page.waitForTimeout(300);
    const banner = page.locator('[data-subvault-save-banner]');
    await banner.waitFor({ state: 'visible', timeout: 8000 });
    return banner;
  }

  const page = await context.newPage();
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.waitForTimeout(500);
  await page.locator('input[name="username"]').fill('new-user');
  await page.locator('input[name="password"]').fill('new-password');
  await page.locator('input[name="username"]').click();
  await page.locator('input[name="password"]').click();
  await page.waitForTimeout(400);
  if (await page.locator('[data-subvault-save-banner]').isVisible()) {
    throw new Error('save banner appeared from clicking inputs');
  }
  await page.keyboard.press('Enter');
  const enterBanner = page.locator('[data-subvault-save-banner]');
  await enterBanner.waitFor({ state: 'visible', timeout: 8000 });
  const enterTitle = await enterBanner.locator('.sv-banner-title').textContent();
  await enterBanner.locator('[data-subvault-dismiss]').click();
  await page.waitForTimeout(4200);

  const createBanner = await submitForm(page, 'new-user', 'new-password');
  await page.screenshot({ path: path.join(root, 'docs', 'save-banner.png') });

  await page.evaluate(() => {
    for (let index = 0; index < 3; index += 1) {
      const frame = document.createElement('iframe');
      frame.src = '/';
      frame.style.cssText = `position:fixed;left:${index * 70}px;top:${index * 70}px;width:240px;height:120px;z-index:1;`;
      document.body.appendChild(frame);
    }
  });
  await page.waitForTimeout(900);
  const bannerFrames = await page.evaluate(() => {
    let count = 0;
    const visit = (win) => {
      try {
        const root = win.document.getElementById('subvault-ui-root')?.shadowRoot;
        if (root?.querySelector('[data-subvault-save-banner]:not([hidden])')) count += 1;
        for (const child of win.frames) visit(child);
      } catch {
        /* cross-origin frame */
      }
    };
    visit(window);
    return count;
  });
  if (bannerFrames !== 1) {
    throw new Error(`save banner should only appear once, got ${bannerFrames}`);
  }
  const createTitle = await createBanner.locator('.sv-banner-title').textContent();
  await createBanner.locator('[data-subvault-save]').click();
  await page.waitForTimeout(500);
  const createToast = await page.evaluate(
    () =>
      document.getElementById('subvault-ui-root')?.shadowRoot?.querySelector('.sv-toast')
        ?.textContent || '',
  );
  if (!createToast.includes('新增账号：new-user')) {
    throw new Error(`new account toast not detailed: ${createToast}`);
  }
  const created = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }));
  if (created.entries.length !== 1 || created.entries[0].username !== 'new-user') {
    throw new Error(`new account not saved: ${JSON.stringify(created)}`);
  }

  await page.reload();
  await page.waitForTimeout(500);
  const updateBanner = await submitForm(page, 'new-user', 'changed-password');
  const updateTitle = await updateBanner.locator('.sv-banner-title').textContent();

  async function bannerMetrics() {
    return page.evaluate(() => {
      const banner = document.getElementById('subvault-ui-root')?.shadowRoot?.querySelector(
        '[data-subvault-save-banner]',
      );
      const rect = banner?.getBoundingClientRect();
      return {
        className: banner?.className || '',
        rect: rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : null,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      };
    });
  }

  async function setBannerPosition(position) {
    await options.evaluate(
      (value) =>
        chrome.runtime.sendMessage({
          type: 'SV_SET_SETTINGS',
          settings: { savePromptPosition: value },
        }),
      position,
    );
    await page.waitForTimeout(300);
    return bannerMetrics();
  }

  const positions = {};
  positions['top-left'] = await setBannerPosition('top-left');
  if (
    positions['top-left'].rect.x > 30 ||
    positions['top-left'].rect.y > 30 ||
    !positions['top-left'].className.includes('pos-top-left')
  ) {
    throw new Error(`top-left position failed: ${JSON.stringify(positions['top-left'])}`);
  }

  positions['bottom-right'] = await setBannerPosition('bottom-right');
  const br = positions['bottom-right'];
  if (
    br.rect.x + br.rect.width < br.viewport.width - 40 ||
    br.rect.y + br.rect.height < br.viewport.height - 40 ||
    !br.className.includes('pos-bottom-right')
  ) {
    throw new Error(`bottom-right position failed: ${JSON.stringify(br)}`);
  }

  positions.center = await setBannerPosition('center');
  const center = positions.center;
  if (
    Math.abs(center.rect.x + center.rect.width / 2 - center.viewport.width / 2) > 8 ||
    Math.abs(center.rect.y + center.rect.height / 2 - center.viewport.height / 2) > 8 ||
    center.rect.width < 430 ||
    !center.className.includes('pos-center')
  ) {
    throw new Error(`center position failed: ${JSON.stringify(center)}`);
  }
  await page.screenshot({ path: path.join(root, 'docs', 'save-banner-center.png') });

  await page.setViewportSize({ width: 800, height: 500 });
  await page.waitForTimeout(300);
  const compactCenter = await bannerMetrics();
  if (
    compactCenter.rect.width > 776 ||
    compactCenter.rect.x < 0 ||
    compactCenter.rect.y < 0 ||
    compactCenter.rect.x + compactCenter.rect.width > compactCenter.viewport.width ||
    compactCenter.rect.y + compactCenter.rect.height > compactCenter.viewport.height
  ) {
    throw new Error(`compact center failed: ${JSON.stringify(compactCenter)}`);
  }
  positions.compactCenter = compactCenter;

  await setBannerPosition('top-right');
  await updateBanner.locator('[data-subvault-save]').click();
  await page.waitForTimeout(500);
  const updateToast = await page.evaluate(
    () =>
      document.getElementById('subvault-ui-root')?.shadowRoot?.querySelector('.sv-toast')
        ?.textContent || '',
  );
  if (!updateToast.includes('更新账号：new-user')) {
    throw new Error(`update account toast not detailed: ${updateToast}`);
  }
  const updated = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }));
  const password = await options.evaluate(async (id) => {
    const result = await chrome.runtime.sendMessage({ type: 'SV_GET_SECRET', id });
    return result.password;
  }, updated.entries[0].id);
  if (password !== 'changed-password') {
    throw new Error(`password not updated: ${password}`);
  }

  await page.goto(`http://127.0.0.1:${port}/spa`);
  await page.waitForTimeout(500);
  const spaBanner = await submitForm(page, 'spa-user', 'spa-password', '#spa-login');
  const spaTitle = await spaBanner.locator('.sv-banner-title').textContent();
  await spaBanner.locator('[data-subvault-save]').click();
  await page.waitForTimeout(500);
  const afterSpa = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }));

  await page.goto(`http://127.0.0.1:${port}/span`);
  await page.waitForTimeout(500);
  const spanBanner = await submitForm(page, 'span-user', 'span-password', '#span-login span');
  const spanTitle = await spanBanner.locator('.sv-banner-title').textContent();
  await spanBanner.locator('[data-subvault-save]').click();
  await page.waitForTimeout(500);
  const afterSpan = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'SV_LIST_ENTRIES' }));

  await page.goto(`http://127.0.0.1:${port}/iframe-host`);
  await page.waitForTimeout(800);
  const loginFrame = page.frames().find((frame) => frame !== page.mainFrame());
  if (!loginFrame) throw new Error('login iframe missing');
  await loginFrame.locator('input[name="username"]').fill('iframe-user');
  await loginFrame.locator('input[name="password"]').fill('iframe-password');
  await loginFrame.locator('button[type="submit"]').click();
  const iframeTopBanner = page.locator('[data-subvault-save-banner]');
  await iframeTopBanner.waitFor({ state: 'visible', timeout: 8000 });
  const iframeTitle = await iframeTopBanner.locator('.sv-banner-title').textContent();
  await iframeTopBanner.locator('[data-subvault-dismiss]').click();

  console.log(
    JSON.stringify(
      {
        ok: true,
        noPromptOnInputClick: true,
        enterTitle,
        createTitle,
        createToast,
        bannerFrames,
        updateTitle,
        updateToast,
        spaTitle,
        spanTitle,
        iframeLoginBanner: iframeTitle,
        positions: Object.fromEntries(
          Object.entries(positions).map(([key, value]) => [
            key,
            { width: Math.round(value.rect.width), className: value.className },
          ]),
        ),
        entries: afterSpan.entries.length,
        password,
      },
      null,
      2,
    ),
  );
} finally {
  await context.close();
  await new Promise((resolve) => server.close(resolve));
}
