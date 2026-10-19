import { MSG, WRITE_TOOL_TOGGLES, EXTENSION_VERSION } from '../shared/constants.js';
import {
  getLinkedInContext,
  setLinkedInContext,
  clearLinkedInContext,
} from './context-cache.js';
import { findLinkedInTab, runInLinkedInTab } from './tab-utils.js';
import { runAgentLinkedInTool } from './linkedin-voyager-core.js';
import {
  setBackendCredentials,
  setActiveSite,
  getSendMode,
  getLinkedInEnabled,
  getLinkedInAutomationEnabled,
  getLinkedInAutoActions,
  getConnection,
} from './credentials.js';
import { getSessionCookies } from './session.js';
import { runLinkedInManualSync } from './manual-sync.js';
import { scrapeLinkedInSearch } from './search-scrape.js';
import { initBackgroundWorkers, onCredentialsUpdated } from './workers.js';
import { injectAdminBridge, injectAllAdminTabs, isAdminUrl } from './admin-bridge-inject.js';
import { initCustomDesks } from './custom-desks.js';

const SEND_BLOCKED_MESSAGE =
  'Send blocked: automation for this LinkedIn action is off (Settings → LinkedIn). Queue the action in Tasks and send manually from there.';

const LINKEDIN_DISABLED_MESSAGE =
  'LinkedIn outreach is disabled for this site. Enable it in Journey settings to use LinkedIn.';

function isLinkedInDisabled() {
  const siteId = getConnection()?.siteId;
  return !getLinkedInEnabled(siteId);
}

function isSendBlocked(toolName, approved) {
  const toggle = WRITE_TOOL_TOGGLES[toolName];
  if (!toggle) return false;
  if (approved === true) return false;
  const siteId = getConnection()?.siteId;
  if (!getLinkedInAutomationEnabled(siteId)) return true;
  if (getSendMode(siteId) !== 'auto') return true;
  return getLinkedInAutoActions(siteId)[toggle] !== true;
}

async function refreshLinkedInContext() {
  const res = await runInLinkedInTab({ type: MSG.FORCE_EXTRACT });
  if (!res?.ok) return getLinkedInContext();
  await new Promise((r) => setTimeout(r, 800));
  return getLinkedInContext();
}

async function handleAgentTool(toolName, input, approved) {
  if (isLinkedInDisabled()) {
    return JSON.stringify({ ok: false, error: LINKEDIN_DISABLED_MESSAGE });
  }
  if (isSendBlocked(toolName, approved)) {
    return JSON.stringify({ ok: false, error: SEND_BLOCKED_MESSAGE });
  }

  const cookies = await getSessionCookies();
  if (!cookies) {
    return JSON.stringify({
      ok: false,
      error: 'LinkedIn session not found. Open linkedin.com in Chrome and sign in.',
    });
  }

  const outcome = await runAgentLinkedInTool(toolName, input || {}, cookies);
  return JSON.stringify(outcome);
}

async function handleAdminRequest(request) {
  const { id, type, payload } = request;

  try {
    switch (type) {
      case 'PING':
        return { id, ok: true, result: { version: EXTENSION_VERSION, ready: true } };

      case 'REGISTER_CONNECTION': {
        await setBackendCredentials({
          supabaseUrl: payload?.supabaseUrl,
          supabaseAnonKey: payload?.supabaseAnonKey,
          siteId: payload?.siteId,
          adminSecret: payload?.adminSecret,
          sendMode: payload?.sendMode,
          linkedinEnabled: payload?.linkedinEnabled,
          linkedinAutomationEnabled: payload?.linkedinAutomationEnabled,
          linkedinAutoActions: payload?.linkedinAutoActions,
        });
        onCredentialsUpdated();
        return { id, ok: true, result: { ok: true } };
      }

      case 'SET_ACTIVE_SITE': {
        await setActiveSite(
          payload?.siteId,
          payload?.sendMode,
          payload?.linkedinEnabled,
          payload?.linkedinAutomationEnabled,
          payload?.linkedinAutoActions,
        );
        onCredentialsUpdated();
        return { id, ok: true, result: { ok: true } };
      }

      case 'GET_CONTEXT':
        return { id, ok: true, result: getLinkedInContext() };

      case 'REFRESH_CONTEXT':
        return { id, ok: true, result: await refreshLinkedInContext() };

      case 'GET_SESSION':
        return { id, ok: true, result: await getSessionCookies() };

      case 'AGENT_TOOL':
        return {
          id,
          ok: true,
          result: await handleAgentTool(
            payload?.toolName,
            payload?.input,
            payload?.approved === true,
          ),
        };

      case 'SYNC_NOW':
        if (isLinkedInDisabled()) {
          return { id, ok: true, result: { ok: false, error: LINKEDIN_DISABLED_MESSAGE } };
        }
        return { id, ok: true, result: await runLinkedInManualSync() };

      case 'SCRAPE_SEARCH':
        if (isLinkedInDisabled()) {
          return { id, ok: true, result: { ok: false, error: LINKEDIN_DISABLED_MESSAGE } };
        }
        return {
          id,
          ok: true,
          result: await scrapeLinkedInSearch(payload?.url, payload?.maxPages),
        };

      case 'GET_PROSPECT_STATUS': {
        if (isLinkedInDisabled()) {
          return { id, ok: true, result: { ok: false, error: LINKEDIN_DISABLED_MESSAGE } };
        }
        const url = String(payload?.url || '');
        const slugMatch = url.match(/linkedin\.com\/in\/([^/?#\s]+)/i);
        if (!slugMatch) {
          return { id, ok: true, result: { ok: false, error: 'Invalid LinkedIn profile URL.' } };
        }
        const slug = slugMatch[1];
        const dom = await runInLinkedInTab(
          { type: MSG.PROFILE_STATUS, payload: { slug } },
          { url: `https://www.linkedin.com/in/${slug}/` },
        );
        const cookies = await getSessionCookies();
        let conversation = null;
        if (cookies) {
          try {
            const toolResult = await runAgentLinkedInTool(
              'linkedin_status',
              { linkedin_url: url },
              cookies,
            );
            conversation = toolResult?.conversation ?? null;
          } catch {
            // ignore
          }
        }
        return {
          id,
          ok: true,
          result: {
            ok: dom?.ok !== false,
            connected: dom?.connected,
            degree: dom?.degree,
            conversation,
            error: dom?.error,
          },
        };
      }

      default:
        return { id, ok: false, error: `Unknown admin request: ${type}` };
    }
  } catch (err) {
    return {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function routeAdminPort(port) {
  port.onMessage.addListener((message) => {
    if (message?.channel !== MSG.ADMIN_REQUEST) return;
    handleAdminRequest(message)
      .then((response) => {
        try {
          port.postMessage(response);
        } catch {
          // port closed
        }
      })
      .catch((err) => {
        try {
          port.postMessage({
            id: message.id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // port closed
        }
      });
  });
}

function routeAdminRequest(message, sendResponse) {
  handleAdminRequest(message)
    .then((response) => sendResponse(response))
    .catch((err) =>
      sendResponse({
        id: message.id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  return true;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.channel === 'scc-ext-li-context') {
    setLinkedInContext(message.payload);
    sendResponse({ ok: true });
    return false;
  }

  if (message?.channel === MSG.ADMIN_REQUEST) {
    return routeAdminRequest(message, sendResponse);
  }

  if (message?.channel === 'scc-ext-clear-context') {
    clearLinkedInContext();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message?.channel !== MSG.ADMIN_REQUEST) return false;
  return routeAdminRequest(message, sendResponse);
});

chrome.runtime.onConnectExternal.addListener((port) => {
  routeAdminPort(port);
});

chrome.tabs.onRemoved.addListener(async () => {
  const tab = await findLinkedInTab();
  if (!tab) clearLinkedInContext();
});

void initBackgroundWorkers();
// desks on customers' own domains first, so the injection below already knows them
void initCustomDesks().then(() => injectAllAdminTabs());

chrome.runtime.onInstalled.addListener(() => {
  void injectAllAdminTabs();
});

chrome.runtime.onStartup.addListener(() => {
  void injectAllAdminTabs();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === 'complete' && isAdminUrl(tab.url)) {
    void injectAdminBridge(tabId);
  }
});

console.log(`[Kontor] extension service worker v${EXTENSION_VERSION}`);
