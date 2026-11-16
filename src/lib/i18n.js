// Lightweight UI localization.
//
// Chinese is the source language of this project. When the effective UI
// language is English we translate rendered text nodes and common attributes
// against a bundled dictionary (src/lib/i18n-en.js). Unknown strings fall back
// to Chinese instead of showing a broken key, and user data (account
// titles/usernames) is never rewritten because it will not match a dictionary
// key exactly.
//
// Original Chinese values are cached per text node/attribute so switching the
// in-extension language back to Chinese can restore the UI without a reload.
import { EN } from './i18n-en.js';

let cachedLocale = null;
let languageOverride = null;
const textOriginals = new WeakMap();
const attributeOriginals = new WeakMap();

function detectLocale() {
  let language = '';
  try {
    language = String(chrome?.i18n?.getUILanguage?.() || '');
  } catch {
    language = '';
  }
  if (!language) {
    try {
      language = String(globalThis.navigator?.language || '');
    } catch {
      language = '';
    }
  }
  return language.toLowerCase().startsWith('zh') ? 'zh' : 'en';
}

/** @returns {'zh'|'en'} */
export function uiLocale() {
  if (cachedLocale) return cachedLocale;
  cachedLocale = languageOverride || detectLocale();
  return cachedLocale;
}

/**
 * Select the effective UI language before rendering.
 * @param {'auto'|'zh-CN'|'zh'|'en'} preference
 * @returns {'zh'|'en'}
 */
export function setUiLanguage(preference) {
  if (preference === 'zh-CN' || preference === 'zh') languageOverride = 'zh';
  else if (preference === 'en') languageOverride = 'en';
  else languageOverride = null;
  cachedLocale = languageOverride || detectLocale();
  return cachedLocale;
}

export function isEnglish() {
  return uiLocale() === 'en';
}

/** Locale tag for dates, numbers and exported file names. */
export function formatLocale() {
  return isEnglish() ? 'en-US' : 'zh-CN';
}

/**
 * Translate one complete string. Returns the input unchanged for Chinese mode
 * or when no translation is known.
 * @param {string} text
 */
export function tr(text) {
  if (!isEnglish() || typeof text !== 'string') return text;
  const key = text.trim();
  const hit = EN[key];
  if (!hit) return text;
  return text.replace(key, hit);
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'CODE', 'PRE']);

function shouldSkipElement(element) {
  if (!element || element.nodeType !== 1) return false;
  if (SKIP_TAGS.has(element.tagName)) return true;
  if (element.closest?.('[data-i18n-raw], [contenteditable="true"]')) return true;
  return false;
}

function translateTextNode(node) {
  const current = node.nodeValue;
  if (!current) return;
  if (shouldSkipElement(node.parentElement)) return;
  const original = textOriginals.get(node) ?? current;
  if (!/[\u4e00-\u9fff]/.test(original)) return;
  const key = original.trim();
  const hit = EN[key];
  if (!hit) return;
  if (!textOriginals.has(node)) textOriginals.set(node, current);
  const next = original.replace(key, hit);
  if (next !== current) node.nodeValue = next;
}

function restoreTextNode(node) {
  const original = textOriginals.get(node);
  if (original != null && node.nodeValue !== original) node.nodeValue = original;
}

const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];

function eachAttribute(root, callback) {
  const selector = ATTRS.map((attr) => `[${attr}]`).join(',');
  let elements;
  try {
    elements = root.querySelectorAll(selector);
  } catch {
    return;
  }
  for (const element of elements) {
    for (const attr of ATTRS) {
      const value = element.getAttribute?.(attr);
      if (value == null) continue;
      callback(element, attr, value);
    }
  }
}

function translateAttributes(root) {
  eachAttribute(root, (element, attr, current) => {
    if (!/[\u4e00-\u9fff]/.test(current)) return;
    let originals = attributeOriginals.get(element);
    if (!originals) {
      originals = Object.create(null);
      attributeOriginals.set(element, originals);
    }
    const original = originals[attr] ?? current;
    if (!/[\u4e00-\u9fff]/.test(original)) return;
    const key = original.trim();
    const hit = EN[key];
    if (!hit) return;
    if (!(attr in originals)) originals[attr] = current;
    const next = original.replace(key, hit);
    if (next !== current) element.setAttribute(attr, next);
  });
}

function restoreAttributes(root) {
  eachAttribute(root, (element, attr, current) => {
    const originals = attributeOriginals.get(element);
    if (!originals || !(attr in originals)) return;
    if (current !== originals[attr]) element.setAttribute(attr, originals[attr]);
  });
}

/**
 * Translate (or restore) the existing DOM under `root`.
 * @param {ParentNode & {ownerDocument?: Document}} root
 */
export function applyI18n(root) {
  if (!root) return;
  const doc = root.ownerDocument || root;
  try {
    const walker = doc.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }
    if (isEnglish()) {
      for (const textNode of nodes) translateTextNode(textNode);
      translateAttributes(root);
      doc.documentElement?.setAttribute?.('lang', 'en');
    } else {
      for (const textNode of nodes) restoreTextNode(textNode);
      restoreAttributes(root);
      doc.documentElement?.setAttribute?.('lang', 'zh-CN');
    }
  } catch {
    /* translation is best-effort and must never break the UI */
  }
}

/**
 * Apply translations now and keep watching for re-renders.
 * The observer is idempotent: after a node is English it no longer matches a
 * Chinese key, so no further writes (and no mutation loop) occur.
 * @param {ParentNode} root
 * @returns {MutationObserver|null}
 */
export function installI18n(root) {
  if (!root) return null;
  applyI18n(root);
  let scheduled = false;
  const run = () => {
    scheduled = false;
    applyI18n(root);
  };
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(run);
  });
  observer.observe(root, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
  return observer;
}
