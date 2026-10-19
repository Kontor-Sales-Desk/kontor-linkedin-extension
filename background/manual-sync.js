import { invokeScheduler } from './scheduler-client.js';
import { isBackendConfigured } from './credentials.js';
import { getSessionCookies } from './session.js';
import {
  getRecentConnectionIds,
  resolveProfileUrn,
  getMyProfileUrn,
  getConversationSummary,
} from './linkedin-voyager-core.js';

const BETWEEN_CHECKS_MS = { min: 8_000, max: 20_000 };
const MAX_CONNECT_PER_CYCLE = 20;
const MAX_REPLY_PER_CYCLE = 10;

let running = false;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs() {
  const span = BETWEEN_CHECKS_MS.max - BETWEEN_CHECKS_MS.min;
  return BETWEEN_CHECKS_MS.min + Math.floor(Math.random() * span);
}

function extractSlug(url) {
  const m = String(url).match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? m[1] : null;
}

async function checkConnections(cookies) {
  const claimed = await invokeScheduler({
    action: 'linkedinMonitorTargets',
    limit: MAX_CONNECT_PER_CYCLE,
  });
  if (!claimed?.success) {
    return { accepted: 0, error: claimed?.error ?? 'linkedinMonitorTargets failed' };
  }
  const targets = Array.isArray(claimed?.targets) ? claimed.targets : [];
  if (!targets.length) return { accepted: 0 };

  const set = await getRecentConnectionIds(cookies.liAt, cookies.csrfToken, 3);
  if (!set.ok) {
    return { accepted: 0, error: set.error ?? 'could not read connections' };
  }

  let accepted = 0;
  for (const target of targets) {
    const slug = extractSlug(target.linkedin_url);
    if (!slug || !set.ids.has(slug.toLowerCase())) continue;
    const res = await invokeScheduler({
      action: 'recordLinkedinConnection',
      prospectId: target.id,
    });
    if (res?.success && res.changed) accepted += 1;
  }
  return { accepted };
}

async function checkReplies(cookies) {
  const claimed = await invokeScheduler({
    action: 'linkedinReplyMonitorTargets',
    limit: MAX_REPLY_PER_CYCLE,
  });
  if (!claimed?.success) {
    return { recorded: 0, error: claimed?.error ?? 'linkedinReplyMonitorTargets failed' };
  }
  const targets = Array.isArray(claimed?.targets) ? claimed.targets : [];
  if (!targets.length) return { recorded: 0 };

  let mailbox;
  try {
    mailbox = await getMyProfileUrn(cookies.liAt, cookies.csrfToken);
  } catch (err) {
    return { recorded: 0, error: err?.message ?? String(err) };
  }
  if (!mailbox) {
    return { recorded: 0, error: 'mailbox urn unavailable' };
  }

  let recorded = 0;
  for (let i = 0; i < targets.length; i++) {
    if (i > 0) await sleep(randomDelayMs());
    const target = targets[i];
    const slug = extractSlug(target.linkedin_url);
    if (!slug) continue;

    let profileUrn = target.linkedin_profile_urn || null;
    if (!profileUrn) {
      try {
        profileUrn = await resolveProfileUrn(cookies.liAt, cookies.csrfToken, slug);
      } catch {
        continue;
      }
    }

    let conv;
    try {
      conv = await getConversationSummary(cookies.liAt, cookies.csrfToken, mailbox, profileUrn);
    } catch {
      continue;
    }
    if (!conv?.ok || !conv.repliedByProspect) continue;

    const message = conv.lastProspectMessage || conv.lastMessage;
    if (!message) continue;

    const res = await invokeScheduler({
      action: 'recordLinkedinReply',
      prospectId: target.id,
      message,
      thread: conv.thread,
    });
    if (res?.success && res.changed) recorded += 1;
  }
  return { recorded };
}

export async function runLinkedInManualSync() {
  if (running) {
    return { ok: false, error: 'Sync already in progress' };
  }
  running = true;

  try {
    if (!isBackendConfigured()) {
      return { ok: false, error: 'Backend not configured — open the admin and sign in.' };
    }

    const cookies = await getSessionCookies();
    if (!cookies) {
      return { ok: false, error: 'Log into LinkedIn in Chrome first.' };
    }

    const connections = await checkConnections(cookies);
    const replies = await checkReplies(cookies);

    return {
      ok: true,
      accepted: connections.accepted ?? 0,
      recorded: replies.recorded ?? 0,
      error: connections.error || replies.error || undefined,
    };
  } catch (err) {
    return { ok: false, error: err?.message ?? String(err) };
  } finally {
    running = false;
  }
}
