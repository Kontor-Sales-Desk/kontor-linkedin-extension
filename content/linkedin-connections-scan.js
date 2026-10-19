/**
 * Runs inside the LinkedIn webview — uses the page's real session (all cookies,
 * browser fingerprint). Do NOT call Voyager from Electron main for connections.
 */
(function linkedInConnectionsScan() {
  'use strict';

  if (window.__linkedinScanConnections) return;

  const DECORATION =
    'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-15';

  function readCsrfToken(options) {
    const passed = options?.csrfToken;
    if (typeof passed === 'string' && passed.startsWith('ajax:')) return passed;

    const meta =
      document.querySelector('meta[name="csrf-token"]') ||
      document.querySelector('meta[name="csrfToken"]');
    if (meta?.content && String(meta.content).startsWith('ajax:')) {
      return String(meta.content).trim();
    }

    const match = document.cookie.match(/(?:^|;\s*)JSESSIONID="?(ajax:[^";]+)"?/);
    return match ? match[1] : null;
  }

  function buildIncludedMap(included) {
    const map = new Map();
    for (const item of included || []) {
      if (!item || typeof item !== 'object') continue;
      if (item.entityUrn) map.set(item.entityUrn, item);
      if (item.publicIdentifier) map.set(`id:${item.publicIdentifier}`, item);
    }
    return map;
  }

  function resolveRef(ref, map) {
    if (ref && typeof ref === 'object') return ref;
    if (typeof ref === 'string' && map.has(ref)) return map.get(ref);
    return null;
  }

  function profileFromMember(member, map) {
    if (!member || typeof member !== 'object') return null;
    const publicId = member.publicIdentifier || member.publicHandle;
    if (!publicId) return null;
    const first = String(member.firstName || '').trim();
    const last = String(member.lastName || '').trim();
    const name = `${first} ${last}`.trim() || publicId;
    let headline = String(member.headline || member.occupation || '').trim();
    if (!headline) {
      const urn = member['*miniProfile'] || member.entityUrn;
      if (typeof urn === 'string' && map.has(urn)) {
        const inc = map.get(urn);
        headline = String(inc?.headline || inc?.occupation || '').trim();
      }
    }
    return {
      name,
      headline,
      linkedinUrl: `https://www.linkedin.com/in/${publicId}`,
      publicIdentifier: publicId,
    };
  }

  function parsePage(data) {
    const included = data?.included || [];
    const map = buildIncludedMap(included);
    const out = [];
    const seen = new Set();

    const push = (conn) => {
      if (!conn || seen.has(conn.publicIdentifier)) return;
      seen.add(conn.publicIdentifier);
      out.push(conn);
    };

    for (const el of data?.elements || []) {
      const member =
        resolveRef(el?.connectedMemberResolutionResult, map) ||
        resolveRef(el?.connectedMember, map) ||
        el;
      push(profileFromMember(member, map));
    }

    if (!out.length) {
      for (const item of included) {
        push(profileFromMember(item, map));
      }
    }

    return out;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function jitterDelay(baseMs) {
    const spread = Math.floor(baseMs * 0.35);
    return baseMs + Math.floor(Math.random() * spread);
  }

  window.__linkedinScanConnections = async function scanConnections(options) {
    const csrf = readCsrfToken(options);
    if (!csrf) {
      return {
        ok: false,
        error:
          'LinkedIn CSRF token missing. Refresh linkedin.com in the built-in browser and log in again.',
      };
    }

    const keywords = Array.isArray(options?.keywords)
      ? options.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean)
      : [];
    const maxResults = Math.min(Math.max(Number(options?.max_results) || 100, 1), 500);
    const maxPages = Math.min(Math.max(Number(options?.max_pages) || 5, 1), 15);
    const pageSize = 40;
    const startOffset = Math.max(Number(options?.start) || 0, 0);
    const pageDelayMs = Math.max(Number(options?.page_delay_ms) || 3200, 2000);

    const matches = [];
    let scannedCount = 0;
    let start = startOffset;
    let pagesFetched = 0;

    for (let pageIndex = 0; pageIndex < maxPages; pageIndex += 1) {
      const path =
        `/voyager/api/relationships/dash/connections?decorationId=${DECORATION}` +
        `&count=${pageSize}&q=search&sortType=RECENTLY_ADDED&start=${start}`;

      let res;
      try {
        const controller = new AbortController();
        const fetchTimer = setTimeout(() => controller.abort(), 30_000);
        res = await fetch(path, {
          method: 'GET',
          credentials: 'include',
          signal: controller.signal,
          headers: {
            accept: 'application/vnd.linkedin.normalized+json+2.1',
            'csrf-token': csrf,
            'x-restli-protocol-version': '2.0.0',
            referer: location.href,
          },
        });
        clearTimeout(fetchTimer);
      } catch (err) {
        const aborted = err?.name === 'AbortError';
        return {
          ok: false,
          error: aborted
            ? 'LinkedIn connections request timed out (30s). Check you are logged in on linkedin.com.'
            : `Network error while scanning connections: ${err?.message || err}`,
        };
      }

      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          status: res.status,
          error:
            'LinkedIn rejected the connections request (session may have expired). ' +
            'Refresh linkedin.com and log in again, then retry with a smaller scan.',
          scannedCount,
        };
      }

      if (res.status === 429) {
        return {
          ok: false,
          status: 429,
          error: 'LinkedIn rate limit — wait a few minutes before scanning again.',
          scannedCount,
          connections: matches,
          matchCount: matches.length,
        };
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return {
          ok: false,
          status: res.status,
          error: `Connections API error (${res.status})`,
          errorText: text.slice(0, 200),
          scannedCount,
        };
      }

      const data = await res.json().catch(() => ({}));
      const page = parsePage(data);
      pagesFetched += 1;

      if (!page.length) break;

      for (const conn of page) {
        scannedCount += 1;
        const hay = `${conn.name} ${conn.headline}`.toLowerCase();
        if (!keywords.length) {
          matches.push(conn);
        } else {
          const matchedKeywords = keywords.filter((kw) => hay.includes(kw));
          if (matchedKeywords.length) {
            matches.push({ ...conn, matchedKeywords });
          }
        }
        if (matches.length >= maxResults) break;
      }

      if (matches.length >= maxResults) break;
      if (page.length < pageSize) break;

      start += pageSize;
      await sleep(jitterDelay(pageDelayMs));
    }

    const hasMore = pagesFetched > 0 && scannedCount > 0 && pagesFetched >= maxPages;
    return {
      ok: true,
      connections: matches.slice(0, maxResults),
      scannedCount,
      matchCount: matches.length,
      keywords,
      start: startOffset,
      nextStart: hasMore ? start : null,
      hasMore,
      pagesFetched,
    };
  };
})();
