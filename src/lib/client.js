/** Helpers shared by the popup and options pages. */

import { formatLocale, isEnglish, tr } from './i18n.js';

export function send(type, payload = {}) {
  return new Promise((resolve) => {
    try {
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

export function formatDateTime(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '—';
  try {
    return new Intl.DateTimeFormat(formatLocale(), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleString(formatLocale());
  }
}

export function formatDate(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '—';
  try {
    return new Intl.DateTimeFormat(formatLocale(), {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleDateString(formatLocale());
  }
}

export function relativeDays(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return null;
  return Math.floor((Date.now() - value) / 86_400_000);
}

export function formatRelative(timestamp) {
  const days = relativeDays(timestamp);
  if (days === null) return '—';
  const english = isEnglish();
  if (days <= 0) return english ? 'Today' : '今天';
  if (days === 1) return english ? 'Yesterday' : '昨天';
  if (days < 30) return english ? `${days} days ago` : `${days} 天前`;
  if (days < 365) {
    const months = Math.floor(days / 30);
    return english ? `${months} months ago` : `${months} 个月前`;
  }
  const years = Math.floor(days / 365);
  return english ? `${years} years ago` : `${years} 年前`;
}

export function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

/** Append the configured clipboard auto-clear hint to a copy toast. */
export function clipboardMessage(message, clearAfterSeconds = 0) {
  const seconds = Number(clearAfterSeconds) || 0;
  const text = tr(message);
  if (seconds <= 0) return text;
  return isEnglish() ? `${text}, clears in ${seconds}s` : `${text}，${seconds} 秒后自动清除`;
}

export async function copyText(text, { clearAfterSeconds = 0 } = {}) {
  const value = String(text ?? '');
  let ok = false;
  try {
    await navigator.clipboard.writeText(value);
    ok = true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = value;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      ok = document.execCommand('copy');
      area.remove();
    } catch {
      ok = false;
    }
  }
  if (ok && clearAfterSeconds > 0 && value) {
    setTimeout(async () => {
      try {
        // Only clear when the clipboard still contains the copied password.
        const current = await navigator.clipboard.readText();
        if (current === value) await navigator.clipboard.writeText('');
      } catch {
        /* clipboard-read is optional; the manual clear button still works */
      }
    }, clearAfterSeconds * 1000);
  }
  return ok;
}

export async function clearClipboard() {
  try {
    await navigator.clipboard.writeText('');
    return true;
  } catch {
    return false;
  }
}

export function downloadText(filename, text, mime = 'text/plain;charset=utf-8') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export function makeToast(element) {
  let timer = 0;
  return (message, optionsOrDetail = {}, maybeOptions = {}) => {
    if (!element) return;
    let detail = '';
    let options = optionsOrDetail;
    if (typeof optionsOrDetail === 'string') {
      detail = optionsOrDetail;
      options = maybeOptions || {};
    }
    const { error = false, duration = 2800 } = options || {};
    element.replaceChildren();
    const titleText = String(message ?? '').trim();
    const detailText = String(detail ?? '').trim();
    const title = document.createElement('div');
    title.className = 'toast-title';
    title.setAttribute('data-i18n-raw', '');
    title.textContent = titleText || detailText || tr('操作完成');
    element.appendChild(title);
    if (titleText && detailText) {
      const detailElement = document.createElement('div');
      detailElement.className = 'toast-detail';
      detailElement.setAttribute('data-i18n-raw', '');
      detailElement.textContent = detailText;
      element.appendChild(detailElement);
    }
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    element.setAttribute('aria-atomic', 'true');
    element.classList.toggle('is-error', error);
    element.hidden = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      element.hidden = true;
    }, duration);
  };
}

export function isLockedError(message) {
  return typeof message === 'string' && message.includes('锁定');
}

/** Read a File as base64 (without the data: prefix). */
export function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    if (!file) {
      resolve('');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : '');
    };
    reader.onerror = () => reject(reader.error || new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}
