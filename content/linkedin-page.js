/**
 * LinkedIn page runtime — Voyager fetch + DOM tools for the extension service worker.
 * Ported from electron/browser/browserShell.js (in-webview runners).
 */

(function linkedInPageRuntime() {
  'use strict';

  if (window.__SALES_ENGINE_LI_PAGE__) return;
  window.__SALES_ENGINE_LI_PAGE__ = true;

  function readCsrfToken() {
    const meta =
      document.querySelector('meta[name="csrf-token"]') ||
      document.querySelector('meta[name="csrfToken"]');
    if (meta?.content && String(meta.content).startsWith('ajax:')) {
      return String(meta.content).trim();
    }
    const match = document.cookie.match(/(?:^|;\s*)JSESSIONID="?(ajax:[^";]+)"?/);
    return match ? match[1] : null;
  }

  async function runVoyagerRequest(payload) {
    const {
      method = 'GET',
      path = '',
      body = null,
      extraHeaders = {},
      timeoutMs = 30_000,
    } = payload || {};

    const csrf = readCsrfToken();
    if (!csrf) {
      return {
        ok: false,
        status: 0,
        data: null,
        errorText: 'LinkedIn CSRF token missing — refresh linkedin.com and log in again.',
      };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs || 30000, 5000));

    const headers = {
      accept: 'application/vnd.linkedin.normalized+json+2.1',
      'csrf-token': csrf,
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': document.documentElement.lang || 'en-us',
      referer: location.href,
      ...(extraHeaders || {}),
    };

    const hasBody = body !== undefined && body !== null;
    if (hasBody) headers['content-type'] = 'application/json';

    try {
      const res = await fetch('/voyager/api' + path, {
        method: method || 'GET',
        credentials: 'include',
        signal: controller.signal,
        headers,
        body: hasBody ? JSON.stringify(body) : undefined,
      });
      clearTimeout(timer);
      const text = await res.text();
      let data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          data = {};
        }
      }
      return {
        ok: res.ok,
        status: res.status,
        data,
        errorText: res.ok ? '' : text.slice(0, 300),
      };
    } catch (err) {
      clearTimeout(timer);
      const aborted = err?.name === 'AbortError';
      return {
        ok: false,
        status: aborted ? 408 : 0,
        data: null,
        errorText: aborted ? 'LinkedIn request timed out' : String(err?.message || err),
      };
    }
  }

  function scrapeProfileStatus() {
    function norm(s) {
      return String(s || '').replace(/\s+/g, ' ').trim();
    }
    function buttonLabels(root) {
      return Array.from(root.querySelectorAll('button, a[role="button"]'))
        .map((el) => norm(el.textContent))
        .filter(Boolean);
    }

    const top =
      document.querySelector('section.artdeco-card[data-member-id]') ||
      document.querySelector('.pv-top-card') ||
      document.querySelector('main section') ||
      document.querySelector('[class*="top-card"]');
    const scope = top || document.querySelector('main') || document.body;
    const scopeText = norm(scope.innerText).slice(0, 2800);
    const headerText = scopeText.slice(0, 700);
    const buttons = buttonLabels(scope);
    const hasMessage = buttons.some((t) => /^message$/i.test(t));
    const hasPending = buttons.some((t) => /^pending$/i.test(t));
    const hasConnect = buttons.some((t) => /^(connect|follow|invite)$/i.test(t));
    const hasRemove = /remove connection/i.test(scopeText);

    if ((hasMessage || hasRemove) && !hasPending) {
      return { ok: true, degree: '1st', connected: true, signal: 'action-buttons' };
    }
    if (hasPending) {
      return { ok: true, degree: 'pending', connected: false, signal: 'pending-button' };
    }

    const nameEl = scope.querySelector('h1');
    const nameBlock = nameEl
      ? norm((nameEl.closest('div')?.parentElement || nameEl.parentElement || nameEl).innerText || '').slice(0, 400)
      : '';
    const nearName =
      nameBlock.match(/[•·]\s*(1st|2nd|3rd\+?)/i) ||
      headerText.match(/[•·]\s*(1st|2nd|3rd\+?)/i);
    if (nearName) {
      const degree = nearName[1].replace(/\+$/, '');
      return { ok: true, degree, connected: /^1st$/i.test(degree), signal: 'name-bullet' };
    }

    if (hasConnect) {
      return { ok: true, degree: '', connected: false, signal: 'connect-button' };
    }

    return { ok: true, degree: '', connected: false, signal: 'unknown' };
  }

  async function scrapeContactOverlay() {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const emailReG = /[\w.+-]+@[\w-]+\.[\w.-]+/g;

    let trigger =
      document.getElementById('top-card-text-details-contact-info') ||
      document.querySelector('a[href*="overlay/contact-info"]') ||
      Array.from(document.querySelectorAll('a, button')).find((el) =>
        /contact info/i.test((el.textContent || '').trim()));
    const triggerFound = !!trigger;
    if (trigger) trigger.click();

    const findModal = () => {
      const heading = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]')).find(
        (el) => /^\s*contact info\s*$/i.test(el.textContent || ''),
      );
      if (heading) {
        let node = heading;
        for (let i = 0; i < 8 && node.parentElement; i++) {
          node = node.parentElement;
          if (node.querySelector('a[href^="mailto:"], a[href^="tel:"], a[href^="http"]')) return node;
        }
        return heading.parentElement || heading;
      }
      return null;
    };

    let modal = null;
    const deadline = Date.now() + 9000;
    while (Date.now() < deadline) {
      modal = findModal();
      if (modal) break;
      await sleep(400);
    }
    if (!modal) {
      return { ok: false, error: 'contact dialog not found', triggerFound, url: location.href };
    }

    const emails = [];
    const phones = [];
    const websites = [];
    const twitter = [];
    const add = (arr, v) => {
      v = (v || '').trim();
      if (v && !arr.includes(v)) arr.push(v);
    };
    modal.querySelectorAll('a[href^="mailto:"]').forEach((a) =>
      add(emails, decodeURIComponent((a.getAttribute('href') || '').replace(/^mailto:/, ''))));
    modal.querySelectorAll('a[href^="tel:"]').forEach((a) =>
      add(phones, (a.getAttribute('href') || '').replace(/^tel:/, '')));
    modal.querySelectorAll('a[href^="http"]').forEach((a) => {
      const u = a.getAttribute('href') || '';
      if (/twitter\.com|x\.com/i.test(u)) add(twitter, u);
      else if (!/linkedin\.com/i.test(u)) add(websites, u);
    });
    (modal.textContent.match(emailReG) || []).forEach((e) => add(emails, e));
    return { ok: true, emails, phones, websites, twitter, debugLen: modal.textContent.length };
  }

  function getSessionStatus() {
    const csrf = readCsrfToken();
    // li_at is HttpOnly — session.js reads it via chrome.cookies in the service worker.
    return { loggedIn: Boolean(csrf), csrfToken: csrf };
  }

  function scrapeSearchPageResults() {
    const clean = (h) => {
      try {
        return new URL(h, location.href).href.split('?')[0].replace(/\/$/, '');
      } catch {
        return '';
      }
    };
    const results = [];
    const seen = new Set();
    const anchors = Array.from(document.querySelectorAll('a[href*="/in/"]'));
    const sampleHrefs = anchors.slice(0, 6).map((a) => a.getAttribute('href'));
    for (const a of anchors) {
      const url = clean(a.getAttribute('href') || '');
      if (!url || !/linkedin\.com\/in\//.test(url) || seen.has(url)) continue;
      const card = a.closest('li') || a.closest('[data-chameleon-result-urn]') || a.closest('div');
      let name = (a.querySelector('span[aria-hidden="true"]') || {}).textContent || '';
      if (!name) name = a.getAttribute('aria-label') || '';
      if (!name && card) {
        const img = card.querySelector('img[alt]');
        if (img) name = img.getAttribute('alt') || '';
      }
      if (!name) name = a.textContent || '';
      name = name.replace(/\s+/g, ' ').trim();
      if (!name || name.length > 80 || /^(view |message|connect|follow|status is|linkedin member)/i.test(name)) {
        continue;
      }
      seen.add(url);
      const txt = (sel) => {
        const el = card && card.querySelector(sel);
        return el ? el.textContent.trim() : '';
      };
      const headline =
        txt('.entity-result__primary-subtitle') ||
        txt('[class*="primary-subtitle"]') ||
        txt('[class*="subtitle"]');
      const location =
        txt('.entity-result__secondary-subtitle') || txt('[class*="secondary-subtitle"]');
      results.push({ name, profileUrl: url, headline, location });
    }
    return {
      results,
      debug: {
        anchors: anchors.length,
        cards: results.length,
        url: location.href,
        sampleHrefs,
        sampleNames: results.slice(0, 5).map((r) => r.name),
      },
    };
  }

  async function scrollSearchPage() {
    for (let i = 0; i < 6; i++) {
      window.scrollBy(0, document.body.scrollHeight);
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: true };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.channel !== 'scc-ext-li') return undefined;

    const run = async () => {
      switch (message.type) {
        case 'voyager-request':
          return runVoyagerRequest(message.payload);
        case 'force-extract':
          window.__salesEngineForceLinkedInExtract?.();
          return { ok: true };
        case 'profile-status':
          return scrapeProfileStatus();
        case 'contact-overlay':
          return scrapeContactOverlay();
        case 'get-session':
          return getSessionStatus();
        case 'connections-scan':
          if (typeof window.__linkedinScanConnections !== 'function') {
            return { ok: false, error: 'Connections scan script not loaded.' };
          }
          return window.__linkedinScanConnections(message.payload?.options || {});
        case 'scroll-search-page':
          return scrollSearchPage();
        case 'scrape-search-page':
          return scrapeSearchPageResults();
        default:
          return { ok: false, error: `Unknown page command: ${message.type}` };
      }
    };

    run()
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err?.message ?? String(err) }));
    return true;
  });
})();
