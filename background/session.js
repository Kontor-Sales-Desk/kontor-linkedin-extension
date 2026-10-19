/**
 * Read LinkedIn session from browser cookies (li_at is HttpOnly — not in document.cookie).
 */
export async function getSessionCookies() {
  const url = 'https://www.linkedin.com';

  const [liAtCookie, jsessionCookie] = await Promise.all([
    chrome.cookies.get({ url, name: 'li_at' }),
    chrome.cookies.get({ url, name: 'JSESSIONID' }),
  ]);

  const liAt = liAtCookie?.value?.trim();
  if (!liAt) return null;

  let csrfToken = 'session-active';
  const raw = jsessionCookie?.value ?? '';
  if (raw) {
    csrfToken = raw.replace(/^"/, '').replace(/"$/, '');
  }

  return { liAt, csrfToken };
}
