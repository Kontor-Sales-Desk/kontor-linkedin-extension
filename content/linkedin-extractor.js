/**
 * LinkedIn content script — passive page context for the sales agent.
 * Ported from electron/browser/content-scripts/linkedin-extractor.js
 */

(function linkedInExtractor() {
  'use strict';

  if (window.__SALES_ENGINE_LI_EXTRACTOR__) {
    return;
  }
  window.__SALES_ENGINE_LI_EXTRACTOR__ = true;

  const SETTLE_MS = 2000;
  const MIN_PASSIVE_GAP_MS = 45_000;

  let lastUrl = '';
  let lastSentAt = 0;
  let settleTimer = null;

  function detectPageType(url) {
    if (/\/in\/[^/]+/.test(url)) return 'profile';
    if (/\/search\/results\/people/.test(url)) return 'search_people';
    if (/\/search\/results\/companies/.test(url)) return 'search_companies';
    if (/\/search\//.test(url)) return 'search';
    if (/\/messaging\//.test(url)) return 'messages';
    if (/\/company\/[^/]+/.test(url)) return 'company';
    if (/\/feed/.test(url)) return 'feed';
    if (/\/jobs\//.test(url)) return 'jobs';
    return 'other';
  }

  function extractProfile() {
    const data = {};
    const nameEl = document.querySelector('h1.text-heading-xlarge, h1.inline');
    if (nameEl) data.name = nameEl.textContent.trim();

    const headlineEl = document.querySelector('.text-body-medium[data-generated-suggestion-target]')
      || document.querySelector('.text-body-medium.break-words');
    if (headlineEl) data.headline = headlineEl.textContent.trim();

    const locationEl = document.querySelector('.text-body-small.inline.t-black--light.break-words')
      || document.querySelector('span.text-body-small[class*="t-black--light"]');
    if (locationEl) data.location = locationEl.textContent.trim();

    const degreeEl = document.querySelector('.dist-value, span.distance-badge');
    if (degreeEl) data.connectionDegree = degreeEl.textContent.trim();

    const aboutSection = document.querySelector('#about ~ .display-flex .inline-show-more-text, [id*="about"] + * .inline-show-more-text');
    if (aboutSection) data.about = aboutSection.textContent.trim().slice(0, 1000);

    const expItems = document.querySelectorAll('#experience ~ .pvs-list__outer-container li.artdeco-list__item');
    const experience = [];
    for (const item of Array.from(expItems).slice(0, 5)) {
      const title = item.querySelector('.t-bold span[aria-hidden="true"]')?.textContent?.trim();
      const company = item.querySelector('.t-normal span[aria-hidden="true"]')?.textContent?.trim();
      const duration = item.querySelector('.t-black--light .t-normal span[aria-hidden="true"]')?.textContent?.trim();
      if (title || company) {
        experience.push({ title: title || '', company: company || '', duration: duration || '' });
      }
    }
    if (experience.length) data.experienceItems = experience;
    if (experience.length > 0) {
      data.company = experience[0].company;
      data.position = experience[0].title;
    }

    const canonical = document.querySelector('link[rel="canonical"]');
    data.profileUrl = canonical?.href || window.location.href.split('?')[0];
    return data;
  }

  function extractSearchResults() {
    const results = [];
    const items = document.querySelectorAll('.reusable-search__result-container, li.reusable-search__result-container');
    for (const item of Array.from(items).slice(0, 15)) {
      const nameEl = item.querySelector('.entity-result__title-text a span[aria-hidden="true"], .entity-result__title-text .t-bold span');
      const subtitleEl = item.querySelector('.entity-result__primary-subtitle');
      const secondaryEl = item.querySelector('.entity-result__secondary-subtitle');
      const linkEl = item.querySelector('.entity-result__title-text a, .app-aware-link');
      results.push({
        name: nameEl?.textContent?.trim() || '',
        subtitle: subtitleEl?.textContent?.trim() || '',
        location: secondaryEl?.textContent?.trim() || '',
        profileUrl: linkEl?.href?.split('?')[0] || '',
      });
    }
    return { results, totalCount: results.length };
  }

  function extractMessages() {
    const conversations = [];
    const threads = document.querySelectorAll('.msg-conversation-listitem');
    for (const thread of Array.from(threads).slice(0, 10)) {
      const name = thread.querySelector('.msg-conversation-listitem__participant-names')?.textContent?.trim();
      const preview = thread.querySelector('.msg-conversation-card__message-snippet')?.textContent?.trim();
      const time = thread.querySelector('.msg-conversation-listitem__time-stamp, time')?.textContent?.trim();
      if (name) conversations.push({ name, preview: preview || '', time: time || '' });
    }
    return { conversations };
  }

  function extractCompany() {
    const data = {};
    const nameEl = document.querySelector('h1.org-top-card-summary__title, h1[class*="top-card"]');
    if (nameEl) data.companyName = nameEl.textContent.trim();
    const industryEl = document.querySelector('.org-top-card-summary-info-list__info-item');
    if (industryEl) data.industry = industryEl.textContent.trim();
    const aboutEl = document.querySelector('.org-page-details__definition-text, [class*="about"] p');
    if (aboutEl) data.about = aboutEl.textContent.trim().slice(0, 1000);
    const sizeEl = document.querySelectorAll('.org-top-card-summary-info-list__info-item');
    for (const el of sizeEl) {
      const text = el.textContent.trim();
      if (/employees|people/i.test(text)) {
        data.size = text;
        break;
      }
    }
    data.companyUrl = window.location.href.split('?')[0];
    return data;
  }

  function extractPageData() {
    const url = window.location.href;
    const pageType = detectPageType(url);
    const base = { url, pageType, pageTitle: document.title, timestamp: Date.now() };
    switch (pageType) {
      case 'profile':
        return { ...base, profileData: extractProfile() };
      case 'search_people':
      case 'search_companies':
      case 'search':
        return { ...base, searchData: extractSearchResults() };
      case 'messages':
        return { ...base, messagesData: extractMessages() };
      case 'company':
        return { ...base, companyData: extractCompany() };
      default:
        return { ...base, visibleContent: document.body?.innerText?.slice(0, 2000) || '' };
    }
  }

  function sendToExtension(data) {
    try {
      chrome.runtime.sendMessage({ channel: 'scc-ext-li-context', payload: data });
    } catch {
      // extension context invalidated
    }
  }

  function runExtraction(force = false) {
    if (document.visibilityState === 'hidden') return;

    const currentUrl = window.location.href;
    const now = Date.now();
    const urlChanged = currentUrl !== lastUrl;

    if (!force) {
      if (!urlChanged && now - lastSentAt < MIN_PASSIVE_GAP_MS) return;
    }

    lastUrl = currentUrl;
    lastSentAt = now;

    try {
      sendToExtension(extractPageData());
    } catch (err) {
      console.warn('[Kontor] LinkedIn extraction error:', err);
    }
  }

  function scheduleExtraction(force = false) {
    if (settleTimer) clearTimeout(settleTimer);
    const delay = force ? 0 : SETTLE_MS;
    settleTimer = setTimeout(() => runExtraction(force), delay);
  }

  function hookHistory() {
    const notify = () => scheduleExtraction(false);
    window.addEventListener('popstate', notify);
    const wrap = (original) => function historyHook(...args) {
      const result = original.apply(this, args);
      notify();
      return result;
    };
    try {
      history.pushState = wrap(history.pushState);
      history.replaceState = wrap(history.replaceState);
    } catch {
      // read-only in some contexts
    }
  }

  window.__salesEngineForceLinkedInExtract = function forceLinkedInExtract() {
    scheduleExtraction(true);
  };

  hookHistory();
  scheduleExtraction(false);
})();
