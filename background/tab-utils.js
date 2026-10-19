const LINKEDIN_MATCH = 'https://www.linkedin.com/*';

export async function findLinkedInTab() {
  const tabs = await chrome.tabs.query({ url: LINKEDIN_MATCH });
  return tabs.find((t) => t.id != null) ?? null;
}

export async function ensureLinkedInTab(url = 'https://www.linkedin.com/feed/') {
  const existing = await findLinkedInTab();
  if (existing?.id) return existing;

  const tab = await chrome.tabs.create({ url, active: false });
  await waitForTabLoad(tab.id, 45_000);
  return tab;
}

export function waitForTabLoad(tabId, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;

    const listener = (updatedTabId, info) => {
      if (updatedTabId !== tabId || info.status !== 'complete') return;
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(undefined);
    };

    chrome.tabs.onUpdated.addListener(listener);

    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve(undefined);
      }
    }).catch(reject);

    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      if (Date.now() >= deadline) reject(new Error('LinkedIn tab load timed out'));
    }, timeoutMs);
  });
}

/**
 * @param {number} tabId
 * @param {Record<string, unknown>} message
 */
export async function sendToLinkedInTab(tabId, message) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      channel: 'scc-ext-li',
      ...message,
    });
    return response ?? { ok: false, error: 'No response from LinkedIn tab' };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function runInLinkedInTab(message, { url } = {}) {
  let tab = await findLinkedInTab();
  if (!tab?.id && url) {
    tab = await ensureLinkedInTab(url);
  }
  if (!tab?.id) {
    return {
      ok: false,
      error: 'Open linkedin.com in Chrome and sign in — the extension needs an active LinkedIn tab.',
    };
  }
  return sendToLinkedInTab(tab.id, message);
}
