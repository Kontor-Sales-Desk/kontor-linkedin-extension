/**
 * Main-world admin API — runs via manifest world:MAIN so React can read window.salesEngineExtension.
 */
(function salesEngineAdminBridgePage() {
  'use strict';

  if (window.salesDesktop?.linkedInAgentTool) return;
  if (window.salesEngineExtension?.ready) return;

  const PAGE_REQ = 'scc-ext:page-request';
  const PAGE_RES = 'scc-ext:page-response';
  const EXT_CHANNEL = 'scc-ext:admin-request';
  const PING_TIMEOUT_MS = 8000;
  const REQUEST_TIMEOUT_MS = 120_000;

  let requestSeq = 0;

  function getExtensionId() {
    try {
      const fromDom = document.documentElement?.dataset?.sccExtId;
      if (fromDom) return fromDom;
      return localStorage.getItem('scc-extension-id');
    } catch {
      return null;
    }
  }

  function canUseExternalConnect() {
    return typeof chrome !== 'undefined' && chrome.runtime?.sendMessage && getExtensionId();
  }

  function waitForExtensionId(maxMs) {
    return new Promise((resolve) => {
      const deadline = Date.now() + maxMs;
      const tick = () => {
        const id = getExtensionId();
        if (id) {
          resolve(id);
          return;
        }
        if (Date.now() >= deadline) {
          resolve(null);
          return;
        }
        requestAnimationFrame(tick);
      };
      tick();
    });
  }

  function sendViaExternalConnect(id, type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const extensionId = getExtensionId();
      if (!extensionId || !chrome.runtime?.sendMessage) {
        reject(new Error('Extension runtime unavailable'));
        return;
      }

      const timeout = setTimeout(() => reject(new Error('Extension request timed out')), timeoutMs);

      chrome.runtime.sendMessage(
        extensionId,
        { channel: EXT_CHANNEL, id, type, payload },
        (response) => {
          clearTimeout(timeout);
          if (chrome.runtime.lastError?.message) {
            reject(new Error(chrome.runtime.lastError.message));
            return;
          }
          if (response?.ok === false) {
            reject(new Error(response.error || 'Extension request failed'));
            return;
          }
          resolve(response?.result);
        },
      );
    });
  }

  function sendViaPostMessage(id, type, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        window.removeEventListener('message', handler);
        reject(new Error('Extension request timed out'));
      }, timeoutMs);

      const handler = (event) => {
        if (event.source !== window) return;
        const msg = event.data;
        if (!msg || msg.channel !== PAGE_RES || msg.id !== id) return;
        clearTimeout(timeout);
        window.removeEventListener('message', handler);
        if (msg.ok === false) {
          reject(new Error(msg.error || 'Extension request failed'));
          return;
        }
        resolve(msg.result);
      };

      window.addEventListener('message', handler);
      window.postMessage({ channel: PAGE_REQ, id, type, payload }, '*');
    });
  }

  function sendRequest(type, payload = {}, timeoutMs = REQUEST_TIMEOUT_MS) {
    const id = `req-${Date.now()}-${++requestSeq}`;

    if (canUseExternalConnect()) {
      return sendViaExternalConnect(id, type, payload, timeoutMs).catch((err) => {
        if (document.documentElement?.dataset?.sccExtRelay === '1') {
          return sendViaPostMessage(id, type, payload, timeoutMs);
        }
        throw err;
      });
    }

    if (document.documentElement?.dataset?.sccExtRelay === '1') {
      return sendViaPostMessage(id, type, payload, timeoutMs);
    }

    return Promise.reject(new Error('Extension not connected'));
  }

  const api = {
    isDesktop: false,
    platform: 'chrome-extension',
    getLinkedInCookies: async () => {
      const session = await sendRequest('GET_SESSION');
      if (!session?.liAt) return null;
      return { liAt: session.liAt, csrfToken: session.csrfToken || 'session-active' };
    },
    getLinkedInContext: () => sendRequest('GET_CONTEXT'),
    refreshLinkedInContext: () => sendRequest('REFRESH_CONTEXT'),
    linkedInAgentTool: async (toolName, input, options) => {
      const result = await sendRequest('AGENT_TOOL', {
        toolName,
        input: input || {},
        approved: options?.approved === true,
      });
      return typeof result === 'string' ? result : JSON.stringify(result);
    },
    getProspectLinkedInStatus: (url) => sendRequest('GET_PROSPECT_STATUS', { url }),
    syncLinkedInNow: () => sendRequest('SYNC_NOW'),
    scrapeLinkedInSearch: (url, maxPages) =>
      sendRequest('SCRAPE_SEARCH', { url, maxPages }),
    registerConnection: (config) => sendRequest('REGISTER_CONNECTION', config),
    setExtensionActiveSite: (siteId, sendMode, linkedinEnabled, linkedinAutomationEnabled) =>
      sendRequest('SET_ACTIVE_SITE', { siteId, sendMode, linkedinEnabled, linkedinAutomationEnabled }),
  };

  window.salesEngineExtension = {
    version: '0.2.5',
    ready: false,
    api,
  };

  void waitForExtensionId(PING_TIMEOUT_MS).then(() =>
    sendRequest('PING', {}, PING_TIMEOUT_MS)
      .then((info) => {
        window.salesEngineExtension.ready = true;
        window.salesEngineExtension.version = info?.version || '0.2.5';
        window.dispatchEvent(new CustomEvent('sales-engine-extension-ready', { detail: info }));
        console.info('[Kontor] extension bridge ready', info?.version || '0.2.5');
      })
      .catch((err) => {
        window.salesEngineExtension.ready = false;
        console.warn('[Kontor] extension bridge ping failed:', err?.message || err);
      }),
  );
})();
