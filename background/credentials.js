import { ADMIN_ORIGIN_PATTERNS } from '../shared/config.js';
import { isCustomDeskUrl } from './custom-desks.js';

/** @typedef {{ supabaseUrl: string; supabaseAnonKey: string; siteId: string; adminSecret?: string }} BackendConnection */

/** @type {BackendConnection | null} */
let connection = null;

/** @type {Record<string, 'review' | 'auto'>} */
let sendModeBySite = {};

/** @type {Record<string, boolean>} */
let linkedinEnabledBySite = {};

/** @type {Record<string, boolean>} */
let linkedinAutomationBySite = {};

/** @type {Record<string, Record<string, boolean>>} */
let linkedinAutoActionsBySite = {};

export async function loadStoredCredentials() {
  const data = await chrome.storage.local.get([
    'backendConnection',
    'sendModeBySite',
    'linkedinEnabledBySite',
    'linkedinAutomationBySite',
    'linkedinAutoActionsBySite',
  ]);
  if (data.backendConnection && typeof data.backendConnection === 'object') {
    connection = data.backendConnection;
  }
  if (data.sendModeBySite && typeof data.sendModeBySite === 'object') {
    sendModeBySite = data.sendModeBySite;
  }
  if (data.linkedinEnabledBySite && typeof data.linkedinEnabledBySite === 'object') {
    linkedinEnabledBySite = data.linkedinEnabledBySite;
  }
  if (data.linkedinAutomationBySite && typeof data.linkedinAutomationBySite === 'object') {
    linkedinAutomationBySite = data.linkedinAutomationBySite;
  }
  if (data.linkedinAutoActionsBySite && typeof data.linkedinAutoActionsBySite === 'object') {
    linkedinAutoActionsBySite = data.linkedinAutoActionsBySite;
  }
}

function normalizeAutoActions(raw) {
  const data = raw && typeof raw === 'object' ? raw : {};
  return {
    connect: data.connect === true,
    message: data.message === true,
    follow: data.follow === true,
    endorse: data.endorse === true,
    inbox_sync: data.inbox_sync === true,
    discovery: data.discovery === true,
  };
}

export function getConnection() {
  return connection;
}

export function getAdminSecret() {
  return connection?.adminSecret?.trim() || '';
}

export function getSendMode(siteId) {
  if (!siteId) return 'review';
  return sendModeBySite[siteId] || 'review';
}

export function getLinkedInEnabled(siteId) {
  if (!siteId) return false;
  return linkedinEnabledBySite[siteId] === true;
}

export function getLinkedInAutomationEnabled(siteId) {
  if (!siteId) return false;
  return linkedinAutomationBySite[siteId] === true;
}

/** Per-action LinkedIn automation toggles; every action defaults off. */
export function getLinkedInAutoActions(siteId) {
  if (!siteId) return normalizeAutoActions(null);
  return normalizeAutoActions(linkedinAutoActionsBySite[siteId]);
}

export function isBackendConfigured() {
  const c = connection;
  return Boolean(
    c?.supabaseUrl && c?.supabaseAnonKey && c?.siteId && c?.adminSecret?.trim(),
  );
}

/**
 * @param {BackendConnection & { adminSecret: string; sendMode?: 'review' | 'auto'; linkedinEnabled?: boolean; linkedinAutomationEnabled?: boolean }} payload
 */
export async function setBackendCredentials(payload) {
  connection = {
    supabaseUrl: String(payload.supabaseUrl || '').replace(/\/+$/, ''),
    supabaseAnonKey: String(payload.supabaseAnonKey || ''),
    siteId: String(payload.siteId || ''),
    adminSecret: String(payload.adminSecret || '').trim(),
  };

  if (payload.siteId && payload.sendMode) {
    sendModeBySite[payload.siteId] = payload.sendMode;
    sendModeBySite.__activeSiteId = payload.siteId;
  } else if (payload.siteId) {
    sendModeBySite.__activeSiteId = payload.siteId;
  }

  if (payload.siteId && typeof payload.linkedinEnabled === 'boolean') {
    linkedinEnabledBySite[payload.siteId] = payload.linkedinEnabled;
  }

  if (payload.siteId && typeof payload.linkedinAutomationEnabled === 'boolean') {
    linkedinAutomationBySite[payload.siteId] = payload.linkedinAutomationEnabled;
  }

  if (payload.siteId && payload.linkedinAutoActions && typeof payload.linkedinAutoActions === 'object') {
    linkedinAutoActionsBySite[payload.siteId] = normalizeAutoActions(payload.linkedinAutoActions);
  }

  await chrome.storage.local.set({
    backendConnection: connection,
    sendModeBySite,
    linkedinEnabledBySite,
    linkedinAutomationBySite,
    linkedinAutoActionsBySite,
  });

  return { ok: true };
}

export async function setActiveSite(
  siteId,
  sendMode,
  linkedinEnabled,
  linkedinAutomationEnabled,
  linkedinAutoActions,
) {
  if (siteId) sendModeBySite.__activeSiteId = siteId;
  if (siteId && sendMode) sendModeBySite[siteId] = sendMode;
  if (siteId && typeof linkedinEnabled === 'boolean') {
    linkedinEnabledBySite[siteId] = linkedinEnabled;
  }
  if (siteId && typeof linkedinAutomationEnabled === 'boolean') {
    linkedinAutomationBySite[siteId] = linkedinAutomationEnabled;
  }
  if (siteId && linkedinAutoActions && typeof linkedinAutoActions === 'object') {
    linkedinAutoActionsBySite[siteId] = normalizeAutoActions(linkedinAutoActions);
  }
  await chrome.storage.local.set({
    sendModeBySite,
    linkedinEnabledBySite,
    linkedinAutomationBySite,
    linkedinAutoActionsBySite,
  });
}

export function isAdminUrl(url) {
  if (!url) return false;
  // a desk on the customer's own domain, allowed from the popup
  if (isCustomDeskUrl(url)) return true;
  try {
    const u = new URL(url);
    const href = u.href;
    return ADMIN_ORIGIN_PATTERNS.some((pattern) => {
      const prefix = pattern.replace(/\*$/, '');
      return href.startsWith(prefix);
    });
  } catch {
    return false;
  }
}
