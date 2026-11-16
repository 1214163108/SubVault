/**
 * Local privacy shield for extension pages.
 *
 * When the tab/window becomes hidden or loses focus, a translucent overlay
 * covers the UI so passwords are not left readable on screen. Users who often
 * switch windows can disable it in Settings. The overlay is dismissed locally;
 * no state is read or stored.
 */
export function installPrivacyShield() {
  const shield = document.getElementById('privacyShield');
  if (!shield) return;

  let enabled = true;

  const show = () => {
    if (!enabled) return;
    shield.hidden = false;
  };
  const hide = () => {
    shield.hidden = true;
  };

  const applySetting = (value) => {
    enabled = value !== false;
    if (!enabled) hide();
  };

  try {
    chrome.storage.local.get('settings').then((stored) => {
      applySetting(stored?.settings?.privacyShieldOnBlur);
    }).catch(() => {});
  } catch {
    // Keep the default (enabled) when storage is unavailable.
  }

  try {
    chrome.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'local' || !changes.settings) return;
      applySetting(changes.settings.newValue?.privacyShieldOnBlur);
    });
  } catch {
    // Older mocks may not expose storage.onChanged.
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') show();
  });
  window.addEventListener('blur', () => {
    // A native file picker also blurs the page; do not cover that workflow.
    const active = document.activeElement;
    if (active?.tagName === 'INPUT' && active.type === 'file') return;
    if (document.querySelector('dialog[open]')) return;
    show();
  });
  shield.addEventListener('click', hide);
  shield.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      hide();
    }
  });
  window.addEventListener('focus', () => {
    if (!shield.hidden) shield.focus?.();
  });
  shield.tabIndex = 0;
}
