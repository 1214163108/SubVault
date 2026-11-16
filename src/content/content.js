(() => {
  'use strict';

  const isTopFrame = window === window.top;

  const DEFAULTS = {
    autoFill: false,
    autoOpenOnFocus: false,
    savePrompt: true,
    savePromptPosition: 'top-right',
    theme: 'system',
    material: 'solid',
    showIcon: true,
    takeoverMode: true,
    clearNativeAutofill: true,
    uiLanguage: 'auto',
  };

  const UI_EN = {
    '保存新账号': 'Save new account',
    '更新登录密码': 'Update login password',
    '填充登录信息': 'Fill login',
    '独立子域': 'Isolated subdomain',
    '主域共享': 'Shared main domain',
    '没有匹配的账号': 'No matching accounts',
    '当前网站还没有保存的账号': 'No accounts saved for this site yet',
    '填充': 'Fill',
    '保存': 'Save',
    '暂不': 'Not now',
    '此网站不再提示': "Don't ask on this site",
    '去解锁': 'Unlock',
    '@ 使用别名': '@ Use alias',
    '使用别名邮箱': 'Use alias email',
    '已保存的别名邮箱': 'Saved alias emails',
    '点击复制别名邮箱（不会自动填入）': 'Click to copy an alias email (never auto-filled)',
    '还没有保存的别名': 'No saved aliases yet',
    '在账号条目中填写“注册邮箱/别名”后即可使用': 'Add “Signup email / alias” to an account to use it here',
    '已复制别名邮箱': 'Alias email copied',
    '已保存别名': 'Saved alias',
    '创建密码库': 'Create vault',
    '密码库已锁定': 'Vault is locked',
    '还没有密码库': 'No vault yet',
    '保存账号': 'Save account',
    '更新账号': 'Update account',
    '更新': 'Update',
    '新增': 'New',
    '已生成强密码': 'Strong password generated',
    '请在完成注册后保存到 SubVault': 'Save it to SubVault after finishing sign-up',
    '此网站将不再提示保存': "This site will no longer prompt to save",
    '没有找到可填充的登录框': 'No fillable login field found',
    '没有找到可填写的登录框': 'No fillable login field found',
    '已接管浏览器自动填充，请用钥匙选择 SubVault 账号':
      'Autofill taken over — use the key button to pick a SubVault account',
    '保存失败': 'Save failed',
    '已复制密码': 'Password copied',
    '已复制用户名': 'Username copied',
    '复制失败': 'Copy failed',
    '已填入账号': 'Filled account',
    '账号': 'Account',
    '关闭': 'Close',
    '生成强密码并填入': 'Generate a strong password and fill it',
    '用 SubVault 填充密码': 'Fill with SubVault',
    'SubVault 账号列表': 'SubVault accounts',
    '账号列表': 'Accounts',
    '管理密码库': 'Manage vault',
    '记录于': 'Recorded',
    '此网站还没有保存的账号': 'No accounts saved for this site yet',
  };
  const textOriginals = new WeakMap();
  const attributeOriginals = new WeakMap();

  function detectEnglish() {
    try {
      const language = String(chrome?.i18n?.getUILanguage?.() || 'zh');
      return !language.toLowerCase().startsWith('zh');
    } catch {
      return false;
    }
  }

  let UI_ENGLISH = detectEnglish();

  function applyUiLanguage(preference) {
    if (preference === 'en') UI_ENGLISH = true;
    else if (preference === 'zh-CN' || preference === 'zh') UI_ENGLISH = false;
    else UI_ENGLISH = detectEnglish();
    if (shadow) localizeNode(shadow);
  }

  function tr(text) {
    if (!UI_ENGLISH) return text;
    const hit = UI_EN[String(text).trim()];
    return hit ? String(text).replace(String(text).trim(), hit) : text;
  }

  function localizeNode(root) {
    if (!root) return;
    try {
      const walker = document.createTreeWalker(root, 4);
      const nodes = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node);
      if (!UI_ENGLISH) {
        for (const node of nodes) {
          const original = textOriginals.get(node);
          if (original != null && node.nodeValue !== original) node.nodeValue = original;
        }
        for (const element of root.querySelectorAll?.(
          '[placeholder], [title], [aria-label], [alt]',
        ) || []) {
          const originals = attributeOriginals.get(element);
          if (!originals) continue;
          for (const attr of ['placeholder', 'title', 'aria-label', 'alt']) {
            if (!(attr in originals)) continue;
            if (element.getAttribute?.(attr) !== originals[attr]) {
              element.setAttribute(attr, originals[attr]);
            }
          }
        }
        return;
      }
      for (const node of nodes) {
        const parent = node.parentElement;
        if (parent && (parent.closest('[data-i18n-raw]') || ['SCRIPT', 'STYLE', 'CODE'].includes(parent.tagName))) {
          continue;
        }
        const current = node.nodeValue;
        if (!current) continue;
        const original = textOriginals.get(node) ?? current;
        if (!/[一-鿿]/.test(original)) continue;
        const key = original.trim();
        let translated = UI_EN[key];
        if (!translated) {
          // Prefix entries such as 记录于 + timestamp.
          let best = '';
          for (const candidate of Object.keys(UI_EN)) {
            if (candidate.length >= 2 && key.startsWith(candidate) && /\s/.test(key.charAt(candidate.length))) {
              if (candidate.length > best.length) best = candidate;
            }
          }
          if (best) translated = UI_EN[best] + key.slice(best.length);
        }
        if (!translated) continue;
        if (!textOriginals.has(node)) textOriginals.set(node, current);
        const next = original.replace(key, translated);
        if (next !== current) node.nodeValue = next;
      }
      for (const element of root.querySelectorAll?.(
        '[placeholder], [title], [aria-label], [alt]',
      ) || []) {
        for (const attr of ['placeholder', 'title', 'aria-label', 'alt']) {
          const current = element.getAttribute?.(attr);
          if (!current || !/[一-鿿]/.test(current)) continue;
          let originals = attributeOriginals.get(element);
          if (!originals) {
            originals = Object.create(null);
            attributeOriginals.set(element, originals);
          }
          const original = originals[attr] ?? current;
          const key = original.trim();
          const hit = UI_EN[key];
          if (!hit) continue;
          if (!(attr in originals)) originals[attr] = current;
          const next = original.replace(key, hit);
          if (next !== current) element.setAttribute(attr, next);
        }
      }
    } catch {
      /* best-effort */
    }
  }

  function installLocalization(root) {
    if (!UI_ENGLISH || !root) return;
    localizeNode(root);
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        localizeNode(root);
      });
    });
    observer.observe(root, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['placeholder', 'title', 'aria-label', 'alt'],
    });
  }

  const state = {
    host: location.hostname.toLowerCase().replace(/\.$/, ''),
    siteKey: '',
    isolated: false,
    settings: { ...DEFAULTS },
    settingsLoaded: false,
    settingsVersion: 0,
    matches: [],
    matchesAt: 0,
    matchesHost: '',
    locked: false,
    activePassword: null,
    usernameOnly: false,
    panelOpen: false,
    search: '',
    activeIndex: 0,
    anchorField: null,
    genField: null,
    autoOpened: new WeakSet(),
    banner: null,
    pendingQueue: [],
    lastSignature: '',
    lastCaptureAt: 0,
    lockedHintShown: false,
    uiReady: false,
    toastTimer: 0,
  };

  let rootHost = null;
  let shadow = null;
  let ui = null;
  let observer = null;
  let markTimer = 0;
  let repositionFrame = 0;
  let nativeCheckTimers = [];
  let nativeHooksInstalled = false;
  const nativeCleared = new WeakSet();

  /* ------------------------------------------------------------------ */
  /* Messaging                                                           */
  /* ------------------------------------------------------------------ */

  function send(type, payload = {}) {
    return new Promise((resolve) => {
      try {
        if (!chrome?.runtime?.id) {
          resolve({ ok: false, error: '扩展已更新，请刷新页面' });
          return;
        }
        chrome.runtime.sendMessage({ type, ...payload }, (response) => {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message || '扩展无响应' });
            return;
          }
          resolve(response || { ok: false, error: '扩展无响应' });
        });
      } catch (error) {
        resolve({ ok: false, error: error?.message || String(error) });
      }
    });
  }

  function isLockedError(message) {
    return typeof message === 'string' && message.includes('锁定');
  }

  /* ------------------------------------------------------------------ */
  /* Small utilities                                                     */
  /* ------------------------------------------------------------------ */

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function formatTime(timestamp) {
    const value = Number(timestamp);
    if (!Number.isFinite(value) || value <= 0) return '';
    try {
      return new Intl.DateTimeFormat('zh-CN', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      }).format(new Date(value));
    } catch {
      return new Date(value).toLocaleString();
    }
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor =
      Object.getOwnPropertyDescriptor(prototype, 'value') ||
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    if (descriptor?.set) descriptor.set.call(element, value);
    else element.value = value;
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function isVisible(element) {
    if (!(element instanceof HTMLElement) || !element.isConnected) return false;
    const style = getComputedStyle(element);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width >= 12 && rect.height >= 8;
  }

  function isUsableInput(element) {
    return (
      element instanceof HTMLInputElement &&
      isVisible(element) &&
      !element.disabled &&
      !element.readOnly
    );
  }

  function inputType(input) {
    return (input.getAttribute('type') || 'text').toLowerCase();
  }

  function isPasswordInput(input) {
    if (!(input instanceof HTMLInputElement)) return false;
    const type = inputType(input);
    if (type === 'password') return true;
    const autocomplete = (
      input.dataset.svAutocompleteStored ??
      input.getAttribute('autocomplete') ??
      ''
    ).toLowerCase();
    if (autocomplete === 'current-password' || autocomplete === 'new-password') return true;
    if (type !== 'text') return false;
    return /password|passwd|pwd/.test(`${input.name} ${input.id}`.toLowerCase());
  }

  function originalAutocomplete(input) {
    return (input.dataset.svAutocompleteStored ?? input.getAttribute('autocomplete') ?? '').toLowerCase();
  }

  function looksLikeNewPassword(input) {
    if (!isPasswordInput(input)) return false;
    if (originalAutocomplete(input) === 'new-password') return true;
    const haystack = `${input.name} ${input.id} ${input.getAttribute('aria-label') || ''}`.toLowerCase();
    return /new.?password|confirm|repeat|retype|newpass|新密码|确认密码|重复密码/.test(haystack);
  }

  function looksLikeOtp(input) {
    const haystack = `${input.name} ${input.id} ${originalAutocomplete(input)} ${
      input.placeholder || ''
    }`.toLowerCase();
    if (originalAutocomplete(input) === 'one-time-code') return true;
    return /\botp\b|one.?time|verification.?code|验证码|动态码|auth.?code/.test(haystack);
  }

  function isUsernameCandidate(input) {
    if (!(input instanceof HTMLInputElement) || !isVisible(input)) return false;
    if (isPasswordInput(input)) return false;
    if (input.disabled || input.readOnly) return false;
    const type = inputType(input);
    if (!['text', 'email', 'tel', 'number'].includes(type)) return false;
    if (looksLikeOtp(input)) return false;
    const haystack = `${input.name} ${input.id} ${input.getAttribute('autocomplete') || ''} ${
      input.placeholder || ''
    } ${input.getAttribute('aria-label') || ''}`.toLowerCase();
    if (/\bsearch\b|搜索/.test(haystack)) return false;
    return (
      /user|email|login|account|phone|mobile|mail|账号|邮箱|手机|用户名/.test(haystack) ||
      originalAutocomplete(input) === 'username'
    );
  }

  function formOf(element) {
    return element.form || element.closest('form') || document;
  }

  function collectInputs(root = document) {
    const inputs = [];
    const seen = new Set();
    const visit = (scope) => {
      for (const input of scope.querySelectorAll('input')) {
        if (!seen.has(input)) {
          seen.add(input);
          inputs.push(input);
        }
      }
      for (const element of scope.querySelectorAll('*')) {
        if (element === rootHost) continue;
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(root);
    return inputs;
  }

  function visiblePasswordFields(scope) {
    const root = scope || document;
    return collectInputs(root).filter(
      (input) => isPasswordInput(input) && isVisible(input),
    );
  }

  function signsUpForm(form) {
    if (!form || form === document) return false;
    const button = form.querySelector(
      'button[type="submit"], input[type="submit"], button:not([type])',
    );
    const text = `${button?.innerText || button?.value || ''}`.toLowerCase();
    return /sign\s*up|register|create\s*account|注册|创建账号|创建账户/.test(text);
  }

  function isLoginPasswordField(input) {
    if (!isPasswordInput(input) || !isVisible(input)) return false;
    if (input.disabled || input.readOnly) return false;
    if (looksLikeNewPassword(input)) return false;
    const form = formOf(input);
    if (form !== document && signsUpForm(form)) return false;
    if (form !== document && visiblePasswordFields(form).length > 1) return false;
    return true;
  }

  function firstLoginPasswordField() {
    return collectInputs(document).find(
      (input) => isPasswordInput(input) && isLoginPasswordField(input),
    ) || null;
  }

  function firstUsernameField() {
    return collectInputs(document).find(isUsernameCandidate) || null;
  }

  function findUsernameField(passwordField) {
    const scope = formOf(passwordField);
    const candidates = collectInputs(scope).filter(
      (input) => isUsernameCandidate(input) && !isPasswordInput(input),
    );
    if (candidates.length === 0) return null;

    const byAutocomplete = candidates.find((input) =>
      /^(username|email)$/i.test(originalAutocomplete(input)),
    );
    if (byAutocomplete) return byAutocomplete;

    const before = candidates.filter((input) => {
      if (!passwordField.isConnected) return true;
      return Boolean(
        input.compareDocumentPosition(passwordField) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    if (before.length === 0) return null;

    const named = before.filter((input) =>
      /user|email|login|account|phone|mobile|mail|账号|邮箱|手机|用户名/.test(
        `${input.name} ${input.id} ${input.placeholder} ${input.getAttribute('aria-label') || ''}`.toLowerCase(),
      ),
    );
    return named[named.length - 1] || before[before.length - 1] || null;
  }

  function findPasswordForUsername(usernameField) {
    const scope = formOf(usernameField);
    const passwords = collectInputs(scope).filter(
      (input) => isPasswordInput(input) && isLoginPasswordField(input),
    );
    if (passwords.length === 0) return null;
    const after = passwords.find((password) => {
      return Boolean(
        usernameField.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING,
      );
    });
    return after || passwords[0];
  }

  function markField(input) {
    if (!(input instanceof HTMLInputElement)) return;
    if (input.dataset.svAutocompleteStored === undefined) {
      input.dataset.svAutocompleteStored = input.getAttribute('autocomplete') ?? '';
    }
    try {
      if (input.getAttribute('autocomplete') !== 'off') input.setAttribute('autocomplete', 'off');
    } catch {
      /* some pages freeze attributes */
    }
  }

  function applyTakeoverMarking(scope = document) {
    if (!state.settings.takeoverMode || sitePolicy().disableTakeover) return;
    const root = scope instanceof Document ? scope : scope.ownerDocument || document;
    for (const password of collectInputs(root)) {
      if (!isPasswordInput(password) || !isVisible(password)) continue;
      markField(password);
      const username = findUsernameField(password);
      if (username) markField(username);
    }
  }

  function isAutofilled(input) {
    try {
      return input.matches(':-webkit-autofill') || input.matches(':autofill');
    } catch {
      return false;
    }
  }

  async function maybeClearNativeAutofill(input, { announce = false, allowFocused = false } = {}) {
    if (!state.settings.takeoverMode || !state.settings.clearNativeAutofill) return false;
    if (sitePolicy().disableTakeover) return false;
    if (!isPasswordInput(input) || !input.value || nativeCleared.has(input)) return false;
    if (!allowFocused && input === document.activeElement) return false;
    if (!isAutofilled(input)) return false;

    const matches = await getMatches();
    if (matches.length === 0) return false;

    nativeCleared.add(input);
    setNativeValue(input, '');
    if (announce) {
      showToast('已接管浏览器自动填充，请用钥匙选择 SubVault 账号');
    }
    if (state.settings.autoFill && matches.length === 1) {
      void fillById(matches[0].id, { silent: true });
    }
    return true;
  }

  function scheduleNativeChecks() {
    for (const timer of nativeCheckTimers) clearTimeout(timer);
    nativeCheckTimers = [];
    for (const delay of [500, 1400, 3000, 6000]) {
      nativeCheckTimers.push(
        setTimeout(() => {
          applyTakeoverMarking();
          for (const password of collectInputs(document)) {
            if (isPasswordInput(password)) void maybeClearNativeAutofill(password);
          }
        }, delay),
      );
    }
  }

  function installNativeAutofillHooks() {
    if (nativeHooksInstalled || !document.documentElement) return;
    nativeHooksInstalled = true;
    const css =
      '@keyframes svAutofillDetect{from{opacity:1}to{opacity:1}}' +
      'input[type="password"]:-webkit-autofill{animation-name:svAutofillDetect;animation-duration:.001s}';
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    } catch {
      try {
        const style = document.createElement('style');
        style.id = 'subvault-native-detection';
        style.textContent = css;
        (document.head || document.documentElement).appendChild(style);
      } catch {
        /* optional detection hook */
      }
    }
    document.addEventListener(
      'animationstart',
      (event) => {
        if (event.animationName !== 'svAutofillDetect') return;
        if (event.target instanceof HTMLInputElement) {
          void maybeClearNativeAutofill(event.target, { announce: true });
        }
      },
      true,
    );
  }

  /* ------------------------------------------------------------------ */
  /* Data                                                                */
  /* ------------------------------------------------------------------ */

  function syncHost() {
    const host = location.hostname.toLowerCase().replace(/\.$/, '');
    if (host === state.host) return false;
    state.host = host;
    state.siteKey = '';
    state.matches = [];
    state.matchesAt = 0;
    state.matchesHost = '';
    state.lastSignature = '';
    hidePanel();
    hideTrigger();
    return true;
  }

  function sitePolicy() {
    const exceptions = state.settings.siteExceptions || {};
    return exceptions[state.host] || {};
  }

  async function getSettings() {
    if (state.settingsLoaded) return state.settings;
    const version = state.settingsVersion;
    const result = await send('SV_GET_SETTINGS');
    if (version !== state.settingsVersion) return state.settings;
    if (result.ok && result.settings) {
      state.settings = { ...DEFAULTS, ...result.settings };
      state.settingsLoaded = true;
      applyUiLanguage(state.settings.uiLanguage);
    }
    return state.settings;
  }

  async function getMatches(force = false) {
    syncHost();
    const now = Date.now();
    if (
      !force &&
      state.matchesHost === state.host &&
      now - state.matchesAt < 30_000
    ) {
      return state.matches;
    }
    const result = await send('SV_GET_MATCHES');
    if (!result.ok) {
      if (isLockedError(result.error)) {
        state.locked = true;
        state.matches = [];
      }
      return [];
    }
    state.locked = Boolean(result.locked);
    state.siteKey = result.siteKey || '';
    state.isolated = Boolean(result.isolated);
    state.matches = Array.isArray(result.matches) ? result.matches : [];
    state.matchesHost = state.host;
    state.matchesAt = Date.now();
    if (state.locked) {
      state.matches = [];
      hidePanel();
      hideTrigger();
    } else if (state.panelOpen) {
      renderPanel();
      positionUi();
    }
    return state.matches;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
  }

  function tabToNext(field) {
    const inputs = collectInputs(document).filter(
      (input) => input instanceof HTMLInputElement && !input.disabled && !input.readOnly && isVisible(input),
    );
    const index = inputs.indexOf(field);
    if (index >= 0 && inputs[index + 1]) {
      inputs[index + 1].focus({ preventScroll: true });
      return true;
    }
    return false;
  }

  async function runFillSequence(result, passwordField, usernameField) {
    const sequence = Array.isArray(result.fillSequence) ? result.fillSequence : [];
    for (const step of sequence) {
      if (step.type === 'username') {
        if (usernameField && result.username) setNativeValue(usernameField, result.username);
        usernameField?.focus?.({ preventScroll: true });
      } else if (step.type === 'password') {
        if (passwordField && result.password) setNativeValue(passwordField, result.password);
        passwordField?.focus?.({ preventScroll: true });
      } else if (step.type === 'totp' && result.totpCode && passwordField) {
        const otpField = findOtpField(passwordField);
        if (otpField) setNativeValue(otpField, result.totpCode);
      } else if (step.type === 'wait') {
        await sleep(step.ms);
      } else if (step.type === 'tab') {
        tabToNext(document.activeElement);
      } else if (step.type === 'enter') {
        if (state.settings?.allowSequenceSubmit !== true) {
          showToast('序列已暂停', '“按 Enter”需要在设置中允许后才会执行');
          break;
        }
        const active = document.activeElement;
        const form = active?.closest?.('form');
        if (form?.requestSubmit) form.requestSubmit();
        else {
          active?.dispatchEvent?.(
            new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }),
          );
        }
      } else if (step.type === 'click' && step.selector) {
        try {
          document.querySelector(step.selector)?.click?.();
        } catch {
          /* invalid or detached selector: skip the step */
        }
      }
    }
  }

  async function fillProfileById(id) {
    const result = await send('SV_GET_PROFILE', { id });
    if (!result.ok) {
      if (isLockedError(result.error)) showLockedHint();
      else showToast(result.error || '资料填充失败');
      return false;
    }
    const profile = result.profile || {};
    const buckets = [
      { value: profile.fullName, keys: ['fullname', 'full-name', 'realname', '真实姓名', '姓名', 'displayname', 'display-name'] },
      { value: profile.email, keys: ['email', 'e-mail', '邮箱', '邮件地址'] },
      { value: profile.phone, keys: ['tel', 'phone', 'mobile', '手机', '电话'] },
      { value: profile.address, keys: ['street-address', 'address', '地址', '详细地址'] },
      { value: profile.company, keys: ['organization', 'company', '公司', '单位'] },
      { value: profile.website, keys: ['website', '网址'] },
    ];
    let filled = 0;
    const candidates = [...collectInputs(document), ...document.querySelectorAll('textarea')];
    for (const input of candidates) {
      if (!isVisible(input) || input.disabled || input.readOnly) continue;
      const type = String(input.type || '').toLowerCase();
      if (['password', 'hidden', 'checkbox', 'radio', 'file', 'submit', 'button', 'image'].includes(type)) continue;
      const hay = [
        input.getAttribute('autocomplete'),
        input.getAttribute('name'),
        input.id,
        input.getAttribute('placeholder'),
        input.getAttribute('aria-label'),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay) continue;
      const bucket = buckets.find((item) => item.value && item.keys.some((key) => hay.includes(key)));
      if (!bucket) continue;
      setNativeValue(input, bucket.value);
      filled += 1;
    }
    for (const field of Array.isArray(profile.fields) ? profile.fields : []) {
      if (!field?.label || !field?.value) continue;
      let element = null;
      try {
        element = document.querySelector(field.label);
      } catch {
        element = null;
      }
      if (element && typeof element.value !== 'undefined') {
        setNativeValue(element, field.value);
        filled += 1;
      }
    }
    if (!filled) {
      showToast('没有找到可填入的资料字段');
      return false;
    }
    showToast(profile.name || '身份资料', '已填入资料');
    return true;
  }

  async function fillById(id, { silent = false } = {}) {
    const passwordField = pickPasswordField();
    const usernameFallback = passwordField
      ? null
      : state.usernameOnly
        ? state.activePassword
        : firstUsernameField();
    if (!passwordField && !usernameFallback) {
      if (!silent) showToast('没有找到可填充的登录框');
      return false;
    }
    const result = await send('SV_FILL', { id });
    if (!result.ok) {
      if (isLockedError(result.error)) showLockedHint();
      else if (!silent) showToast(result.error || '填充失败');
      return false;
    }

    const usernameField = passwordField
      ? findUsernameField(passwordField)
      : usernameFallback || firstUsernameField();
    if (Array.isArray(result.fillSequence) && result.fillSequence.length > 0) {
      await runFillSequence(result, passwordField, usernameField);
      hidePanel();
      hideTrigger();
      if (!silent) showToast(result.username || '当前账号', '已按填充序列执行');
      return true;
    }

    if (!passwordField && usernameFallback) {
      setNativeValue(usernameFallback, result.username);
      usernameFallback.focus({ preventScroll: true });
      hidePanel();
      hideTrigger();
      if (!silent) showToast(result.username || '当前账号', '已填入用户名');
      return true;
    }

    if (usernameField && result.username) setNativeValue(usernameField, result.username);
    if (!result.password) {
      hidePanel();
      hideTrigger();
      if (!silent) showToast(result.username || result.title || '当前账号', '该账号仅保存了 Passkey 记录，请使用系统 Passkey 登录');
      return true;
    }
    setNativeValue(passwordField, result.password);
    let otpFilled = false;
    if (result.totpCode) {
      const otpField = findOtpField(passwordField);
      if (otpField) {
        setNativeValue(otpField, result.totpCode);
        otpFilled = true;
      }
    }
    passwordField.focus({ preventScroll: true });
    hidePanel();
    hideTrigger();
    if (!silent) {
      const account = result.username || result.title || '当前账号';
      const detail = result.title && result.title !== account
        ? `已填入账号 · ${result.title}`
        : '已填入账号';
      showToast(account, otpFilled ? `${detail}和动态码` : detail);
    }
    return true;
  }

  function findOtpField(passwordField) {
    const form = passwordField?.closest?.('form');
    const candidates = form ? collectInputs(form) : collectInputs(document);
    return candidates.find(
      (input) =>
        input instanceof HTMLInputElement &&
        !input.disabled &&
        !input.readOnly &&
        looksLikeOtp(input) &&
        isVisible(input),
    ) || null;
  }

  function pickPasswordField() {
    if (
      state.activePassword &&
      state.activePassword.isConnected &&
      isLoginPasswordField(state.activePassword)
    ) {
      return state.activePassword;
    }
    return firstLoginPasswordField();
  }

  /* ------------------------------------------------------------------ */
  /* UI construction                                                     */
  /* ------------------------------------------------------------------ */

  const KEY_ICON =
    '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M14.5 3a6.5 6.5 0 0 0-6.2 8.5L3 16.8V21h4.2l1.2-1.2v-2.3h2.3l1.2-1.2V15l1.4-.7A6.5 6.5 0 1 0 14.5 3Zm2.4 4.6a1.7 1.7 0 1 1 0 3.4 1.7 1.7 0 0 1 0-3.4Z"/></svg>';

  const CSS = `
    :host { all: initial; pointer-events: none; }
    * { box-sizing: border-box; }
    [hidden] { display: none !important; }
    .sv-layer {
      position: fixed; top: 0; left: 0; width: 0; height: 0; overflow: visible;
      pointer-events: none;
      z-index: 2147483647;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
      color: #0f172a; -webkit-font-smoothing: antialiased;
    }
    button { font-family: inherit; }
    .sv-trigger {
      position: fixed; width: 28px; height: 28px; padding: 6px;
      display: flex; align-items: center; justify-content: center;
      border: 1px solid rgba(255,255,255,.24); border-radius: 9px;
      background: linear-gradient(135deg,#4f46e5,#7c3aed);
      color: #fff; cursor: pointer; pointer-events: auto;
      box-shadow: 0 4px 12px rgba(79,70,229,.38), inset 0 1px 0 rgba(255,255,255,.28);
      transition: transform .12s ease, box-shadow .12s ease;
    }
    .sv-trigger:hover { transform: translateY(-1px) scale(1.04); box-shadow: 0 6px 16px rgba(79,70,229,.48); }
    .sv-trigger:active { transform: scale(.96); }
    .sv-trigger svg { width: 16px; height: 16px; }

    .sv-gen {
      position: fixed; height: 28px; padding: 0 10px 0 8px;
      display: flex; align-items: center; gap: 5px;
      border: 1px solid rgba(79,70,229,.28); border-radius: 9px;
      background: #fff; color: #4338ca; cursor: pointer; pointer-events: auto;
      font-size: 12px; font-weight: 600; line-height: 1; white-space: nowrap;
      box-shadow: 0 4px 14px rgba(15,23,42,.14);
      transition: transform .12s ease, box-shadow .12s ease;
    }
    .sv-gen:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(15,23,42,.18); }
    .sv-gen:active { transform: scale(.97); }
    .sv-gen svg { width: 14px; height: 14px; }
    :host([data-theme="dark"]) .sv-gen { background: #1e293b; color: #c7d2fe; border-color: rgba(129,140,248,.4); }

    .sv-alias {
      position: fixed; height: 28px; padding: 0 10px 0 8px;
      display: flex; align-items: center; gap: 5px;
      border: 1px solid rgba(14,116,144,.26); border-radius: 9px;
      background: #fff; color: #0e7490; cursor: pointer; pointer-events: auto;
      font-size: 12px; font-weight: 600; line-height: 1; white-space: nowrap;
      box-shadow: 0 4px 14px rgba(15,23,42,.14);
      transition: transform .12s ease, box-shadow .12s ease;
    }
    .sv-alias:hover { transform: translateY(-1px); box-shadow: 0 6px 18px rgba(15,23,42,.18); }
    :host([data-theme="dark"]) .sv-alias { background: #0f2a36; color: #67e8f9; border-color: rgba(34,211,238,.4); }
    .sv-alias-panel {
      position: fixed; width: min(292px, calc(100vw - 16px)); max-height: 260px;
      overflow: auto; pointer-events: auto; border-radius: 12px; padding: 8px;
      background: #fff; color: #0f172a; border: 1px solid rgba(15,23,42,.10);
      box-shadow: 0 18px 48px rgba(15,23,42,.20); z-index: 5;
    }
    :host([data-theme="dark"]) .sv-alias-panel { background: #0b1220; color: #e5e7eb; border-color: rgba(148,163,184,.22); }
    .sv-alias-head { font-size: 11px; font-weight: 700; color: #64748b; padding: 4px 6px 8px; }
    .sv-alias-item {
      display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
      width: 100%; padding: 7px 8px; border: 0; border-radius: 8px;
      background: transparent; color: inherit; cursor: pointer; text-align: left;
    }
    .sv-alias-item:hover { background: rgba(99,102,241,.10); }
    .sv-alias-email { font-size: 12px; font-weight: 600; }
    .sv-alias-provider { font-size: 10px; color: #64748b; }

    .sv-panel {
      position: fixed; width: min(324px, calc(100vw - 16px)); max-height: 372px;
      display: flex; flex-direction: column; overflow: hidden;
      pointer-events: auto; border-radius: 14px;
      background: #fff; border: 1px solid rgba(15,23,42,.09);
      box-shadow: 0 20px 55px rgba(15,23,42,.22), 0 2px 8px rgba(15,23,42,.08);
      animation: svPanelIn .14s ease-out;
    }
    @keyframes svPanelIn { from { opacity: 0; transform: translateY(-5px) scale(.985); } to { opacity: 1; transform: none; } }
    .sv-panel-head {
      display: flex; align-items: center; gap: 9px;
      padding: 11px 12px 9px; border-bottom: 1px solid rgba(15,23,42,.07);
    }
    .sv-mini-logo {
      width: 28px; height: 28px; border-radius: 8px; flex: none;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg,#4f46e5,#7c3aed);
      color: #fff; font-size: 13px; font-weight: 800;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.25);
    }
    .sv-head-copy { min-width: 0; flex: 1; }
    .sv-head-title { font-size: 12.5px; font-weight: 650; color: #111827; line-height: 1.3; }
    .sv-head-sub { font-size: 10.5px; color: #64748b; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sv-x {
      width: 24px; height: 24px; border: 0; border-radius: 6px; padding: 0;
      background: transparent; color: #94a3b8; font-size: 17px; line-height: 1;
      cursor: pointer; flex: none;
    }
    .sv-x:hover { background: #f1f5f9; color: #475569; }
    .sv-list { overflow-y: auto; padding: 6px; }
    .sv-empty { padding: 18px 12px; text-align: center; font-size: 12px; color: #94a3b8; }
    .sv-item.is-active { background: rgba(99,102,241,.12); }
    .sv-item {
      width: 100%; display: flex; align-items: center; gap: 10px;
      padding: 8px 9px; border: 0; border-radius: 9px; background: transparent;
      text-align: left; cursor: pointer; color: inherit;
    }
    .sv-item:hover, .sv-item:focus-visible { background: #eef2ff; outline: none; }
    .sv-avatar {
      width: 30px; height: 30px; border-radius: 8px; flex: none;
      display: flex; align-items: center; justify-content: center;
      background: #eef2ff; color: #4f46e5; font-size: 12px; font-weight: 750;
      border: 1px solid #e0e7ff;
    }
    .sv-item-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; }
    .sv-item-title { font-size: 12.5px; font-weight: 600; color: #0f172a; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sv-item-sub { font-size: 10.5px; color: #64748b; margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .sv-fill-hint { font-size: 10.5px; font-weight: 650; color: #4f46e5; opacity: 0; transition: opacity .1s; flex: none; }
    .sv-item:hover .sv-fill-hint { opacity: 1; }
    .sv-panel-foot {
      display: flex; align-items: center; justify-content: space-between; gap: 8px;
      padding: 7px 12px 9px; border-top: 1px solid rgba(15,23,42,.06);
      font-size: 10.5px; color: #94a3b8;
    }
    .sv-link {
      border: 0; background: transparent; padding: 0; cursor: pointer;
      color: #4f46e5; font-size: inherit; font-weight: 600;
    }
    .sv-link:hover { text-decoration: underline; }

    .sv-banner {
      position: fixed; width: min(368px, calc(100vw - 24px));
      max-height: calc(100vh - 24px); overflow-y: auto;
      pointer-events: auto; border-radius: 15px; padding: 13px 14px 12px;
      background: #fff; border: 1px solid rgba(15,23,42,.09);
      box-shadow: 0 22px 60px rgba(15,23,42,.26), 0 2px 8px rgba(15,23,42,.08);
      box-sizing: border-box;
    }
    .sv-banner.pos-top-left { top: 16px; left: 16px; right: auto; bottom: auto; animation: svBannerIn .18s ease-out; }
    .sv-banner.pos-top-right { top: 16px; right: 16px; left: auto; bottom: auto; animation: svBannerIn .18s ease-out; }
    .sv-banner.pos-bottom-left { bottom: 16px; left: 16px; right: auto; top: auto; animation: svBannerIn .18s ease-out; }
    .sv-banner.pos-bottom-right { bottom: 16px; right: 16px; left: auto; top: auto; animation: svBannerIn .18s ease-out; }
    .sv-banner.pos-center {
      top: 50%; left: 50%; right: auto; bottom: auto;
      width: min(460px, calc(100vw - 24px));
      transform: translate(-50%, -50%);
      padding: 18px 18px 16px;
      animation: svBannerCenterIn .18s ease-out;
    }
    .sv-banner.pos-center .sv-banner-kicker { font-size: 11px; }
    .sv-banner.pos-center .sv-banner-title { font-size: 18px; }
    .sv-banner.pos-center .sv-banner-sub { font-size: 12.5px; }
    .sv-banner.pos-center .sv-btn { padding: 7px 15px; font-size: 12.5px; }
    @keyframes svBannerIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
    @keyframes svBannerCenterIn {
      from { opacity: 0; transform: translate(-50%, -46%) scale(.98); }
      to { opacity: 1; transform: translate(-50%, -50%) scale(1); }
    }
    .sv-banner-top { display: flex; align-items: flex-start; gap: 10px; }
    .sv-logo {
      width: 36px; height: 36px; border-radius: 11px; flex: none;
      display: flex; align-items: center; justify-content: center;
      background: linear-gradient(135deg,#4f46e5,#7c3aed);
      color: #fff; font-size: 15px; font-weight: 800;
      box-shadow: inset 0 1px 0 rgba(255,255,255,.26);
    }
    .sv-banner-copy { min-width: 0; flex: 1; padding-top: 1px; }
    .sv-banner-title { font-size: 16px; font-weight: 750; color: #0f172a; line-height: 1.25; }
    .sv-banner-kicker {
      font-size: 10px; font-weight: 700; letter-spacing: .08em;
      text-transform: uppercase; color: #6366f1; margin-bottom: 3px;
    }
    .sv-banner-sub { font-size: 11.5px; color: #64748b; margin-top: 4px; line-height: 1.45; word-break: break-all; }
    .sv-banner-actions { display: flex; align-items: center; gap: 7px; margin-top: 12px; padding-left: 46px; flex-wrap: wrap; }
    .sv-btn {
      border: 0; border-radius: 8px; padding: 6px 13px; font-size: 12px;
      font-weight: 650; cursor: pointer; line-height: 1.35;
    }
    .sv-btn:disabled { opacity: .5; cursor: default; }
    .sv-primary { background: #4f46e5; color: #fff; box-shadow: 0 2px 6px rgba(79,70,229,.28); }
    .sv-primary:hover:not(:disabled) { background: #4338ca; }
    .sv-ghost { background: #f1f5f9; color: #475569; }
    .sv-ghost:hover:not(:disabled) { background: #e2e8f0; }
    .sv-banner-actions .sv-ignore { margin-left: auto; color: #94a3b8; font-weight: 500; }
    .sv-banner-actions .sv-ignore:hover { color: #64748b; }

    .sv-toast {
      position: fixed; max-width: min(460px, calc(100vw - 32px));
      background: rgba(15,23,42,.94); color: #f8fafc;
      font-size: 12px; padding: 10px 14px; border-radius: 12px;
      box-shadow: 0 10px 30px rgba(15,23,42,.28);
      pointer-events: none; line-height: 1.45;
      overflow-wrap: anywhere; text-align: left;
    }
    .sv-toast-title { font-size: 12.5px; font-weight: 700; color: #fff; }
    .sv-toast-detail { font-size: 10.5px; color: rgba(248,250,252,.72); margin-top: 2px; }
    .sv-toast.is-error { background: #b91c1c; }
    .sv-toast.pos-top-left { top: 16px; left: 16px; right: auto; bottom: auto; animation: svToastCornerIn .16s ease-out; }
    .sv-toast.pos-top-right { top: 16px; right: 16px; left: auto; bottom: auto; animation: svToastCornerIn .16s ease-out; }
    .sv-toast.pos-bottom-left { bottom: 16px; left: 16px; right: auto; top: auto; animation: svToastCornerIn .16s ease-out; }
    .sv-toast.pos-bottom-right { bottom: 16px; right: 16px; left: auto; top: auto; animation: svToastCornerIn .16s ease-out; }
    .sv-toast.pos-center {
      top: 50%; left: 50%; right: auto; bottom: auto;
      transform: translate(-50%, -50%);
      max-width: min(460px, calc(100vw - 32px));
      animation: svToastCenterIn .16s ease-out;
    }
    @keyframes svToastCornerIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
    @keyframes svToastCenterIn {
      from { opacity: 0; transform: translate(-50%, -46%); }
      to { opacity: 1; transform: translate(-50%, -50%); }
    }

    @media (prefers-color-scheme: dark) {
      .sv-layer { color: #e2e8f0; }
      .sv-panel, .sv-banner { background: #111827; border-color: rgba(255,255,255,.1); }
      .sv-panel-head, .sv-panel-foot { border-color: rgba(255,255,255,.08); }
      .sv-head-title, .sv-banner-title, .sv-item-title { color: #f1f5f9; }
      .sv-head-sub, .sv-banner-sub, .sv-item-sub, .sv-panel-foot { color: #94a3b8; }
      .sv-x:hover, .sv-ghost { background: rgba(255,255,255,.08); }
      .sv-ghost { color: #cbd5e1; }
      .sv-item:hover, .sv-item:focus-visible { background: rgba(99,102,241,.16); }
      .sv-avatar { background: rgba(99,102,241,.16); border-color: rgba(99,102,241,.3); color: #c7d2fe; }
      .sv-empty { color: #64748b; }
      .sv-fill-hint { color: #a5b4fc; }
    }

    :host([data-theme="dark"]) .sv-layer { color: #e2e8f0; }
    :host([data-theme="dark"]) .sv-panel,
    :host([data-theme="dark"]) .sv-banner { background: #111827; border-color: rgba(255,255,255,.1); }
    :host([data-theme="dark"]) .sv-panel-head,
    :host([data-theme="dark"]) .sv-panel-foot { border-color: rgba(255,255,255,.08); }
    :host([data-theme="dark"]) .sv-head-title,
    :host([data-theme="dark"]) .sv-banner-title,
    :host([data-theme="dark"]) .sv-item-title { color: #f1f5f9; }
    :host([data-theme="dark"]) .sv-head-sub,
    :host([data-theme="dark"]) .sv-banner-sub,
    :host([data-theme="dark"]) .sv-item-sub,
    :host([data-theme="dark"]) .sv-panel-foot { color: #94a3b8; }
    :host([data-theme="dark"]) .sv-x:hover,
    :host([data-theme="dark"]) .sv-ghost { background: rgba(255,255,255,.08); }
    :host([data-theme="dark"]) .sv-ghost { color: #cbd5e1; }
    :host([data-theme="dark"]) .sv-item:hover,
    :host([data-theme="dark"]) .sv-item:focus-visible { background: rgba(99,102,241,.16); }
    :host([data-theme="dark"]) .sv-avatar { background: rgba(99,102,241,.16); border-color: rgba(99,102,241,.3); color: #c7d2fe; }
    :host([data-theme="dark"]) .sv-empty { color: #64748b; }
    :host([data-theme="dark"]) .sv-fill-hint { color: #a5b4fc; }

    :host([data-theme="light"]) .sv-layer { color: #0f172a; }
    :host([data-theme="light"]) .sv-panel,
    :host([data-theme="light"]) .sv-banner { background: #fff; border-color: rgba(15,23,42,.09); }
    :host([data-theme="light"]) .sv-panel-head,
    :host([data-theme="light"]) .sv-panel-foot { border-color: rgba(15,23,42,.06); }
    :host([data-theme="light"]) .sv-head-title,
    :host([data-theme="light"]) .sv-banner-title,
    :host([data-theme="light"]) .sv-item-title { color: #0f172a; }
    :host([data-theme="light"]) .sv-head-sub,
    :host([data-theme="light"]) .sv-banner-sub,
    :host([data-theme="light"]) .sv-item-sub,
    :host([data-theme="light"]) .sv-panel-foot { color: #64748b; }
    :host([data-theme="light"]) .sv-x:hover,
    :host([data-theme="light"]) .sv-ghost { background: #f1f5f9; }
    :host([data-theme="light"]) .sv-ghost { color: #475569; }
    :host([data-theme="light"]) .sv-item:hover,
    :host([data-theme="light"]) .sv-item:focus-visible { background: #f5f3ff; }
    :host([data-theme="light"]) .sv-avatar { background: #eef2ff; border-color: #e0e7ff; color: #4f46e5; }
    :host([data-theme="light"]) .sv-empty { color: #94a3b8; }
    :host([data-theme="light"]) .sv-fill-hint { color: #4f46e5; }

    :host([data-material="glass"]) .sv-panel,
    :host([data-material="glass"]) .sv-banner {
      background: rgba(255,255,255,.72);
      -webkit-backdrop-filter: blur(20px) saturate(160%);
      backdrop-filter: blur(20px) saturate(160%);
      border-color: rgba(255,255,255,.6);
      box-shadow: 0 24px 64px rgba(15,23,42,.22), inset 0 1px 0 rgba(255,255,255,.8);
    }
    :host([data-material="glass"]) .sv-toast {
      background: rgba(15,23,42,.72);
      -webkit-backdrop-filter: blur(18px) saturate(150%);
      backdrop-filter: blur(18px) saturate(150%);
    }
    :host([data-material="liquid"]) .sv-panel,
    :host([data-material="liquid"]) .sv-banner {
      background:
        radial-gradient(120% 85% at 8% 0%, rgba(255,255,255,.92), rgba(255,255,255,.2) 52%, transparent 76%),
        linear-gradient(135deg, rgba(238,242,255,.84), rgba(224,231,255,.66) 38%, rgba(196,181,253,.5));
      -webkit-backdrop-filter: blur(28px) saturate(190%);
      backdrop-filter: blur(28px) saturate(190%);
      border: 1px solid rgba(255,255,255,.72);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,.95),
        inset 0 -1px 0 rgba(99,102,241,.12),
        0 26px 70px rgba(67,56,202,.24);
    }
    :host([data-material="liquid"]) .sv-toast {
      background:
        linear-gradient(135deg, rgba(30,41,59,.86), rgba(49,46,129,.78));
      -webkit-backdrop-filter: blur(22px) saturate(180%);
      backdrop-filter: blur(22px) saturate(180%);
      border: 1px solid rgba(255,255,255,.16);
    }
    :host([data-theme="dark"][data-material="glass"]) .sv-panel,
    :host([data-theme="dark"][data-material="glass"]) .sv-banner {
      background: rgba(17,24,39,.72);
      border-color: rgba(255,255,255,.14);
      box-shadow: 0 24px 64px rgba(0,0,0,.45), inset 0 1px 0 rgba(255,255,255,.12);
    }
    :host([data-theme="dark"][data-material="liquid"]) .sv-panel,
    :host([data-theme="dark"][data-material="liquid"]) .sv-banner {
      background:
        radial-gradient(120% 85% at 8% 0%, rgba(129,140,248,.28), transparent 58%),
        linear-gradient(135deg, rgba(17,24,39,.9), rgba(30,27,75,.78));
      border-color: rgba(165,180,252,.28);
      box-shadow:
        inset 0 1px 0 rgba(255,255,255,.18),
        0 26px 70px rgba(0,0,0,.55);
    }
  `;

  function buildUi() {
    if (rootHost || !document.documentElement) return;
    rootHost = document.createElement('div');
    rootHost.id = 'subvault-ui-root';
    rootHost.style.cssText =
      'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; overflow: visible; z-index: 2147483647; pointer-events: none;';
    // Chrome Web Store builds carry update_url; use a closed shadow root there
    // so page scripts cannot inspect the UI. Unpacked/dev builds stay open so
    // the Playwright E2E suites can drive the same UI.
    const storeBuild = Boolean(chrome.runtime.getManifest()?.update_url);
    shadow = rootHost.attachShadow({ mode: storeBuild ? 'closed' : 'open' });
    shadow.innerHTML = `
      <div class="sv-layer">
        <button class="sv-trigger" type="button" data-subvault-trigger hidden aria-label="用 SubVault 填充密码">${KEY_ICON}</button>
        <button class="sv-gen" type="button" data-subvault-generate hidden aria-label="生成强密码并填入">⚡ 生成强密码</button>
        <button class="sv-alias" type="button" data-subvault-alias hidden aria-label="使用别名邮箱">@ 使用别名</button>
        <div class="sv-alias-panel" data-subvault-alias-panel hidden role="dialog" aria-label="已保存的别名邮箱">
          <div class="sv-alias-head">点击复制别名邮箱（不会自动填入）</div>
          <div class="sv-alias-list"></div>
        </div>
        <section class="sv-panel" id="sv-panel" data-subvault-popover hidden aria-label="SubVault 账号列表">
          <div class="sv-panel-head">
            <div class="sv-mini-logo">S</div>
            <div class="sv-head-copy">
              <div class="sv-head-title">填充登录信息</div>
              <div class="sv-head-sub" data-i18n-raw></div>
            </div>
            <button class="sv-x sv-panel-close" type="button" aria-label="关闭">×</button>
          </div>
          <div class="sv-list" id="sv-list" role="listbox" aria-label="账号列表"></div>
          <div class="sv-panel-foot">
            <span class="sv-mode"></span>
            <button class="sv-link sv-manage" type="button">管理密码库</button>
          </div>
        </section>
        <section class="sv-banner" data-subvault-save-banner hidden aria-live="polite">
          <div class="sv-banner-top">
            <div class="sv-logo sv-banner-logo">S</div>
            <div class="sv-banner-copy">
              <div class="sv-banner-kicker"></div>
              <div class="sv-banner-title" data-i18n-raw></div>
              <div class="sv-banner-sub" data-i18n-raw></div>
            </div>
            <button class="sv-x sv-banner-close" type="button" aria-label="关闭">×</button>
          </div>
          <div class="sv-banner-actions">
            <button class="sv-btn sv-primary sv-save" data-subvault-save type="button">保存</button>
            <button class="sv-btn sv-ghost sv-dismiss" data-subvault-dismiss type="button">暂不</button>
            <button class="sv-link sv-ignore" data-subvault-ignore type="button">此网站不再提示</button>
            <button class="sv-btn sv-primary sv-unlock" type="button" hidden>去解锁</button>
          </div>
        </section>
        <div class="sv-toast" hidden role="status"></div>
      </div>
    `;
    ui = {
      trigger: shadow.querySelector('.sv-trigger'),
      gen: shadow.querySelector('.sv-gen'),
      alias: shadow.querySelector('.sv-alias'),
      aliasPanel: shadow.querySelector('.sv-alias-panel'),
      aliasList: shadow.querySelector('.sv-alias-list'),
      panel: shadow.querySelector('.sv-panel'),
      panelClose: shadow.querySelector('.sv-panel-close'),
      panelSub: shadow.querySelector('.sv-head-sub'),
      list: shadow.querySelector('.sv-list'),
      mode: shadow.querySelector('.sv-mode'),
      manage: shadow.querySelector('.sv-manage'),
      banner: shadow.querySelector('.sv-banner'),
      bannerLogo: shadow.querySelector('.sv-banner-logo'),
      bannerKicker: shadow.querySelector('.sv-banner-kicker'),
      bannerTitle: shadow.querySelector('.sv-banner-title'),
      bannerSub: shadow.querySelector('.sv-banner-sub'),
      bannerClose: shadow.querySelector('.sv-banner-close'),
      save: shadow.querySelector('.sv-save'),
      dismiss: shadow.querySelector('.sv-dismiss'),
      ignore: shadow.querySelector('.sv-ignore'),
      unlock: shadow.querySelector('.sv-unlock'),
      toast: shadow.querySelector('.sv-toast'),
    };
    document.documentElement.appendChild(rootHost);
    installLocalization(shadow);
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(CSS);
      shadow.adoptedStyleSheets = [sheet];
    } catch {
      const style = document.createElement('style');
      style.textContent = CSS;
      shadow.prepend(style);
    }
    state.uiReady = true;
    bindUi();
    applyBannerPosition();
  }

  function ensureUi() {
    if (!document.documentElement) return false;
    if (!rootHost) buildUi();
    else if (rootHost && !rootHost.isConnected) document.documentElement.appendChild(rootHost);
    return Boolean(ui);
  }

  function bindUi() {
    ui.trigger.addEventListener('mousedown', (event) => event.preventDefault());
    ui.trigger.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.panelOpen) hidePanel();
      else void openPanel(state.anchorField || state.activePassword || pickPasswordField());
    });

    ui.gen.addEventListener('mousedown', (event) => event.preventDefault());
    ui.gen.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void generateForSignup();
    });

    ui.alias.addEventListener('mousedown', (event) => event.preventDefault());
    ui.alias.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleAliasPanel();
    });
    ui.aliasList.addEventListener('click', (event) => {
      const item = event.target.closest('.sv-alias-item');
      if (!item) return;
      void copyAlias(item.dataset.email);
    });

    ui.panelClose.addEventListener('click', () => hidePanel());
    ui.manage.addEventListener('click', () => {
      void send('SV_OPEN_OPTIONS');
      hidePanel();
    });

    ui.list.addEventListener('click', (event) => {
      const button = event.target.closest('.sv-item');
      if (!button) return;
      const id = button.dataset.id;
      if (id) void fillById(id);
    });

    ui.save.addEventListener('click', () => void saveCurrentBanner());
    ui.dismiss.addEventListener('click', () => void dismissCurrentBanner());
    ui.ignore.addEventListener('click', () => void ignoreCurrentSite());
    ui.bannerClose.addEventListener('click', () => void dismissCurrentBanner());
    ui.unlock.addEventListener('click', () => {
      void send('SV_OPEN_OPTIONS');
      hideBanner();
    });

    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        hidePanel();
        hideTrigger();
        return;
      }
      if (!state.panelOpen) return;
      const items = [...ui.list.querySelectorAll('.sv-item')];
      if (items.length === 0) return;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.activeIndex = (state.activeIndex + delta + items.length) % items.length;
        setActiveItem(items);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        items[Math.min(state.activeIndex, items.length - 1)]?.click();
      }
    });
  }

  function setActiveItem(items) {
    items.forEach((item, index) => {
      const active = index === state.activeIndex;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', active ? 'true' : 'false');
      item.tabIndex = active ? 0 : -1;
    });
    const current = items[state.activeIndex];
    if (current) {
      current.scrollIntoView({ block: 'nearest' });
      if (state.anchorField?.isConnected) {
        state.anchorField.setAttribute('aria-activedescendant', current.id);
      }
    }
  }

  function panelModeText() {
    if (!state.host) return '';
    return state.isolated ? '独立子域' : '主域共享';
  }

  function renderPanel() {
    if (!ui) return;
    ui.panelSub.textContent = location.host || state.host;
    ui.mode.textContent = panelModeText();
    ui.list.replaceChildren();

    const query = state.search.trim().toLowerCase();
    const matches = query
      ? state.matches.filter((entry) =>
          `${entry.title || ''} ${entry.username || ''} ${entry.aliasEmail || ''} ${entry.host || ''}`
            .toLowerCase()
            .includes(query),
        )
      : state.matches;

    if (matches.length === 0) {
      state.anchorField?.removeAttribute?.('aria-activedescendant');
      const empty = document.createElement('div');
      empty.className = 'sv-empty';
      empty.textContent = query ? '没有匹配的账号' : '当前网站还没有保存的账号';
      ui.list.appendChild(empty);
      return;
    }
    if (state.activeIndex >= matches.length) state.activeIndex = 0;

    let index = 0;
    const created = [];
    for (const entry of matches) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sv-item';
      button.dataset.id = entry.id;
      button.dataset.subvaultAccount = entry.id;
      button.setAttribute('role', 'option');
      button.id = `sv-option-${index}`;
      button.tabIndex = index === state.activeIndex ? 0 : -1;
      button.setAttribute('aria-selected', index === state.activeIndex ? 'true' : 'false');
      if (index === state.activeIndex) button.classList.add('is-active');
      index += 1;

      const avatar = document.createElement('span');
      avatar.className = 'sv-avatar';
      avatar.textContent = (entry.username || entry.title || '?').trim().charAt(0).toUpperCase() || '?';

      const copy = document.createElement('span');
      copy.className = 'sv-item-copy';
      const title = document.createElement('span');
      title.className = 'sv-item-title';
      title.setAttribute('data-i18n-raw', '');
      title.textContent = entry.username || entry.title || entry.host || '未命名账号';
      const sub = document.createElement('span');
      sub.className = 'sv-item-sub';
      sub.setAttribute('data-i18n-raw', '');
      const pieces = [];
      const label = String(entry.title || '').trim();
      if (
        label &&
        label !== title.textContent &&
        label !== entry.host &&
        !/^https?:\/\//i.test(label)
      ) {
        pieces.push(label);
      }
      if (entry.passwordChangedAt) pieces.push(`记录于 ${formatTime(entry.passwordChangedAt)}`);
      sub.textContent = pieces.join(' · ');
      copy.append(title, sub);

      const hint = document.createElement('span');
      hint.className = 'sv-fill-hint';
      hint.textContent = '填充';

      button.append(avatar, copy, hint);
      created.push(button);
      ui.list.appendChild(button);
    }
    setActiveItem(created);
  }

  function openPanel(field) {
    if (!field || !isVisible(field)) return;
    if (!ensureUi()) return;
    state.anchorField = field;
    if (!state.activePassword || !state.activePassword.isConnected) {
      state.activePassword = field;
    }
    state.panelOpen = true;
    state.search = String(field.value || '');
    state.activeIndex = 0;
    ui.panel.hidden = false;
    ui.trigger.hidden = false;
    field.setAttribute('aria-haspopup', 'listbox');
    field.setAttribute('aria-expanded', 'true');
    field.setAttribute('aria-controls', 'sv-panel');
    void getMatches().then(() => {
      if (!state.panelOpen) return;
      renderPanel();
      positionUi();
    });
    renderPanel();
    positionUi();
  }

  function hidePanel() {
    state.panelOpen = false;
    if (ui) ui.panel.hidden = true;
    const anchor = state.anchorField;
    if (anchor && anchor.isConnected) {
      anchor.setAttribute('aria-expanded', 'false');
      anchor.removeAttribute('aria-activedescendant');
    }
  }

  function hideTrigger() {
    if (ui) ui.trigger.hidden = true;
  }

  function showTrigger(field) {
    if (!state.settings.showIcon || state.locked || sitePolicy().hideIcon) {
      hideTrigger();
      return;
    }
    if (!ensureUi() || !field || !isVisible(field)) {
      hideTrigger();
      return;
    }
    state.anchorField = field;
    ui.trigger.hidden = false;
    ui.trigger.title = panelModeText() || 'SubVault';
    positionUi();
  }

  function positionUi() {
    if (!ui || !state.uiReady) return;
    if (repositionFrame) cancelAnimationFrame(repositionFrame);
    repositionFrame = requestAnimationFrame(() => {
      repositionFrame = 0;
      const field =
        state.anchorField?.isConnected
          ? state.anchorField
          : state.genField?.isConnected
            ? state.genField
            : state.activePassword;
      if (!field || !field.isConnected) {
        hideTrigger();
        hidePanel();
        return;
      }
      const rect = field.getBoundingClientRect();
      if (
        rect.width < 12 ||
        rect.height < 8 ||
        rect.bottom < 0 ||
        rect.top > window.innerHeight
      ) {
        // During a window resize the field can briefly report a zero/tiny
        // rect. Keep an already-open panel alive instead of flickering it.
        if (state.panelOpen) return;
        hideTrigger();
        return;
      }
      const focusedInput = activeInputElement() || document.activeElement;
      const focusedResolved = resolveLoginField(focusedInput);
      if (
        state.matches.length > 0 &&
        (state.panelOpen || (focusedResolved && focusedResolved.field === field)) &&
        !state.locked &&
        state.settings.showIcon &&
        !sitePolicy().hideIcon
      ) {
        ui.trigger.hidden = false;
      }
      const triggerSize = 28;
      // Keep the trigger inside the field so it never covers an adjacent
      // submit button. On password fields, leave room for Chrome's native key.
      let left = rect.right - triggerSize - 6;
      if (isPasswordInput(field)) left -= 32;
      if (left < rect.left + 4) left = rect.left + 4;
      let top = rect.top + rect.height / 2 - triggerSize / 2;
      ui.trigger.style.left = `${Math.round(clamp(left, 4, window.innerWidth - triggerSize - 4))}px`;
      ui.trigger.style.top = `${Math.round(clamp(top, 4, window.innerHeight - triggerSize - 4))}px`;

      if (ui.gen && !ui.gen.hidden && state.genField?.isConnected) {
        const genRect = state.genField.getBoundingClientRect();
        const genWidth = ui.gen.offsetWidth || 108;
        const genHeight = ui.gen.offsetHeight || 28;
        let genLeft = genRect.right + 6;
        if (genLeft + genWidth > window.innerWidth - 6) {
          genLeft = genRect.right - genWidth - 6;
        }
        const genTop = genRect.top + genRect.height / 2 - genHeight / 2;
        ui.gen.style.left = `${Math.round(clamp(genLeft, 4, window.innerWidth - genWidth - 4))}px`;
        ui.gen.style.top = `${Math.round(clamp(genTop, 4, window.innerHeight - genHeight - 4))}px`;
      }

      if (ui.alias && !ui.alias.hidden && state.genField?.isConnected) {
        const fieldRect = state.genField.getBoundingClientRect();
        const aliasWidth = ui.alias.offsetWidth || 92;
        const aliasHeight = ui.alias.offsetHeight || 28;
        const genWidth = ui.gen?.hidden ? 0 : (ui.gen.offsetWidth || 108) + 6;
        // Keep the alias chip outside the password field. It used to sit
        // inside the field and intercepted clicks/focus on the right edge.
        let aliasLeft = fieldRect.right + 8 + genWidth;
        if (aliasLeft + aliasWidth > window.innerWidth - 4) {
          aliasLeft = fieldRect.left - aliasWidth - 8;
        }
        const aliasTop = fieldRect.top + fieldRect.height / 2 - aliasHeight / 2;
        ui.alias.style.left = `${Math.round(clamp(aliasLeft, 4, window.innerWidth - aliasWidth - 4))}px`;
        ui.alias.style.top = `${Math.round(clamp(aliasTop, 4, window.innerHeight - aliasHeight - 4))}px`;
      }
      if (ui.aliasPanel && !ui.aliasPanel.hidden && state.genField?.isConnected) {
        const fieldRect = state.genField.getBoundingClientRect();
        const panelWidth = ui.aliasPanel.offsetWidth || 292;
        const panelHeight = ui.aliasPanel.offsetHeight || 180;
        let panelLeft = fieldRect.right - panelWidth;
        if (panelLeft < 8) panelLeft = fieldRect.left;
        let panelTop = fieldRect.bottom + 8;
        if (panelTop + panelHeight > window.innerHeight - 8) panelTop = fieldRect.top - panelHeight - 8;
        ui.aliasPanel.style.left = `${Math.round(clamp(panelLeft, 8, window.innerWidth - panelWidth - 8))}px`;
        ui.aliasPanel.style.top = `${Math.round(clamp(panelTop, 8, window.innerHeight - panelHeight - 8))}px`;
      }

      if (!state.panelOpen) return;
      const panelWidth = 324;
      const panelHeight = Math.min(372, ui.panel.offsetHeight || 320);
      let panelLeft = clamp(rect.left, 8, window.innerWidth - panelWidth - 8);
      let panelTop = rect.bottom + 8;
      if (panelTop + panelHeight > window.innerHeight - 8) {
        panelTop = Math.max(8, rect.top - panelHeight - 8);
      }
      ui.panel.style.left = `${Math.round(panelLeft)}px`;
      ui.panel.style.top = `${Math.round(panelTop)}px`;
    });
  }

  function showToast(title, detail = '', { error = false } = {}) {
    if (!ensureUi()) return;
    applyBannerPosition();
    ui.toast.replaceChildren();
    const titleText = String(title || '').trim();
    const detailText = String(detail || '').trim();
    const titleElement = document.createElement('div');
    titleElement.className = 'sv-toast-title';
    titleElement.setAttribute('data-i18n-raw', '');
    titleElement.textContent = titleText || detailText || tr('操作完成');
    ui.toast.appendChild(titleElement);
    if (titleText && detailText) {
      const detailElement = document.createElement('div');
      detailElement.className = 'sv-toast-detail';
      detailElement.setAttribute('data-i18n-raw', '');
      detailElement.textContent = detailText;
      ui.toast.appendChild(detailElement);
    }
    ui.toast.setAttribute('role', 'status');
    ui.toast.setAttribute('aria-live', 'polite');
    ui.toast.setAttribute('aria-atomic', 'true');
    ui.toast.classList.toggle('is-error', error);
    ui.toast.hidden = false;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      if (ui) ui.toast.hidden = true;
    }, 2800);
  }

  /* ------------------------------------------------------------------ */
  /* Save banner                                                         */
  /* ------------------------------------------------------------------ */

  function applyBannerPosition() {
    if (!ui?.banner) return;
    const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'];
    const position = positions.includes(state.settings.savePromptPosition)
      ? state.settings.savePromptPosition
      : 'top-right';
    for (const name of positions) {
      ui.banner.classList.remove(`pos-${name}`);
      ui.toast?.classList.remove(`pos-${name}`);
    }
    ui.banner.classList.add(`pos-${position}`);
    ui.toast?.classList.add(`pos-${position}`);

    const theme = ['system', 'light', 'dark'].includes(state.settings.theme)
      ? state.settings.theme
      : 'system';
    if (theme === 'system') delete rootHost.dataset.theme;
    else rootHost.dataset.theme = theme;

    const material = ['solid', 'glass', 'liquid'].includes(state.settings.material)
      ? state.settings.material
      : 'solid';
    rootHost.dataset.material = material;
  }

  function hideBanner() {
    state.banner = null;
    if (ui) {
      ui.banner.hidden = true;
      ui.save.disabled = false;
      ui.dismiss.disabled = false;
      ui.ignore.disabled = false;
    }
  }

  function showSaveBanner(pending) {
    if (!isTopFrame) return;
    if (!ensureUi() || !pending?.id) return;
    if (state.banner?.id === pending.id) return;
    applyBannerPosition();
    ui.banner.hidden = false;
    try {
      state.banner = { ...pending, mode: 'save' };
      const username = pending.username || '无用户名';
      const action = pending.existing ? '更新登录密码' : '保存新账号';
      ui.bannerKicker.textContent = action;
      ui.bannerTitle.textContent = username;
      ui.bannerLogo.textContent = username.trim().charAt(0).toUpperCase() || 'S';
      const pieces = [pending.host];
      if (pending.createdAt) pieces.push(`记录于 ${formatTime(pending.createdAt)}`);
      ui.bannerSub.textContent = pieces.filter(Boolean).join(' · ');
      ui.save.textContent = pending.existing ? '更新账号' : '保存账号';
      ui.save.hidden = false;
      ui.dismiss.hidden = false;
      ui.ignore.hidden = false;
      ui.unlock.hidden = true;
      ui.save.disabled = false;
      ui.dismiss.disabled = false;
      ui.ignore.disabled = false;
    } catch (error) {
      console.error('[SubVault] showSaveBanner failed', error);
    }
  }

  function showLockedHint({ initialized = true } = {}) {
    if (!isTopFrame) return;
    if (!state.settings.savePrompt || sitePolicy().disableSavePrompt) return;
    if (state.lockedHintShown) return;
    if (!ensureUi()) return;
    applyBannerPosition();
    state.lockedHintShown = true;
    state.banner = { mode: 'locked' };
    ui.bannerKicker.textContent = initialized ? '密码库已锁定' : '还没有密码库';
    ui.bannerTitle.textContent = state.host || '当前网站';
    ui.bannerLogo.textContent = (state.host || 'S').trim().charAt(0).toUpperCase() || 'S';
    ui.bannerSub.textContent = initialized
      ? `本次登录信息未保存。解锁后即可使用 SubVault 管理 ${state.host} 的密码。`
      : '创建本地加密密码库后，登录信息才会被安全保存。';
    ui.save.hidden = true;
    ui.dismiss.hidden = true;
    ui.ignore.hidden = true;
    ui.unlock.hidden = false;
    ui.unlock.textContent = initialized ? '去解锁' : '创建密码库';
    ui.banner.hidden = false;
  }

  async function saveCurrentBanner() {
    if (!state.banner?.id) return;
    ui.save.disabled = true;
    ui.dismiss.disabled = true;
    ui.ignore.disabled = true;
    const result = await send('SV_SAVE_PENDING', { id: state.banner.id });
    if (!result.ok) {
      ui.save.disabled = false;
      ui.dismiss.disabled = false;
      ui.ignore.disabled = false;
      if (isLockedError(result.error)) showLockedHint();
      else showToast(result.error || '保存失败');
      return;
    }
    const savedBanner = { ...(state.banner || {}) };
    hideBanner();
    const account = savedBanner.username || '当前账号';
    const action = result.updated ? '更新' : '新增';
    showToast(account, `已${action}账号 · ${savedBanner.host || state.host}`);
    state.matchesAt = 0;
    void getMatches(true);
    showNextPending();
  }

  async function dismissCurrentBanner() {
    if (!state.banner?.id) {
      hideBanner();
      return;
    }
    const id = state.banner.id;
    hideBanner();
    await send('SV_DISMISS_PENDING', { id });
    showNextPending();
  }

  async function ignoreCurrentSite() {
    if (!state.host) return;
    hideBanner();
    const result = await send('SV_IGNORE_SITE', { host: state.host });
    if (result.ok) showToast('此网站将不再提示保存');
  }

  function showNextPending() {
    const next = state.pendingQueue.shift();
    if (next) showSaveBanner(next);
  }

  async function initPending() {
    if (!isTopFrame || !state.settings.savePrompt) return;
    const result = await send('SV_GET_PENDING');
    if (!result.ok || result.locked) return;
    const pending = Array.isArray(result.pending) ? result.pending : [];
    if (pending.length === 0) return;
    state.pendingQueue = pending.slice(1);
    if (!state.banner) showSaveBanner(pending[0]);
  }

  async function offerSave(username, password) {
    if (!state.settings.savePrompt || sitePolicy().disableSavePrompt || !password) return;
    const result = await send('SV_CHECK_SAVE', { username, password });
    if (!result.ok) {
      if (isLockedError(result.error)) {
        const status = await send('SV_GET_STATUS');
        showLockedHint({ initialized: Boolean(status.initialized) });
      }
      return;
    }
    if (result.locked) {
      const status = await send('SV_GET_STATUS');
      showLockedHint({ initialized: Boolean(status.initialized) });
      return;
    }
    if (!result.offer) return;
    if (!isTopFrame) return;
    showSaveBanner({
      id: result.id,
      host: state.host,
      username,
      existing: Boolean(result.existing),
      createdAt: Date.now(),
    });
  }

  /* ------------------------------------------------------------------ */
  /* Capture / autofill                                                  */
  /* ------------------------------------------------------------------ */

  function captureCredentials(passwordField, { signup = false } = {}) {
    if (signup) {
      if (!isSignupPasswordField(passwordField)) return;
    } else if (!isLoginPasswordField(passwordField)) {
      return;
    }
    const password = passwordField.value;
    if (!password || password.length > 4096) return;
    const usernameField = findUsernameField(passwordField);
    const username = usernameField ? usernameField.value.trim().slice(0, 320) : '';
    const signature = `${state.host}\u0000${username}\u0000${password.length}`;
    const now = Date.now();
    if (signature === state.lastSignature && now - state.lastCaptureAt < 4000) return;
    state.lastSignature = signature;
    state.lastCaptureAt = now;
    void offerSave(username, password);
  }

  /* ------------------------------------------------------------------ */
  /* Registration guidance                                               */
  /* ------------------------------------------------------------------ */

  function isSignupPasswordField(input) {
    if (!isPasswordInput(input) || !isVisible(input)) return false;
    if (input.disabled || input.readOnly) return false;
    if (looksLikeNewPassword(input)) return true;
    const form = formOf(input);
    if (form === document) return false;
    if (signsUpForm(form)) return true;
    return visiblePasswordFields(form).length > 1;
  }

  function firstSignupPasswordField() {
    return collectInputs(document).find((input) => isSignupPasswordField(input)) || null;
  }

  function showGenChip(field) {
    if (
      !field ||
      state.locked ||
      !state.settings.showIcon ||
      sitePolicy().hideIcon ||
      !isSignupPasswordField(field)
    ) {
      hideGenChip();
      return;
    }
    if (!ensureUi() || !isVisible(field)) {
      hideGenChip();
      return;
    }
    state.genField = field;
    state.anchorField = field;
    ui.gen.hidden = false;
    if (ui.alias) ui.alias.hidden = false;
    positionUi();
  }

  function hideGenChip() {
    if (state.anchorField && state.anchorField === state.genField) {
      state.anchorField = null;
    }
    state.genField = null;
    if (ui?.gen) ui.gen.hidden = true;
    if (ui?.alias) ui.alias.hidden = true;
    hideAliasPanel();
  }

  function hideAliasPanel() {
    if (ui?.aliasPanel) ui.aliasPanel.hidden = true;
  }

  async function toggleAliasPanel() {
    if (!state.genField || state.locked) return;
    if (ui.aliasPanel && !ui.aliasPanel.hidden) {
      hideAliasPanel();
      return;
    }
    const result = await send('SV_GET_ALIASES');
    if (!result.ok) {
      showToast(result.error || '无法读取别名', '', { error: true });
      return;
    }
    const aliases = Array.isArray(result.aliases) ? result.aliases : [];
    if (!aliases.length) {
      showToast('还没有保存的别名', '在账号条目中填写“注册邮箱/别名”后即可使用');
      return;
    }
    ui.aliasList.replaceChildren();
    for (const alias of aliases) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'sv-alias-item';
      button.dataset.email = alias.email;
      const email = document.createElement('span');
      email.className = 'sv-alias-email';
      email.textContent = alias.email;
      const meta = document.createElement('span');
      meta.className = 'sv-alias-provider';
      meta.textContent = [alias.provider, alias.host].filter(Boolean).join(' · ') || '已保存别名';
      button.append(email, meta);
      ui.aliasList.appendChild(button);
    }
    ui.aliasPanel.hidden = false;
    positionUi();
  }

  async function copyAlias(value) {
    const text = String(value || '');
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const helper = document.createElement('textarea');
      helper.value = text;
      helper.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
      document.documentElement.appendChild(helper);
      helper.select();
      document.execCommand('copy');
      helper.remove();
    }
    showToast('已复制别名邮箱', text);
    hideAliasPanel();
  }

  async function generateForSignup() {
    const field = state.genField;
    if (!field || !field.isConnected) {
      hideGenChip();
      return;
    }
    if (state.locked) {
      showLockedHint();
      return;
    }
    const result = await send('SV_GENERATE_PASSWORD', { options: { length: 20 } });
    if (!result.ok || !result.password) {
      showToast(result.error || '无法生成密码', '', { error: true });
      return;
    }
    if (state.locked || !field.isConnected) return;
    const value = String(result.password);
    setNativeValue(field, value);
    const form = formOf(field);
    for (const sibling of collectInputs(form)) {
      if (sibling === field || !isPasswordInput(sibling) || !isVisible(sibling)) continue;
      if (sibling.disabled || sibling.readOnly) continue;
      if (isSignupPasswordField(sibling)) setNativeValue(sibling, value);
    }
    state.lastCaptureAt = 0;
    showToast('已生成强密码', '请在完成注册后保存到 SubVault');
  }

  function onSubmitClick(event) {
    // Only a real pointer click should offer saving. Browsers synthesize a
    // click with detail=0 for Enter/implicit form submission; that must not
    // create a save prompt.
    if (!event.isTrusted || event.detail === 0) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (event.composedPath().includes(rootHost)) return;

    const normalize = (value) =>
      String(value || '')
        .replace(/[\s\u200B-\u200D\uFEFF]+/g, '')
        .slice(0, 80);
    const isExcluded = (label) =>
      /logout|signout|退出|忘记|forgot/i.test(label);
    const isLoginLabel = (label) =>
      /login|signin|continue|next|submit|登录|登入|下一步|继续|提交/i.test(label);
    const isSignupLabel = (label) =>
      /signup|sign.?up|register|createaccount|创建账号|创建账户|注册/i.test(label);

    let control = target.closest(
      'button, input[type="submit"], input[type="image"], input[type="button"], [role="button"], a',
    );
    let label = normalize(
      control?.innerText ||
        control?.textContent ||
        control?.value ||
        control?.getAttribute('aria-label') ||
        control?.getAttribute('title') ||
        '',
    );

    // Many SPA login pages use a plain <div>/<span> with a click handler.
    if (!control) {
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLLabelElement ||
        target instanceof HTMLFormElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement
      ) {
        return;
      }
      let element = target;
      for (let depth = 0; depth < 5 && element && element !== document.body; depth += 1) {
        const text = normalize(element.innerText || element.textContent);
        if (
          text &&
          (isLoginLabel(text) || isSignupLabel(text)) &&
          !isExcluded(text) &&
          element instanceof HTMLElement &&
          !['FORM', 'LABEL', 'INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)
        ) {
          const style = getComputedStyle(element);
          const exactLogin =
            /^(登录|登入|下一步|继续|提交|注册|login|signin|continue|next|signup|register)$/i.test(
              text,
            );
          const isClickable =
            element.matches('[role="button"], [onclick], [tabindex]') ||
            style.cursor === 'pointer' ||
            (['SPAN', 'DIV', 'BUTTON'].includes(element.tagName) && exactLogin);
          if (isClickable) {
            control = element;
            label = text;
            break;
          }
        }
        element = element.parentElement;
      }
    }
    if (!(control instanceof HTMLElement)) return;
    if (isExcluded(label)) return;

    const isSubmit =
      (control instanceof HTMLButtonElement && control.type === 'submit') ||
      (control instanceof HTMLInputElement && ['submit', 'image'].includes(control.type)) ||
      (control instanceof HTMLButtonElement && !control.hasAttribute('type'));
    if (!isSubmit && !isLoginLabel(label) && !isSignupLabel(label)) return;

    const form = control.closest('form');
    const signup =
      isSignupLabel(label) || (form instanceof HTMLFormElement && signsUpForm(form));
    if (signup) {
      const password = form
        ? collectInputs(form).find((input) => isSignupPasswordField(input))
        : firstSignupPasswordField();
      if (password) captureCredentials(password, { signup: true });
      return;
    }

    const password = form
      ? collectInputs(form).find(
          (input) => isPasswordInput(input) && isLoginPasswordField(input),
        )
      : firstLoginPasswordField();
    if (!password) return;
    captureCredentials(password);
  }

  function onKeyDown(event) {
    if (event.key === 'Escape' && ui?.aliasPanel && !ui.aliasPanel.hidden) {
      hideAliasPanel();
      return;
    }
    if (state.panelOpen && !event.composedPath().includes(rootHost)) {
      if (event.key === 'Escape') {
        event.preventDefault();
        hidePanel();
        return;
      }
      const items = [...(ui?.list.querySelectorAll('.sv-item') || [])];
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        if (items.length === 0) return;
        event.preventDefault();
        const delta = event.key === 'ArrowDown' ? 1 : -1;
        state.activeIndex = (state.activeIndex + delta + items.length) % items.length;
        setActiveItem(items);
        return;
      }
      if (event.key === 'Enter' && items.length > 0) {
        event.preventDefault();
        items[Math.min(state.activeIndex, items.length - 1)]?.click();
        return;
      }
    }
    if (state.panelOpen || event.key !== 'Enter' || !event.isTrusted) return;
    const target = event
      .composedPath()
      .find((node) => node instanceof HTMLInputElement);
    if (!target || !isPasswordInput(target)) return;
    if (isSignupPasswordField(target)) {
      captureCredentials(target, { signup: true });
      return;
    }
    if (!isLoginPasswordField(target)) return;
    captureCredentials(target);
  }

  function onAnchorInput(event) {
    if (!state.panelOpen) return;
    const input = eventInput(event);
    if (input !== state.anchorField) return;
    state.search = input.value;
    state.activeIndex = 0;
    renderPanel();
    positionUi();
  }

  function eventInput(event) {
    return (
      event.composedPath().find((node) => node instanceof HTMLInputElement) ||
      (event.target instanceof HTMLInputElement ? event.target : null)
    );
  }

  function activeInputElement() {
    let active = document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active instanceof HTMLInputElement) return active;
    if (shadow?.activeElement instanceof HTMLInputElement) return shadow.activeElement;
    return null;
  }

  function resolveLoginField(input) {
    if (!(input instanceof HTMLInputElement)) return null;
    // The account field is the single entry point for the picker. Password
    // fields intentionally do not show a trigger; choosing an account from the
    // username field fills both username and password.
    if (isPasswordInput(input)) return null;
    if (isUsernameCandidate(input)) {
      const passwordField = findPasswordForUsername(input);
      return passwordField
        ? { anchor: input, field: passwordField, usernameOnly: false }
        : { anchor: input, field: input, usernameOnly: true };
    }
    return null;
  }

  function activateField(anchor, field = anchor, usernameOnly = false, autoOpen = false) {
    if (!anchor || !anchor.isConnected || !isVisible(anchor)) return;
    if (!autoOpen && state.anchorField === anchor && ui?.trigger && !ui.trigger.hidden) return;
    state.anchorField = anchor;
    state.activePassword = field || anchor;
    state.usernameOnly = usernameOnly;
    void getMatches().then((matches) => {
      if (state.anchorField !== anchor || !anchor.isConnected) return;
      if (matches.length === 0) {
        hideTrigger();
        return;
      }
      showTrigger(anchor);
      if (
        autoOpen &&
        state.settings.autoOpenOnFocus &&
        !state.panelOpen &&
        !state.autoOpened.has(anchor)
      ) {
        state.autoOpened.add(anchor);
        openPanel(anchor);
      }
    });
  }

  function onFocusIn(event) {
    if (!(event.target instanceof Element)) return;
    syncHost();
    if (event.composedPath().includes(rootHost)) return;

    const target = eventInput(event);
    if (target && isPasswordInput(target) && isSignupPasswordField(target)) {
      hidePanel();
      showGenChip(target);
      return;
    }
    hideGenChip();
    const resolved = resolveLoginField(target);
    if (!resolved) {
      hideTrigger();
      hidePanel();
      return;
    }

    activateField(resolved.anchor, resolved.field, resolved.usernameOnly, true);
    if (!resolved.usernameOnly) {
      setTimeout(() => {
        if (resolved.field.isConnected) {
          void maybeClearNativeAutofill(resolved.field, {
            announce: true,
            allowFocused: true,
          });
        }
      }, 320);
    }
  }

  function onFocusOut() {
    setTimeout(() => {
      if (!ui) return;
      if (shadow.activeElement) return;
      if (state.panelOpen) return;
      const focused = activeInputElement() || document.activeElement;
      const onSignupPassword =
        focused instanceof HTMLInputElement && isSignupPasswordField(focused);
      if (!onSignupPassword) hideGenChip();
      if (resolveLoginField(focused)) return;
      state.autoOpened = new WeakSet();
      hideTrigger();
      if (!onSignupPassword) hideGenChip();
    }, 200);
  }

  function onDocumentClick(event) {
    if (!ui) return;
    const path = event.composedPath();
    if (path.includes(rootHost)) return;

    const label = path.find((node) => node instanceof HTMLLabelElement);
    const input = eventInput(event) || label?.control;
    const resolved = resolveLoginField(input);
    if (resolved) {
      activateField(resolved.anchor, resolved.field, resolved.usernameOnly, true);
      return;
    }

    const activeInput = activeInputElement();
    const activeResolved = resolveLoginField(activeInput);
    if (activeResolved) {
      activateField(activeResolved.anchor, activeResolved.field, activeResolved.usernameOnly, true);
      return;
    }

    hidePanel();
    hideTrigger();
  }

  function onFieldPointer(event) {
    if (!ui) return;
    const path = event.composedPath();
    if (path.includes(rootHost)) return;
    const input = eventInput(event);
    const resolved = resolveLoginField(input);
    if (!resolved) return;
    activateField(resolved.anchor, resolved.field, resolved.usernameOnly);
  }

  async function tryAutoFill() {
    if (!state.settings.autoFill || state.locked) return;
    const passwordField = firstLoginPasswordField();
    if (!passwordField || passwordField.value) return;
    const usernameField = findUsernameField(passwordField);
    if (usernameField && usernameField.value.trim()) return;
    const matches = await getMatches(true);
    if (matches.length !== 1) return;
    await fillById(matches[0].id, { silent: true });
    showToast(matches[0].username || matches[0].title || '当前账号', '已自动填入账号');
  }

  async function handleShortcut() {
    if (!ensureUi()) return;
    const passwordField = pickPasswordField();
    const usernameField = passwordField ? null : firstUsernameField();
    if (!passwordField && !usernameField) {
      showToast('没有找到可填写的登录框');
      return;
    }
    state.activePassword = passwordField || usernameField;
    state.usernameOnly = !passwordField;
    const matches = await getMatches(true);
    if (matches.length === 0) {
      showToast(state.locked ? '请先解锁 SubVault' : '当前网站还没有保存的账号');
      return;
    }
    if (matches.length === 1) {
      await fillById(matches[0].id);
      return;
    }
    openPanel(state.activePassword);
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  function installObserver() {
    if (!document.documentElement) return;
    observer = new MutationObserver((records) => {
      let touched = false;
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches?.('input') || node.querySelector?.('input')) {
            touched = true;
            break;
          }
        }
        if (touched) break;
      }
      if (!touched) return;
      clearTimeout(markTimer);
      markTimer = setTimeout(() => {
        applyTakeoverMarking();
        for (const password of collectInputs(document)) {
          if (isPasswordInput(password)) void maybeClearNativeAutofill(password);
        }
      }, 350);
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
  }

  function installDocumentListeners() {
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    document.addEventListener('input', onAnchorInput, true);
    document.addEventListener('click', onSubmitClick, true);
    document.addEventListener('click', onDocumentClick, true);
    document.addEventListener('pointerover', onFieldPointer, true);
    document.addEventListener('pointerdown', onFieldPointer, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', positionUi, true);
    window.addEventListener('resize', positionUi);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') {
        hidePanel();
        hideTrigger();
      }
    });
  }

  function onDomReady() {
    getSettings().then(() => {
      applyBannerPosition();
      applyTakeoverMarking();
      scheduleNativeChecks();
      if (state.settings.autoFill) setTimeout(() => void tryAutoFill(), 700);
    });
    buildUi();
    installDocumentListeners();
    installObserver();
    installNativeAutofillHooks();
    setTimeout(() => void initPending(), 550);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    state.settings = { ...DEFAULTS, ...(changes.settings.newValue || {}) };
    state.settingsLoaded = true;
    state.settingsVersion += 1;
    applyUiLanguage(state.settings.uiLanguage);
    applyBannerPosition();
    if (!state.settings.showIcon) {
      hideTrigger();
      hideGenChip();
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.type !== 'string') return undefined;
    if (message.type === 'SV_FILL_BY_ID') {
      fillById(message.id).then((ok) => sendResponse({ ok }));
      return true;
    }
    if (message.type === 'SV_FILL_PROFILE_BY_ID') {
      fillProfileById(message.id).then((ok) => sendResponse({ ok }));
      return true;
    }
    if (message.type === 'SV_FILL_SHORTCUT') {
      void handleShortcut();
      sendResponse({ ok: true });
      return undefined;
    }
    if (message.type === 'SV_SETTINGS_CHANGED') {
      state.settings = { ...DEFAULTS, ...(message.settings || {}) };
      state.settingsLoaded = true;
      state.settingsVersion += 1;
      applyUiLanguage(state.settings.uiLanguage);
      applyBannerPosition();
      if (!state.settings.showIcon) {
        hideTrigger();
        hideGenChip();
      }
      return undefined;
    }
    if (message.type === 'SV_TRAVEL_CHANGED') {
      state.matches = [];
      state.matchesAt = 0;
      state.matchesHost = '';
      hidePanel();
      hideTrigger();
      hideGenChip();
      if (!state.locked && isTopFrame) {
        const active = activeInputElement();
        const resolved = resolveLoginField(active);
        if (resolved) activateField(resolved.anchor, resolved.field, resolved.usernameOnly);
        void initPending();
      }
      return undefined;
    }
    if (message.type === 'SV_UNLOCKED') {
      // No page reload should be needed: refresh the session view immediately.
      state.locked = false;
      state.matches = [];
      state.matchesAt = 0;
      state.matchesHost = '';
      state.lockedHintShown = false;
      if (isTopFrame) {
        applyTakeoverMarking();
        scheduleNativeChecks();
        void initPending();
        const active = activeInputElement();
        let resolved = resolveLoginField(active);
        if (!resolved && state.anchorField?.isConnected && isVisible(state.anchorField)) {
          resolved = resolveLoginField(state.anchorField);
        }
        if (resolved) {
          activateField(resolved.anchor, resolved.field, resolved.usernameOnly);
        }
      }
      return undefined;
    }
    if (message.type === 'SV_LOCKED') {
      state.locked = true;
      state.matches = [];
      state.matchesHost = '';
      hidePanel();
      hideTrigger();
      hideGenChip();
      hideBanner();
      return undefined;
    }
    if (message.type === 'SV_PENDING_AVAILABLE') {
      if (isTopFrame && message.pending) showSaveBanner(message.pending);
      return undefined;
    }
    return undefined;
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onDomReady, { once: true });
  } else {
    onDomReady();
  }

  installNativeAutofillHooks();
  void getSettings();
})();
