/**
 * Isolated-world relay — forwards page postMessage to the extension service worker.
 */
(function adminBridgeRelay() {
  'use strict';

  const PAGE_REQ = 'scc-ext:page-request';
  const PAGE_RES = 'scc-ext:page-response';
  const EXT_CHANNEL = 'scc-ext:admin-request';

  function start() {
    const root = document.documentElement;
    if (!root || root.dataset.sccExtRelay) return;
    root.dataset.sccExtRelay = '1';
    try {
      root.dataset.sccExtId = chrome.runtime.id;
      localStorage.setItem('scc-extension-id', chrome.runtime.id);
    } catch {
      // ignore
    }

    window.dispatchEvent(new CustomEvent('sales-engine-extension-relay-ready'));

    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.channel !== PAGE_REQ || !data.id) return;

      chrome.runtime.sendMessage(
        {
          channel: EXT_CHANNEL,
          id: data.id,
          type: data.type,
          payload: data.payload ?? {},
        },
        (response) => {
          if (chrome.runtime.lastError) {
            window.postMessage(
              {
                channel: PAGE_RES,
                id: data.id,
                ok: false,
                error: chrome.runtime.lastError.message,
              },
              '*',
            );
            return;
          }
          window.postMessage(
            {
              channel: PAGE_RES,
              id: data.id,
              ok: response?.ok,
              result: response?.result,
              error: response?.error,
            },
            '*',
          );
        },
      );
    });
  }

  if (document.documentElement) start();
  else {
    document.addEventListener('readystatechange', () => {
      if (document.documentElement) start();
    });
  }
})();
