import { ADMIN_ORIGIN_PATTERNS } from '../shared/config.js';

const EXT_CHANNEL = 'scc-ext:admin-request';
// kept by background/custom-desks.js
const CUSTOM_DESKS_KEY = 'customDeskOrigins';

function setStatus(html, ok) {
  const el = document.getElementById('status');
  el.className = ok ? 'ok' : 'bad';
  el.innerHTML = html;
}

chrome.runtime.sendMessage(
  { channel: EXT_CHANNEL, id: 'popup-ping', type: 'PING', payload: {} },
  (response) => {
    if (chrome.runtime.lastError) {
      setStatus(
        `<strong>Service worker dead</strong><br>${chrome.runtime.lastError.message}<br><br>Reload extension at chrome://extensions`,
        false,
      );
      return;
    }
    if (response?.ok) {
      const v = response.result?.version || '?';
      setStatus(`<strong>Extension OK</strong><br>v${v}<br><br>Open Kontor + linkedin.com`, true);
      return;
    }
    setStatus(`<strong>Error</strong><br>${response?.error || 'Unknown'}`, false);
  },
);

// ── This tab as a Kontor desk on the customer's own domain ────────────────────────

const desk = document.getElementById('desk');
const deskText = document.getElementById('desk-text');
const deskButton = document.getElementById('desk-button');

function showDesk(text, button) {
  desk.hidden = false;
  deskText.textContent = text;
  if (!button) {
    deskButton.hidden = true;
    return;
  }
  deskButton.hidden = false;
  deskButton.textContent = button.label;
  deskButton.className = button.secondary ? 'secondary' : '';
  deskButton.onclick = button.onClick;
}

function isBuiltInDesk(url) {
  return ADMIN_ORIGIN_PATTERNS.some((pattern) => url.startsWith(pattern.replace(/\*$/, '')));
}

async function initDesk() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let url;
  try {
    url = new URL(tab?.url ?? '');
  } catch {
    return;
  }
  // only https sites can be allowed; LinkedIn is the extension's own target
  if (url.protocol !== 'https:' || /(^|\.)linkedin\.com$/i.test(url.hostname)) return;
  if (isBuiltInDesk(url.href)) return;

  const origin = url.origin;
  const pattern = `${origin}/*`;
  const stored = (await chrome.storage.local.get(CUSTOM_DESKS_KEY))[CUSTOM_DESKS_KEY];
  const allowed = Array.isArray(stored) && stored.includes(origin);

  if (allowed) {
    showDesk(`Kontor is connected on ${url.hostname}.`, {
      label: 'Remove this site',
      secondary: true,
      onClick: async () => {
        await chrome.permissions.remove({ origins: [pattern] });
        showDesk(`Removed. Kontor no longer connects on ${url.hostname}.`);
      },
    });
    return;
  }

  showDesk(`Is this your Kontor web app? Allow the extension here so Kontor can use your LinkedIn.`, {
    label: `Use Kontor on ${url.hostname}`,
    onClick: async () => {
      // Chrome asks the user; the service worker sets the site up once it's granted
      const granted = await chrome.permissions.request({ origins: [pattern] });
      showDesk(
        granted
          ? `Done. Kontor connects on ${url.hostname} now. If it doesn't show as connected, reload the page.`
          : 'Not allowed. You can try again any time from this button.',
      );
    },
  });
}

void initDesk();
