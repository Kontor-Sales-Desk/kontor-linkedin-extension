import { isCustomDeskUrl } from './custom-desks.js';

const ADMIN_HOSTS = new Set(['localhost', '127.0.0.1']);

export function isAdminUrl(url) {
  if (!url) return false;
  if (isCustomDeskUrl(url)) return true;
  try {
    const u = new URL(url);
    return ADMIN_HOSTS.has(u.hostname) && (u.port === '3000' || (!u.port && u.protocol === 'http:'));
  } catch {
    return false;
  }
}

export async function injectAdminBridge(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: (extId) => {
        const root = document.documentElement;
        if (!root) return;
        root.dataset.sccExtId = extId;
        try {
          localStorage.setItem('scc-extension-id', extId);
        } catch {
          // ignore
        }
      },
      args: [chrome.runtime.id],
    });
  } catch (err) {
    console.warn('[SCC ext] extension id inject failed:', err?.message ?? err);
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content/admin-bridge-relay.js'],
    });
  } catch (err) {
    console.warn('[SCC ext] relay inject failed:', err?.message ?? err);
  }
}

export async function injectAllAdminTabs() {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (tab.id != null && isAdminUrl(tab.url)) {
      await injectAdminBridge(tab.id);
    }
  }
}
