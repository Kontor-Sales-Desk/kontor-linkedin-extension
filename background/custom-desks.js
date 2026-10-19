/**
 * Desks on the customer's own domain (self-hosted web app). The manifest only knows TechLads'
 * domains; any other https site can be allowed at runtime from the popup ("Use Kontor on …"),
 * through optional_host_permissions. Once Chrome grants it, the admin bridge relay is registered
 * as a content script for that origin (kept across restarts), so the desk reaches the extension
 * the same way it does on getkontor.eu: page postMessage → relay → service worker.
 * Removing the permission in Chrome (or from the popup) forgets the desk again.
 */

const STORAGE_KEY = 'customDeskOrigins';
const SCRIPT_PREFIX = 'kontor-desk-relay:';

/** Origins as "https://sales.company.com" (no trailing slash). Kept in memory for sync checks. */
let customOrigins = [];

const scriptId = (origin) => `${SCRIPT_PREFIX}${origin}`;
const originPattern = (origin) => `${origin}/*`;

/** Turns a permission pattern ("https://sales.company.com/*") into an origin, or null. */
function originFromPattern(pattern) {
  const match = /^(https?:\/\/[^/*]+)\/\*$/.exec(String(pattern ?? ''));
  if (!match) return null;
  // LinkedIn is the extension's own target, never a desk
  return /(^|\.)linkedin\.com$/i.test(new URL(match[1]).hostname) ? null : match[1];
}

export function isCustomDeskUrl(url) {
  if (!url || customOrigins.length === 0) return false;
  try {
    return customOrigins.includes(new URL(url).origin);
  } catch {
    return false;
  }
}

async function saveOrigins(next) {
  customOrigins = [...new Set(next)].sort();
  await chrome.storage.local.set({ [STORAGE_KEY]: customOrigins });
}

async function registerRelay(origin) {
  const id = scriptId(origin);
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [id] });
  if (existing.length > 0) return;
  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: [originPattern(origin)],
      js: ['content/admin-bridge-relay.js'],
      runAt: 'document_start',
      persistAcrossSessions: true,
    },
  ]);
}

async function unregisterRelay(origin) {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [scriptId(origin)] });
  } catch {
    // wasn't registered
  }
}

/** Puts the relay into desk tabs already open on that origin, so no reload is needed. */
async function injectIntoOpenTabs(origin) {
  const tabs = await chrome.tabs.query({ url: originPattern(origin) });
  for (const tab of tabs) {
    if (tab.id == null) continue;
    try {
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['content/admin-bridge-relay.js'] });
    } catch (err) {
      console.warn('[Kontor] relay inject failed:', err?.message ?? err);
    }
  }
}

/** Starts using a desk origin Chrome has just granted. */
async function addDesk(origin) {
  await registerRelay(origin);
  await saveOrigins([...customOrigins, origin]);
  await injectIntoOpenTabs(origin);
}

async function removeDesk(origin) {
  await unregisterRelay(origin);
  await saveOrigins(customOrigins.filter((o) => o !== origin));
}

/**
 * On every service-worker start: load the saved desks, keep only those Chrome still grants, and
 * make sure each has its relay registered.
 */
export async function initCustomDesks() {
  const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  const granted = (await chrome.permissions.getAll()).origins ?? [];
  const keep = [];
  for (const origin of Array.isArray(stored) ? stored : []) {
    if (granted.includes(originPattern(origin))) keep.push(origin);
    else await unregisterRelay(origin);
  }
  customOrigins = keep;
  for (const origin of keep) await registerRelay(origin);
  await chrome.storage.local.set({ [STORAGE_KEY]: keep });
}

// Granted from the popup's "Use Kontor on …" (the popup may close while Chrome asks, so the
// service worker does the work, not the popup)
chrome.permissions.onAdded.addListener((permissions) => {
  for (const pattern of permissions.origins ?? []) {
    const origin = originFromPattern(pattern);
    if (origin) void addDesk(origin);
  }
});

// Removed in chrome://extensions or from the popup
chrome.permissions.onRemoved.addListener((permissions) => {
  for (const pattern of permissions.origins ?? []) {
    const origin = originFromPattern(pattern);
    if (origin) void removeDesk(origin);
  }
});
