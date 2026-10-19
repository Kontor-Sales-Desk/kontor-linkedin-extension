import {
  findLinkedInTab,
  ensureLinkedInTab,
  sendToLinkedInTab,
  waitForTabLoad,
} from './tab-utils.js';
import { MSG } from '../shared/constants.js';

function withPage(url, page) {
  try {
    const u = new URL(url);
    u.searchParams.set('page', String(page));
    return u.href;
  } catch {
    return url;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Harvest people from a LinkedIn people-search URL across pages.
 * @param {string} startUrl
 * @param {number} [maxPages]
 */
export async function scrapeLinkedInSearch(startUrl, maxPages = 5) {
  const pageCap = Math.min(Math.max(Number(maxPages) || 5, 1), 40);
  let tab = await findLinkedInTab();
  if (!tab?.id) {
    tab = await ensureLinkedInTab(startUrl);
  }
  if (!tab?.id) {
    return { ok: false, error: 'Could not open a LinkedIn tab.' };
  }

  const people = [];
  const seen = new Set();
  let pagesScanned = 0;
  let lastDebug = null;

  for (let page = 1; page <= pageCap; page++) {
    const url = page === 1 ? startUrl : withPage(startUrl, page);
    await chrome.tabs.update(tab.id, { url });
    try {
      await waitForTabLoad(tab.id, 30_000);
    } catch {
      // continue
    }
    await sleep(1500);

    await sendToLinkedInTab(tab.id, { type: MSG.SCROLL_SEARCH_PAGE });

    const pageResult = await sendToLinkedInTab(tab.id, { type: MSG.SCRAPE_SEARCH_PAGE });
    lastDebug = pageResult?.debug;
    const rows = pageResult?.results || [];
    let added = 0;

    for (const r of rows) {
      if (r.profileUrl && !seen.has(r.profileUrl)) {
        seen.add(r.profileUrl);
        people.push(r);
        added += 1;
      }
    }

    pagesScanned = page;
    if (!rows.length || !added) break;
    await sleep(1400 + Math.floor(Math.random() * 900));
  }

  return { ok: true, people, pagesScanned, debug: lastDebug };
}
