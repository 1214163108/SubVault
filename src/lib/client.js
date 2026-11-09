/** Helpers shared by the popup and options pages. */

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

export function formatDate(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value) || value <= 0) return '—';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(value));
  } catch {
    return new Date(value).toLocaleDateString();
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
  if (days <= 0) return '今天';
  if (days === 1) return '昨天';
  if (days < 30) return `${days} 天前`;
  if (days < 365) return `${Math.floor(days / 30)} 个月前`;
  return `${Math.floor(days / 365)} 年前`;
}

export function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
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
  return (message, { error = false, duration = 2800 } = {}) => {
    if (!element) return;
    element.textContent = message;
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
