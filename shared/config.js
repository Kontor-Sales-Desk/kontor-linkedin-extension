/**
 * Admin origins allowed to use the extension bridge.
 * Add your production admin URL before publishing.
 */
export const ADMIN_ORIGIN_PATTERNS = [
  'http://localhost:3000/*',
  'http://127.0.0.1:3000/*',
  'https://localhost:3000/*',
  'https://techlads.eu/*',
  'https://www.techlads.eu/*',
  'https://test.techlads.eu/*',
  'http://localhost:3001/*',
  'https://getkontor.eu/*',
  'https://www.getkontor.eu/*',
];

export const CONTEXT_TTL_MS = 2 * 60 * 1000;
