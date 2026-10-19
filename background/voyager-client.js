import { MSG } from '../shared/constants.js';
import { findLinkedInTab, ensureLinkedInTab, sendToLinkedInTab } from './tab-utils.js';

/**
 * Run a Voyager API call inside the user's LinkedIn tab (real session cookies).
 * @param {string} method
 * @param {string} path
 * @param {unknown} [body]
 * @param {Record<string, string>} [extraHeaders]
 */
export async function voyagerRequestInTab(method, path, body, extraHeaders = {}) {
  let tab = await findLinkedInTab();
  if (!tab?.id) {
    tab = await ensureLinkedInTab('https://www.linkedin.com/feed/');
  }
  if (!tab?.id) {
    return { ok: false, status: 0, data: null, errorText: 'No LinkedIn tab available.' };
  }

  return sendToLinkedInTab(tab.id, {
    type: MSG.VOYAGER_REQUEST,
    payload: { method, path, body: body ?? null, extraHeaders, timeoutMs: 30_000 },
  });
}

export async function contactOverlayInTab(slug) {
  const url = `https://www.linkedin.com/in/${slug}/`;
  let tab = await findLinkedInTab();
  const onSlug = tab?.url?.includes(`/in/${slug}`);

  if (!tab?.id || !onSlug) {
    tab = await ensureLinkedInTab(url);
    if (tab?.id && !tab.url?.includes(`/in/${slug}`)) {
      await chrome.tabs.update(tab.id, { url });
      await new Promise((r) => setTimeout(r, 2500));
    }
  }

  if (!tab?.id) return { ok: false, error: 'Could not open LinkedIn profile tab.' };

  return sendToLinkedInTab(tab.id, {
    type: MSG.CONTACT_OVERLAY,
    payload: { slug },
  });
}

export async function profileStatusInTab(slug) {
  const url = `https://www.linkedin.com/in/${slug}/`;
  let tab = await findLinkedInTab();
  if (!tab?.id || !tab.url?.includes(`/in/${slug}`)) {
    tab = await ensureLinkedInTab(url);
    if (tab?.id) {
      await chrome.tabs.update(tab.id, { url });
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  if (!tab?.id) return { ok: false, error: 'Could not open LinkedIn profile tab.' };
  return sendToLinkedInTab(tab.id, { type: MSG.PROFILE_STATUS, payload: { slug } });
}

export async function connectionsScanInTab(options) {
  const tab = await ensureLinkedInTab(
    'https://www.linkedin.com/mynetwork/invite-connect/connections/',
  );
  if (!tab?.id) return { ok: false, error: 'Could not open connections page.' };
  return sendToLinkedInTab(tab.id, {
    type: MSG.CONNECTIONS_SCAN,
    payload: { options },
  });
}
