import { isAdminUrl } from './credentials.js';

function isRelevantTabUrl(url) {
  if (!url) return false;
  if (/https?:\/\/(www\.)?linkedin\.com/i.test(url)) return true;
  return isAdminUrl(url);
}

/** True when the last-focused window has an admin or LinkedIn tab. */
export async function isSalesContextFocused() {
  try {
    const win = await chrome.windows.getLastFocused({ populate: true });
    for (const tab of win?.tabs ?? []) {
      if (isRelevantTabUrl(tab.url)) return true;
    }
    return false;
  } catch {
    return false;
  }
}
