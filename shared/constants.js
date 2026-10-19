/** @typedef {'GET_CONTEXT' | 'REFRESH_CONTEXT' | 'AGENT_TOOL' | 'PING' | 'GET_SESSION' | 'SCRAPE_SEARCH' | 'SYNC_NOW'} AdminRequestType */

export const MSG = {
  // Admin page ↔ service worker
  ADMIN_REQUEST: 'scc-ext:admin-request',
  ADMIN_RESPONSE: 'scc-ext:admin-response',

  // LinkedIn content script ↔ service worker
  LI_CONTEXT: 'scc-ext:li-context',
  LI_PAGE: 'scc-ext:li-page',

  // Internal page command types (LI_PAGE payload.type)
  VOYAGER_REQUEST: 'voyager-request',
  FORCE_EXTRACT: 'force-extract',
  PROFILE_STATUS: 'profile-status',
  CONTACT_OVERLAY: 'contact-overlay',
  GET_SESSION: 'get-session',
  CONNECTIONS_SCAN: 'connections-scan',
  SCROLL_SEARCH_PAGE: 'scroll-search-page',
  SCRAPE_SEARCH_PAGE: 'scrape-search-page',
};

export const LINKEDIN_VOYAGER_TOOLS = new Set([
  'linkedin_connect',
  'linkedin_message',
  'linkedin_follow',
  'linkedin_endorse',
  'linkedin_contact_info',
  'linkedin_list_connections',
  'linkedin_enrich',
  'linkedin_status',
]);

export const WRITE_TOOLS = new Set([
  'linkedin_connect',
  'linkedin_message',
  'linkedin_follow',
  'linkedin_endorse',
]);

/** Per-action automation toggle each write tool requires for unattended sends. */
export const WRITE_TOOL_TOGGLES = {
  linkedin_connect: 'connect',
  linkedin_message: 'message',
  linkedin_follow: 'follow',
  linkedin_endorse: 'endorse',
};

export const EXTENSION_VERSION = '0.4.0';
