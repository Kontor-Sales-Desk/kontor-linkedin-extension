/**
 * Ported from electron/browser/linkedinVoyager.cjs — runs Voyager via extension tabs.
 */

import {
  voyagerRequestInTab,
  contactOverlayInTab,
  connectionsScanInTab,
} from './voyager-client.js';

function makeMessagingTrackingId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

// ---------------------------------------------------------------------------
// Voyager HTTP (in-tab session)
// ---------------------------------------------------------------------------

async function voyagerFetch(_liAt, _csrfToken, method, path, body, extraHeaders = {}) {
  const res = await voyagerRequestInTab(method, path, body, extraHeaders);
  if (!res?.ok) {
    const err = new Error(`Voyager ${method} ${path} → ${res?.status || 'failed'}`);
    err.status = res?.status || 0;
    err.detail = res?.errorText || '';
    throw err;
  }
  return res.data ?? {};
}

async function voyagerFetchRaw(_liAt, _csrfToken, method, path, body, extraHeaders = {}) {
  const res = await voyagerRequestInTab(method, path, body, extraHeaders);
  if (!res || typeof res !== 'object') {
    return { ok: false, status: 0, data: null, errorText: 'Empty Voyager response' };
  }
  return {
    ok: res.ok,
    status: res.status,
    data: res.data,
    errorText: res.errorText || '',
  };
}

// ---------------------------------------------------------------------------
// Profile URN resolution
// ---------------------------------------------------------------------------

function extractSlug(url) {
  const m = String(url).match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  if (!m) throw new Error(`Cannot extract slug from: ${url}`);
  return m[1];
}

async function resolveProfileUrn(liAt, csrfToken, slug) {
  const encoded = encodeURIComponent(slug);
  const attempts = [
    `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encoded}`,
    `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encoded}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.WebTopCardCore-16`,
    `/identity/profiles/${encoded}`,
  ];

  for (const path of attempts) {
    try {
      const data = await voyagerFetch(liAt, csrfToken, 'GET', path);
      const urn = extractUrnFromProfileData(data);
      if (urn) return urn;
    } catch {
      // try next endpoint
    }
  }
  throw new Error(`Could not resolve URN for @${slug}. Use the exact linkedin.com/in/… URL — do not guess from name.`);
}

function extractUrnFromProfileData(data) {
  const elements = data?.elements ?? [];
  for (const el of elements) {
    for (const key of ['entityUrn', 'objectUrn', 'profileUrn']) {
      const urn = String(el?.[key] ?? '');
      if (urn.startsWith('urn:li:fsd_profile:') || urn.startsWith('urn:li:member:')) return urn;
    }
  }
  const included = data?.included ?? [];
  for (const item of included) {
    const urn = String(item?.entityUrn ?? item?.objectUrn ?? '');
    if (urn.startsWith('urn:li:fsd_profile:') || urn.startsWith('urn:li:member:')) return urn;
  }
  if (data?.data && typeof data.data === 'object') {
    for (const val of Object.values(data.data)) {
      const urn = String(val?.entityUrn ?? '');
      if (urn.startsWith('urn:li:fsd_profile:') || urn.startsWith('urn:li:member:')) return urn;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Voyager write actions
// ---------------------------------------------------------------------------

async function sendConnectionRequest(liAt, csrfToken, profileUrn, note) {
  const fsdUrn = profileUrn.startsWith('urn:li:fsd_profile:') ? profileUrn : profileUrn;
  const withNote = note ? { customMessage: String(note).slice(0, 300) } : {};

  const variants = [
    {
      path: '/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2&decorationId=com.linkedin.voyager.dash.deco.relationships.InvitationCreationResultWithInvitee-2',
      body: { invitee: { inviteeUnion: { memberProfile: fsdUrn } }, ...withNote },
    },
    {
      path: '/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2',
      body: { invitee: { inviteeUnion: { memberProfile: fsdUrn } }, ...withNote },
    },
    {
      path: '/voyagerRelationshipsDashMemberRelationships?action=verifyQuotaAndCreateV2',
      body: {
        invitee: { 'com.linkedin.voyager.dash.common.MemberInvitee': { memberUrn: profileUrn } },
        ...withNote,
      },
    },
  ];

  let lastErr;
  for (const { path, body } of variants) {
    try {
      return await voyagerFetch(liAt, csrfToken, 'POST', path, body);
    } catch (err) {
      lastErr = err;
      if (err.status === 429 || err.status === 401 || err.status === 403) throw err;
    }
  }
  throw lastErr ?? new Error('Connection request failed');
}

/** Resolve the logged-in member's own fsd_profile URN (needed as the messaging mailbox). */
let cachedMyProfileUrn = null;
async function getMyProfileUrn(liAt, csrfToken) {
  if (cachedMyProfileUrn) return cachedMyProfileUrn;
  const data = await voyagerFetch(liAt, csrfToken, 'GET', '/me');
  const raw =
    data?.data?.['*miniProfile'] ??
    data?.data?.entityUrn ??
    (Array.isArray(data?.included)
      ? data.included.find((i) => String(i?.entityUrn ?? '').includes('iniProfile'))?.entityUrn
      : null);
  // fs_miniProfile and fsd_profile share the same trailing member id.
  const id = String(raw ?? '').split(':').pop();
  if (!id) throw new Error('Could not resolve your own LinkedIn profile URN for messaging.');
  cachedMyProfileUrn = `urn:li:fsd_profile:${id}`;
  return cachedMyProfileUrn;
}

function toFsdProfileUrn(profileUrn) {
  return profileUrn.startsWith('urn:li:fsd_profile:')
    ? profileUrn
    : `urn:li:fsd_profile:${String(profileUrn).split(':').pop()}`;
}

/** LinkedIn expects the messaging trackingId as a raw 16-byte string (not base64). */
async function sendDirectMessage(liAt, csrfToken, profileUrn, text) {
  const recipient = toFsdProfileUrn(profileUrn);
  const recipientId = String(recipient).split(':').pop();
  const messageText = String(text).slice(0, 1900);

  // Preferred: current Messenger Dash endpoint. LinkedIn deprecated the LEGACY_INBOX
  // createMessage call. NOTE: Voyager restli does strict schema validation and rejects
  // unknown fields — the Dash MessageCreate has no `originToken`, so including it 400s.
  let dashErr;
  let mailboxUrn = '(unresolved)';
  try {
    mailboxUrn = await getMyProfileUrn(liAt, csrfToken);
    const out = await voyagerFetch(
      liAt,
      csrfToken,
      'POST',
      '/voyagerMessagingDashMessengerMessages?action=createMessage',
      {
        message: {
          body: { attributes: [], text: messageText },
          renderContentUnions: [],
          originToken: crypto.randomUUID(),
        },
        mailboxUrn,
        // New-conversation create needs BOTH recipients and hostRecipientUrns (same array).
        recipients: [recipient],
        hostRecipientUrns: [recipient],
        trackingId: makeMessagingTrackingId(),
        dedupeByClientGeneratedToken: false,
      },
      { accept: 'application/json' },
    );
    console.log('[LinkedIn DM] dash OK', { mailboxUrn, recipient });
    return out;
  } catch (err) {
    dashErr = err;
    console.error('[LinkedIn DM] dash FAILED', {
      status: err?.status,
      detail: err?.detail,
      mailboxUrn,
      recipient,
    });
  }

  // Fallback: legacy conversations endpoint with the correct eventCreate envelope
  // (bare recipient id, not the full URN).
  try {
    const out = await voyagerFetch(
      liAt,
      csrfToken,
      'POST',
      '/messaging/conversations?action=create&keyVersion=LEGACY_INBOX',
      {
        keyVersion: 'LEGACY_INBOX',
        conversationCreate: {
          eventCreate: {
            originToken: crypto.randomUUID(),
            value: {
              'com.linkedin.voyager.messaging.create.MessageCreate': {
                attributedBody: { text: messageText, attributes: [] },
                attachments: [],
              },
            },
          },
          recipients: [recipientId],
          subtype: 'MEMBER_TO_MEMBER',
        },
      },
    );
    console.log('[LinkedIn DM] legacy OK', { recipient });
    return out;
  } catch (legacyErr) {
    console.error('[LinkedIn DM] legacy FAILED', {
      status: legacyErr?.status,
      detail: legacyErr?.detail,
      recipient,
    });
    // Report the raw facts — do NOT assert a cause. Both endpoints failed; the status +
    // body below are what LinkedIn actually returned, for the user/agent to interpret.
    const err = dashErr?.status ? dashErr : legacyErr;
    err.message =
      `DM send failed. Dash: ${dashErr?.status ?? '—'} ${dashErr?.detail ?? ''} | ` +
      `Legacy: ${legacyErr?.status ?? '—'} ${legacyErr?.detail ?? ''} | ` +
      `mailboxUrn=${mailboxUrn} recipient=${recipient}`;
    throw err;
  }
}

async function followMember(_liAt, _csrfToken, profileUrn) {
  const profileId = profileUrn.replace('urn:li:fsd_profile:', '');
  const path = `/feed/dash/followingStates/urn:li:fsd_followingState:urn:li:fsd_profile:${profileId}`;
  const res = await voyagerRequestInTab(
    'POST',
    path,
    { patch: { $set: { following: true } } },
    { 'x-http-method-override': 'PATCH' },
  );
  if (!res?.ok) {
    throw new Error(`Follow failed (${res?.status || 0}): ${(res?.errorText || '').slice(0, 200)}`);
  }
  return {};
}

async function endorseSkill(liAt, csrfToken, profileUrn, skillName) {
  const body = {
    endorsee: { profileUrn },
    entityUrn: `urn:li:fs_skill:(${profileUrn},${encodeURIComponent(skillName)})`,
  };
  return voyagerFetch(liAt, csrfToken, 'POST', '/relationships/skill-endorsements', body);
}

// ---------------------------------------------------------------------------
// Contact info
// ---------------------------------------------------------------------------

function pushEmailCandidate(emails, val) {
  if (typeof val === 'string' && val.includes('@')) {
    emails.push(val.trim());
    return;
  }
  if (val && typeof val === 'object') {
    const e = val.emailAddress;
    if (typeof e === 'string' && e.includes('@')) emails.push(e.trim());
  }
}

function parseContactInfoPayload(data) {
  const result = { email: null, emails: [], phones: [], websites: [], twitter: [] };
  if (!data || typeof data !== 'object') return result;

  // Normalized responses wrap the actual record under a top-level "data" key.
  if (
    data.data &&
    typeof data.data === 'object' &&
    (data.data.emailAddress || data.data.phoneNumbers || data.data.elements)
  ) {
    data = data.data;
  }

  pushEmailCandidate(result.emails, data.emailAddress);
  pushEmailCandidate(result.emails, data.email);

  const elements = data.elements;
  if (elements?.[0]) {
    pushEmailCandidate(result.emails, elements[0].emailAddress);
    const attrs = elements[0].creatorWebsite?.attributesV2 ?? [];
    for (const attr of attrs) {
      const href = attr.detailDataUnion?.hyperlink;
      if (typeof href === 'string' && href.startsWith('http')) result.websites.push(href);
    }
  }

  if (Array.isArray(data.phoneNumbers)) {
    for (const p of data.phoneNumbers) {
      const num = p.phoneNumber ?? p.number;
      if (typeof num === 'object' && num?.number) result.phones.push(String(num.number).trim());
      else if (typeof num === 'string' && num.trim()) result.phones.push(num.trim());
    }
  }

  if (Array.isArray(data.websites)) {
    for (const w of data.websites) {
      if (typeof w.url === 'string' && w.url.startsWith('http')) result.websites.push(w.url);
    }
  }

  if (Array.isArray(data.twitterHandles)) {
    for (const h of data.twitterHandles) {
      if (typeof h.name === 'string' && h.name.trim()) result.twitter.push(h.name.trim());
    }
  }

  result.emails = [...new Set(result.emails)];
  result.phones = [...new Set(result.phones)];
  result.websites = [...new Set(result.websites)];
  result.twitter = [...new Set(result.twitter)];
  result.email = result.emails[0] ?? null;
  return result;
}

async function fetchContactInfo(liAt, csrfToken, slug) {
  const encoded = encodeURIComponent(slug);
  // profileContactInfo is a legacy REST endpoint — like the messaging one, it behaves
  // best with a plain JSON accept rather than the normalized+json we default to.
  const attempts = [
    { path: `/identity/profiles/${encoded}/profileContactInfo`, headers: { accept: 'application/json' } },
    { path: `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encoded}`, headers: {} },
    {
      path: `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encoded}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.TopCardSupplementary-126`,
      headers: {},
    },
  ];

  const merged = { email: null, emails: [], phones: [], websites: [], twitter: [] };
  for (const { path, headers } of attempts) {
    const res = await voyagerFetchRaw(liAt, csrfToken, 'GET', path, undefined, headers);
    const record = res.data?.data ?? res.data;
    console.log('[LinkedIn contact] attempt', {
      path: path.slice(0, 70),
      ok: res.ok,
      status: res.status,
      keys: record && typeof record === 'object' ? Object.keys(record).slice(0, 12) : null,
      hasEmail: !!(record?.emailAddress || record?.elements?.[0]?.emailAddress),
      phones: record?.phoneNumbers?.length ?? 0,
      err: (res.errorText || '').slice(0, 100),
    });
    if (!res.ok) continue;
    const parsed = parseContactInfoPayload(res.data);
    merged.emails = [...new Set([...merged.emails, ...parsed.emails])];
    merged.phones = [...new Set([...merged.phones, ...parsed.phones])];
    merged.websites = [...new Set([...merged.websites, ...parsed.websites])];
    merged.twitter = [...new Set([...merged.twitter, ...parsed.twitter])];
  }

  // The Voyager contact API is retired (410). If it yielded nothing, fall back to scraping
  // the contact-info overlay in the browser — the reliable path for 1st-degree connections.
  if (!merged.emails.length && !merged.phones.length) {
    try {
      const overlay = await contactOverlayInTab(slug);
      console.log('[LinkedIn contact] overlay', {
        ok: overlay?.ok,
        emails: overlay?.emails?.length ?? 0,
        phones: overlay?.phones?.length ?? 0,
        dialogTextLen: overlay?.debugLen ?? 0,
        triggerFound: overlay?.triggerFound,
        dialogs: overlay?.dialogs,
        modals: overlay?.modals,
        url: overlay?.url,
        err: overlay?.error,
      });
      if (overlay?.ok) {
        merged.emails = [...new Set([...merged.emails, ...(overlay.emails ?? [])])];
        merged.phones = [...new Set([...merged.phones, ...(overlay.phones ?? [])])];
        merged.websites = [...new Set([...merged.websites, ...(overlay.websites ?? [])])];
        merged.twitter = [...new Set([...merged.twitter, ...(overlay.twitter ?? [])])];
      }
    } catch (err) {
      console.warn('[LinkedIn contact] overlay scrape failed:', err?.message ?? err);
    }
  }

  merged.email = merged.emails[0] ?? null;
  return merged;
}

function voyagerFailure(err, slug) {
  return {
    ok: false,
    slug,
    status: err.status ?? null,
    error: err.message ?? String(err),
    errorText: err.detail ?? '',
  };
}

// ---------------------------------------------------------------------------
// Connections list (1st-degree network)
// ---------------------------------------------------------------------------

const CONNECTIONS_DECORATION =
  'com.linkedin.voyager.dash.deco.web.mynetwork.ConnectionListWithProfile-16';

/** LinkedIn wraps many text fields as AttributedText objects ({ text, attributes }). */
function attributedText(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (typeof val === 'object' && typeof val.text === 'string') return val.text;
  return '';
}

/**
 * The connections list only returns name + headline (no structured company). LinkedIn
 * headlines are typically "Title at Company", so derive the employer from the text after
 * the last " at " / " @ ", trimmed of any trailing location/separator segment.
 */
function companyFromHeadline(headline) {
  const parts = String(headline || '').split(/\s+(?:at|@)\s+/i);
  if (parts.length < 2) return '';
  const company = parts[parts.length - 1].split(/\s*[·•]\s*|\s+[-–—|]\s+/)[0].trim();
  return company.slice(0, 120);
}

function buildIncludedMap(included) {
  const map = new Map();
  for (const item of included ?? []) {
    if (!item || typeof item !== 'object') continue;
    if (item.entityUrn) map.set(item.entityUrn, item);
    if (item.publicIdentifier) map.set(`id:${item.publicIdentifier}`, item);
    const urn = item['*miniProfile'] ?? item['*connectedMemberResolutionResult'];
    if (typeof urn === 'string' && urn) map.set(urn, item);
  }
  return map;
}

function resolveLinkedInRef(ref, includedMap) {
  if (ref && typeof ref === 'object') return ref;
  if (typeof ref === 'string' && includedMap.has(ref)) return includedMap.get(ref);
  return null;
}

function pickHeadline(member, includedMap) {
  const direct =
    attributedText(member?.headline) ||
    attributedText(member?.occupation) ||
    attributedText(member?.title);
  if (direct) return direct.trim();
  const urn = member?.['*miniProfile'] ?? member?.miniProfile ?? member?.entityUrn;
  if (typeof urn === 'string' && includedMap.has(urn)) {
    const inc = includedMap.get(urn);
    return (attributedText(inc?.headline) || attributedText(inc?.occupation)).trim();
  }
  return '';
}

function connectionFromProfile(member, includedMap) {
  if (!member || typeof member !== 'object') return null;

  const publicId = member.publicIdentifier ?? member.publicHandle ?? null;
  if (!publicId || typeof publicId !== 'string') return null;

  const firstName = String(member.firstName ?? '').trim();
  const lastName = String(member.lastName ?? '').trim();
  const name = `${firstName} ${lastName}`.trim() || publicId;
  const headline = pickHeadline(member, includedMap);

  return {
    name,
    headline,
    company: companyFromHeadline(headline),
    linkedinUrl: `https://www.linkedin.com/in/${publicId}`,
    publicIdentifier: publicId,
  };
}

function parseConnectionElement(el, includedMap) {
  const member =
    resolveLinkedInRef(el?.connectedMemberResolutionResult, includedMap) ??
    resolveLinkedInRef(el?.connectedMember, includedMap) ??
    resolveLinkedInRef(el?.memberResolutionResult, includedMap) ??
    el;
  return connectionFromProfile(member, includedMap);
}

function parseConnectionsPage(data) {
  const included = data?.included ?? [];
  const includedMap = buildIncludedMap(included);
  const connections = [];
  const seen = new Set();

  const push = (conn) => {
    if (!conn || seen.has(conn.publicIdentifier)) return;
    seen.add(conn.publicIdentifier);
    connections.push(conn);
  };

  for (const el of data?.elements ?? []) {
    push(parseConnectionElement(el, includedMap));
  }

  if (!connections.length) {
    for (const item of included) {
      push(connectionFromProfile(item, includedMap));
    }
  }

  return connections;
}

async function fetchConnectionsPage(liAt, csrfToken, start, count = 40) {
  const path =
    `/relationships/dash/connections?decorationId=${CONNECTIONS_DECORATION}` +
    `&count=${count}&q=search&sortType=RECENTLY_ADDED&start=${start}`;
  return voyagerFetch(liAt, csrfToken, 'GET', path);
}

async function listConnectionsFiltered(liAt, csrfToken, options = {}) {
  const keywords = Array.isArray(options.keywords)
    ? options.keywords.map((k) => String(k).toLowerCase().trim()).filter(Boolean)
    : [];
  const maxResults = Math.min(Math.max(Number(options.max_results) || 100, 1), 500);
  const defaultScan = keywords.length ? 1200 : 200;
  const maxScan = Math.min(Math.max(Number(options.max_scan) || defaultScan, 40), 5000);
  const pageSize = 40;
  const startOffset = Math.max(Number(options.start) || 0, 0);
  const pageDelayMs = 300;

  const matches = [];
  let scannedCount = 0;
  let start = startOffset;
  let pagesFetched = 0;

  while (scannedCount < maxScan) {
    let data;
    try {
      data = await fetchConnectionsPage(liAt, csrfToken, start, pageSize);
    } catch (err) {
      if (scannedCount === 0) throw err;
      break;
    }

    pagesFetched += 1;
    const page = parseConnectionsPage(data);
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
    await new Promise((resolve) => setTimeout(resolve, pageDelayMs));
  }

  const nextStart = start < startOffset + scannedCount ? startOffset + scannedCount : start;
  const hasMore = pagesFetched > 0 && scannedCount >= pageSize && scannedCount < maxScan;

  return {
    ok: true,
    connections: matches.slice(0, maxResults),
    scannedCount,
    matchCount: matches.length,
    keywords,
    start: startOffset,
    nextStart: hasMore ? nextStart : null,
    hasMore,
  };
}

// ---------------------------------------------------------------------------
// Full profile enrichment (headline, current company/title, experience, location)
// ---------------------------------------------------------------------------

const PROFILE_DECORATION =
  'com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-101';

async function fetchFullProfile(liAt, csrfToken, slug) {
  const path =
    `/identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}` +
    `&decorationId=${PROFILE_DECORATION}`;
  return voyagerFetchRaw(liAt, csrfToken, 'GET', path);
}

function buildUrnMap(included) {
  const map = new Map();
  for (const item of included ?? []) {
    if (item?.entityUrn) map.set(item.entityUrn, item);
  }
  return map;
}

// Resolve a *collectionResponse URN (or object) to its array of element objects.
function resolveCollectionElements(ref, map) {
  const coll = typeof ref === 'string' ? map.get(ref) : ref;
  const urns = coll?.['*elements'] ?? [];
  return urns.map((u) => (typeof u === 'string' ? map.get(u) : u)).filter(Boolean);
}

function positionStartScore(pos) {
  const s = pos?.dateRange?.start;
  if (!s?.year) return -1;
  return s.year * 12 + (s.month || 0);
}

function formatDateRange(dr) {
  const fmt = (d) =>
    d?.year ? (d.month ? `${d.year}-${String(d.month).padStart(2, '0')}` : String(d.year)) : '';
  const start = fmt(dr?.start);
  if (!start) return '';
  return `${start}–${dr?.end ? fmt(dr.end) : 'present'}`;
}

function parseFullProfile(res) {
  const targetUrn = res?.data?.['*elements']?.[0];
  const map = buildUrnMap(res?.included);
  const profile =
    (targetUrn && map.get(targetUrn)) ||
    (res?.included ?? []).find((i) => String(i?.$type ?? '').endsWith('.Profile'));
  if (!profile) return null;

  const name = `${attributedText(profile.firstName)} ${attributedText(profile.lastName)}`.trim();
  const headline = attributedText(profile.headline);
  const summary = attributedText(profile.summary);

  let location = attributedText(profile.locationName);
  const geoUrn = profile.geoLocation?.geoUrn;
  if (!location && geoUrn && map.has(geoUrn)) {
    location = String(map.get(geoUrn)?.defaultLocalizedName ?? '');
  }

  const experience = [];
  for (const group of resolveCollectionElements(profile['*profilePositionGroups'], map)) {
    const companyName =
      attributedText(group.companyName) ||
      (group['*company'] && map.get(group['*company'])?.name) ||
      '';
    const positions = resolveCollectionElements(group['*profilePositionInPositionGroup'], map);
    if (positions.length) {
      for (const pos of positions) {
        experience.push({
          title: attributedText(pos.title),
          company: companyName,
          dates: formatDateRange(pos.dateRange),
          _score: positionStartScore(pos),
          _current: !pos?.dateRange?.end,
        });
      }
    } else if (companyName) {
      experience.push({ title: '', company: companyName, dates: '', _score: -1, _current: false });
    }
  }
  experience.sort((a, b) => b._score - a._score);
  const current = experience.find((e) => e._current) || experience[0] || null;

  return {
    name,
    headline,
    summary,
    location,
    currentCompany: current?.company || '',
    currentTitle: current?.title || '',
    experience: experience.map(({ _score, _current, ...rest }) => rest),
  };
}

function formatEnrichedProfile(p, linkedinUrl) {
  const lines = [`LinkedIn profile: ${linkedinUrl}`, ''];
  if (p.name) lines.push(`Name: ${p.name}`);
  if (p.headline) lines.push(`Headline: ${p.headline}`);
  if (p.currentCompany) lines.push(`Current company: ${p.currentCompany}`);
  if (p.currentTitle) lines.push(`Current title: ${p.currentTitle}`);
  if (p.location) lines.push(`Location: ${p.location}`);
  if (p.summary) lines.push(`About: ${p.summary.slice(0, 600)}`);
  if (p.experience?.length) {
    lines.push('', 'Experience:');
    for (const e of p.experience.slice(0, 8)) {
      lines.push(`  • ${e.title || '—'} at ${e.company || '—'}${e.dates ? ` (${e.dates})` : ''}`);
    }
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Connection-status detection (has a sent invite been accepted?)
// ---------------------------------------------------------------------------

/**
 * Returns { ok, connected, urn } for a profile. `connected` is true when they are a
 * 1st-degree connection. Diagnostic-logged so the distance field can be confirmed/tuned.
 */
/**
 * Scan the 1st-degree connections list (the legacy identity networkinfo endpoint is
 * retired — 410). Returns a Set of lowercased publicIdentifiers; stops early if `stopAt`
 * is found. This is the one connection endpoint LinkedIn keeps alive.
 */
/** Recursively collect every `publicIdentifier` string in a response (shape-robust). */
function deepCollectPublicIds(node, out) {
  if (!node || typeof node !== 'object') return;
  const pid = node.publicIdentifier;
  if (typeof pid === 'string' && pid) out.add(pid.toLowerCase());
  for (const v of Object.values(node)) deepCollectPublicIds(v, out);
}

async function collectConnectionPublicIds(liAt, csrfToken, { maxPages = 3, stopAt = null } = {}) {
  const ids = new Set();
  const pageSize = 40;
  for (let page = 0; page < maxPages; page++) {
    let data;
    try {
      data = await fetchConnectionsPage(liAt, csrfToken, page * pageSize, pageSize);
    } catch (err) {
      if (page === 0) throw err;
      break;
    }
    const before = ids.size;
    deepCollectPublicIds(data, ids);
    const added = ids.size - before;
    if (page === 0) {
      console.log('[LinkedIn status] connections page0', { publicIdsFound: added });
    }
    if (stopAt && ids.has(stopAt)) return { ids, found: true };
    if (added === 0) break; // no (more) profiles in the response
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  return { ids, found: stopAt ? ids.has(stopAt) : false };
}

async function getConnectionDegree(liAt, csrfToken, slug) {
  const wanted = String(slug).toLowerCase();
  try {
    // On-demand single check: scan deeper until found.
    const { found } = await collectConnectionPublicIds(liAt, csrfToken, { maxPages: 25, stopAt: wanted });
    console.log('[LinkedIn status] connections-check', { slug, connected: found });
    return { ok: true, connected: found, urn: null };
  } catch (err) {
    console.error('[LinkedIn status] connections-check FAILED', { slug, err: err?.message });
    return { ok: false, error: err?.message };
  }
}

/** Recent-connections feed for the poller: the newest N connections' publicIdentifiers. */
async function getRecentConnectionIds(liAt, csrfToken, maxPages = 3) {
  try {
    const { ids } = await collectConnectionPublicIds(liAt, csrfToken, { maxPages });
    console.log('[LinkedIn status] recent connections', { count: ids.size });
    return { ok: true, ids };
  } catch (err) {
    return { ok: false, error: err?.message, ids: new Set() };
  }
}

// ---------------------------------------------------------------------------
// Conversation read (has the prospect replied? what's the last message?)
// ---------------------------------------------------------------------------

/** LinkedIn GraphQL variables encode URN special chars but keep grammar chars literal. */
function encodeUrnChars(s) {
  return String(s)
    .replace(/%/g, '%25')
    .replace(/:/g, '%3A')
    .replace(/\(/g, '%28')
    .replace(/\)/g, '%29')
    .replace(/,/g, '%2C')
    .replace(/=/g, '%3D');
}

function deepFind(obj, key, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 6) return null;
  if (key in obj) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = deepFind(v, key, depth + 1);
    if (hit) return hit;
  }
  return null;
}

const MESSENGER_MESSAGES_QUERY_IDS = [
  'messengerMessages.1561582483b8a511147478d8c099b03d',
  'messengerMessages.9501074288a12f3ae9e3c7ea243bccbf',
];
let cachedMessengerMessagesQueryId = null;

function extractMsgConversationUrn(raw) {
  const s = String(raw ?? '');
  const idx = s.indexOf('urn:li:msg_conversation:');
  if (idx < 0) return null;
  let depth = 0;
  for (let i = idx; i < s.length; i++) {
    if (s[i] === '(') depth++;
    if (s[i] === ')') {
      depth--;
      if (depth === 0) return s.slice(idx, i + 1);
    }
  }
  return null;
}

function extractConversationUrn(conv, mailboxUrn) {
  for (const raw of [conv?.entityUrn, conv?.backendUrn, conv?.conversationUrl]) {
    const urn = extractMsgConversationUrn(raw);
    if (urn) return urn;
  }
  const backend = String(conv?.backendUrn ?? conv?.entityUrn ?? '');
  const threadMatch = backend.match(/,([\w=-]+)\)?$/);
  if (threadMatch && mailboxUrn) {
    return `urn:li:msg_conversation:(${mailboxUrn},${threadMatch[1]})`;
  }
  return null;
}

function messageBodyText(message) {
  if (typeof message?.body === 'string') return message.body;
  if (message?.body?.text) return String(message.body.text);
  if (message?.attributedBody?.text) return String(message.attributedBody.text);
  return '';
}

function messageSenderUrn(message) {
  return String(
    message?.sender?.hostIdentityUrn ||
      message?.senderUrn ||
      message?.actorUrn ||
      message?.fromParticipant?.hostIdentityUrn ||
      '',
  );
}

function summarizeMessageElements(elements, prospectId) {
  const sorted = [...(Array.isArray(elements) ? elements : [])].sort(
    (a, b) => (Number(a?.deliveredAt) || 0) - (Number(b?.deliveredAt) || 0),
  );
  const prospectTexts = [];
  const thread = [];
  let lastMessage = '';
  let lastFromProspect = false;
  for (const message of sorted) {
    const text = messageBodyText(message).trim();
    if (!text) continue;
    const senderUrn = messageSenderUrn(message);
    const fromProspect = senderUrn.includes(prospectId);
    thread.push({
      from: fromProspect ? 'prospect' : 'me',
      text,
      at: Number(message?.deliveredAt) || null,
    });
    lastMessage = text;
    lastFromProspect = fromProspect;
    if (fromProspect) prospectTexts.push(text);
  }
  return {
    lastMessage,
    lastFromProspect,
    prospectTexts,
    thread,
    messageCount: thread.length,
  };
}

async function fetchConversationMessages(liAt, csrfToken, conversationUrn) {
  const queryIds = [
    cachedMessengerMessagesQueryId,
    ...MESSENGER_MESSAGES_QUERY_IDS,
  ].filter(Boolean);
  const seen = new Set();
  const vars = `(conversationUrn:${encodeUrnChars(conversationUrn)},count:20)`;

  for (const queryId of queryIds) {
    if (seen.has(queryId)) continue;
    seen.add(queryId);
    const path =
      `/voyagerMessagingGraphQL/graphql?queryId=${queryId}` + `&variables=${vars}`;
    const res = await voyagerFetchRaw(liAt, csrfToken, 'GET', path, undefined, {
      accept: 'application/graphql',
    });
    if (!res.ok) continue;

    const bucket =
      deepFind(res.data, 'messengerMessagesByConversation') ||
      res.data?.data?.messengerMessagesByConversation;
    const elements = bucket?.elements || deepFind(bucket, 'elements') || [];
    if (!Array.isArray(elements) || elements.length === 0) continue;

    cachedMessengerMessagesQueryId = queryId;
    return { ok: true, elements, queryId };
  }

  return { ok: false, error: 'Could not load conversation messages (queryId may have rotated).' };
}

/**
 * Summarize the conversation with a given profile URN: whether a thread exists,
 * the last message text, and whether it came from the prospect (a reply).
 * Diagnostic-logged so the messenger GraphQL shape can be confirmed/tuned.
 */
async function getConversationSummary(liAt, csrfToken, mailboxUrn, profileUrn) {
  const vars =
    `(query:(predicateUnions:List((conversationCategoryPredicate:(category:INBOX)))),` +
    `count:20,mailboxUrn:${encodeUrnChars(mailboxUrn)})`;
  const path =
    `/voyagerMessagingGraphQL/graphql?queryId=messengerConversations.9501074288a12f3ae9e3c7ea243bccbf` +
    `&variables=${vars}`;
  const res = await voyagerFetchRaw(liAt, csrfToken, 'GET', path, undefined, {
    accept: 'application/json',
  });
  if (!res.ok) {
    console.error('[LinkedIn status] inbox FAILED', { status: res.status, err: (res.errorText || '').slice(0, 160) });
    return { ok: false, status: res.status };
  }

  const elements = deepFind(res.data, '*elements') || deepFind(res.data, 'elements') || [];
  const wanted = String(profileUrn).split(':').pop();
  let match = null;
  for (const conv of Array.isArray(elements) ? elements : []) {
    if (JSON.stringify(conv).includes(wanted)) {
      match = conv;
      break;
    }
  }
  const conversationUrn = match ? extractConversationUrn(match, mailboxUrn) : null;
  console.log('[LinkedIn status] inbox', {
    ok: true,
    conversations: Array.isArray(elements) ? elements.length : 0,
    matchedProspect: !!match,
    conversationUrn: conversationUrn ? conversationUrn.slice(0, 72) + '…' : null,
    convKeys: match ? Object.keys(match).slice(0, 16) : null,
  });

  if (!match) return { ok: true, hasThread: false };

  const wantedShort = String(wanted);
  let lastMessage = '';
  let lastProspectMessage = '';
  let lastFromProspect = false;
  let prospectTexts = [];
  let thread = [];
  let messageCount = 0;
  let messagesQueryId = null;
  let messagesError = null;

  if (conversationUrn) {
    const fetched = await fetchConversationMessages(liAt, csrfToken, conversationUrn);
    if (fetched.ok) {
      const summary = summarizeMessageElements(fetched.elements, wantedShort);
      lastMessage = summary.lastMessage;
      lastProspectMessage = summary.prospectTexts.length
        ? summary.prospectTexts[summary.prospectTexts.length - 1]
        : '';
      lastFromProspect = summary.lastFromProspect;
      prospectTexts = summary.prospectTexts;
      thread = summary.thread;
      messageCount = summary.messageCount;
      messagesQueryId = fetched.queryId;
    } else {
      messagesError = fetched.error;
    }
  }

  if (!messageCount) {
    const preview =
      match.descriptionText?.text ??
      match.descriptionText ??
      deepFind(match, 'descriptionText') ??
      '';
    if (preview) lastMessage = String(preview);
    const unread = Number(match.unreadCount ?? 0);
    if (unread > 0 && preview && !lastProspectMessage) {
      lastProspectMessage = String(preview);
    }
  }

  const repliedByProspect = prospectTexts.length > 0;

  console.log('[LinkedIn status] inbox messages', {
    messageCount,
    prospectMessageCount: prospectTexts.length,
    replied: repliedByProspect,
    messagesQueryId,
    messagesError,
    lastProspectPreview: lastProspectMessage ? String(lastProspectMessage).slice(0, 60) : null,
  });

  return {
    ok: true,
    hasThread: true,
    lastMessage: String(lastMessage).slice(0, 400),
    lastProspectMessage: String(lastProspectMessage).slice(0, 400),
    repliedByProspect,
    lastFromProspect,
    prospectMessageCount: prospectTexts.length,
    messageCount,
    thread,
    messagesError,
  };
}

async function runAgentLinkedInTool(toolName, input, cookies) {
  const { liAt, csrfToken } = cookies;

  if (toolName === 'linkedin_list_connections') {
    try {
      const keywords = Array.isArray(input.keywords)
        ? input.keywords
        : typeof input.keywords === 'string'
          ? input.keywords.split(/[,;]+/).map((s) => s.trim()).filter(Boolean)
          : [];
      const maxPages = Number(input.max_pages) || 5;

      // Fast path: the Voyager connections API via the webview — paginated JSON, no DOM
      // scrolling. This is what fixes the timeout; the DOM scan below is a fallback.
      try {
        const apiResult = await listConnectionsFiltered(liAt, csrfToken, {
          keywords,
          max_results: input.max_results,
          max_scan: input.max_scan ?? maxPages * 40,
          start: input.start,
        });
        if (apiResult.ok && apiResult.scannedCount > 0) {
          console.log(
            `[LinkedIn connections] API scanned ${apiResult.scannedCount}, matched ${apiResult.matchCount}`,
          );
          return apiResult;
        }
        console.warn('[LinkedIn connections] API returned no rows — falling back to DOM scan.');
      } catch (err) {
        console.error('[LinkedIn connections] API path failed, falling back to DOM scan:', err?.message);
      }

      // Fallback: DOM scan of the connections page.
      return await connectionsScanInTab({
        keywords,
        max_results: input.max_results,
        max_pages: maxPages,
        start: input.start,
        page_delay_ms: input.page_delay_ms ?? 1500,
        csrfToken,
      });
    } catch (err) {
      return {
        ok: false,
        error: err.message ?? String(err),
      };
    }
  }

  let slug;
  try {
    slug = extractSlug(input.linkedin_url);
  } catch (err) {
    return { ok: false, error: err.message };
  }

  try {
    switch (toolName) {
      case 'linkedin_connect': {
        const urn = await resolveProfileUrn(liAt, csrfToken, slug);
        await sendConnectionRequest(liAt, csrfToken, urn, input.note ?? '');
        return { ok: true, slug, profileUrn: urn };
      }
      case 'linkedin_message': {
        const urn = await resolveProfileUrn(liAt, csrfToken, slug);
        await sendDirectMessage(liAt, csrfToken, urn, input.message);
        return { ok: true, slug, profileUrn: urn };
      }
      case 'linkedin_follow': {
        const urn = await resolveProfileUrn(liAt, csrfToken, slug);
        await followMember(liAt, csrfToken, urn);
        return { ok: true, slug, profileUrn: urn };
      }
      case 'linkedin_endorse': {
        const urn = await resolveProfileUrn(liAt, csrfToken, slug);
        await endorseSkill(liAt, csrfToken, urn, input.skill);
        return { ok: true, slug, profileUrn: urn };
      }
      case 'linkedin_contact_info': {
        const contactInfo = await fetchContactInfo(liAt, csrfToken, slug);
        return { ok: true, slug, contactInfo };
      }
      case 'linkedin_status': {
        const urn = await resolveProfileUrn(liAt, csrfToken, slug);
        const [degree, mailboxUrn] = await Promise.all([
          getConnectionDegree(liAt, csrfToken, slug),
          getMyProfileUrn(liAt, csrfToken).catch(() => null),
        ]);
        let conversation = { hasThread: false };
        if (mailboxUrn) {
          try {
            conversation = await getConversationSummary(liAt, csrfToken, mailboxUrn, urn);
          } catch (err) {
            conversation = { ok: false, error: err.message };
          }
        }
        return {
          ok: true,
          slug,
          profileUrn: urn,
          connected: degree?.connected ?? false,
          conversation,
        };
      }
      case 'linkedin_enrich': {
        const res = await fetchFullProfile(liAt, csrfToken, slug);
        console.log('[LinkedIn enrich] fetch', {
          slug,
          ok: res.ok,
          status: res.status,
          includedLen: res.data?.included?.length ?? 0,
          err: (res.errorText || '').slice(0, 140),
        });
        if (!res.ok) {
          return {
            ok: false,
            slug,
            status: res.status,
            error: `Profile fetch failed (${res.status})`,
            errorText: res.errorText,
          };
        }
        const profile = parseFullProfile(res.data);
        if (!profile || (!profile.name && !profile.headline)) {
          console.warn('[LinkedIn enrich] parsed nothing usable', { slug });
          return { ok: false, slug, error: 'Could not parse profile data from LinkedIn.' };
        }
        console.log('[LinkedIn enrich] parsed', {
          name: profile.name,
          company: profile.currentCompany,
          experience: profile.experience.length,
        });
        const enriched = formatEnrichedProfile(profile, `https://www.linkedin.com/in/${slug}`);
        return { ok: true, slug, profile, enriched };
      }
      default:
        return { ok: false, error: `Unknown LinkedIn tool: ${toolName}` };
    }
  } catch (err) {
    return voyagerFailure(err, slug);
  }
}

export {
  runAgentLinkedInTool,
  getConnectionDegree,
  getRecentConnectionIds,
  resolveProfileUrn,
  getMyProfileUrn,
  getConversationSummary,
};
