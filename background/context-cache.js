import { CONTEXT_TTL_MS } from '../shared/config.js';

/** @type {Record<string, unknown> | null} */
let cachedContext = null;
let cachedAt = 0;

export function setLinkedInContext(data) {
  if (!data || typeof data !== 'object') return;
  cachedContext = data;
  cachedAt = Date.now();
}

export function getLinkedInContext() {
  if (!cachedContext) return null;
  if (Date.now() - cachedAt > CONTEXT_TTL_MS) {
    cachedContext = null;
    cachedAt = 0;
    return null;
  }
  return cachedContext;
}

export function clearLinkedInContext() {
  cachedContext = null;
  cachedAt = 0;
}
