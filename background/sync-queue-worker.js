import { invokeScheduler } from './scheduler-client.js';
import {
  isBackendConfigured,
  getConnection,
  getLinkedInEnabled,
  getLinkedInAutomationEnabled,
  getLinkedInAutoActions,
} from './credentials.js';
import { isSalesContextFocused } from './focus-utils.js';
import { getSessionCookies } from './session.js';
import {
  resolveProfileUrn,
  getMyProfileUrn,
  getConversationSummary,
} from './linkedin-voyager-core.js';

const POLL_FAST_MS = 90 * 1000;
const POLL_SLOW_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 45 * 1000;

let timer = null;
let running = false;

function extractSlug(url) {
  const m = String(url).match(/linkedin\.com\/in\/([^/?#\s]+)/i);
  return m ? m[1] : null;
}

async function syncProspectDm(cookies, item) {
  const prospect = item.sales_prospects ?? {};
  const slug = extractSlug(prospect.linkedin_url);
  if (!slug) {
    return { ok: false, error: 'missing linkedin_url' };
  }

  let profileUrn = prospect.linkedin_profile_urn || null;
  if (!profileUrn) {
    profileUrn = await resolveProfileUrn(cookies.liAt, cookies.csrfToken, slug);
  }
  if (!profileUrn) {
    return { ok: false, error: 'could not resolve profile urn' };
  }

  const mailbox = await getMyProfileUrn(cookies.liAt, cookies.csrfToken);
  if (!mailbox) {
    return { ok: false, error: 'could not read mailbox urn' };
  }

  const conv = await getConversationSummary(
    cookies.liAt,
    cookies.csrfToken,
    mailbox,
    profileUrn,
  );
  if (!conv?.ok) {
    return { ok: false, error: conv?.error || `inbox status ${conv?.status ?? 'unknown'}` };
  }

  if (!conv.repliedByProspect) {
    return { ok: true, changed: false, note: 'no_prospect_reply_yet' };
  }

  const message = conv.lastProspectMessage || conv.lastMessage;
  if (!message) {
    return { ok: true, changed: false, note: 'empty_thread' };
  }

  const res = await invokeScheduler({
    action: 'recordLinkedinReply',
    prospectId: item.prospect_id,
    message,
    thread: conv.thread,
  });

  return {
    ok: res?.success === true,
    changed: Boolean(res?.changed),
    error: res?.error,
  };
}

async function processTick() {
  if (running) return;
  running = true;

  let hadQueueItems = false;

  try {
    if (!(await isSalesContextFocused())) return;
    if (!isBackendConfigured()) return;

    const connection = getConnection();
    if (!getLinkedInEnabled(connection?.siteId)) return;

    // Unattended Voyager reads are opt-in: automation master + inbox sync toggle.
    if (!getLinkedInAutomationEnabled(connection?.siteId)) return;
    if (getLinkedInAutoActions(connection?.siteId).inbox_sync !== true) return;

    const cookies = await getSessionCookies();
    if (!cookies) return;

    const claimed = await invokeScheduler({
      action: 'claimLinkedinSyncQueue',
      limit: 1,
    });
    if (!claimed?.success || !Array.isArray(claimed.items) || claimed.items.length === 0) {
      return;
    }

    hadQueueItems = true;

    for (const item of claimed.items) {
      let outcome;
      try {
        outcome = await syncProspectDm(cookies, item);
      } catch (err) {
        outcome = { ok: false, error: err?.message ?? String(err) };
      }

      await invokeScheduler({
        action: 'finishLinkedinSyncItem',
        itemId: item.id,
        success: outcome.ok === true,
        error: outcome.error ?? outcome.note ?? '',
      });

      if (outcome.changed) {
        const label =
          item.sales_prospects?.contact_name ||
          item.sales_prospects?.company_name ||
          'prospect';
        console.log(`[SCC ext] sync queue recorded reply for ${label}`);
      }
    }
  } catch (err) {
    console.warn('[SCC ext] LinkedIn sync queue:', err?.message ?? err);
  } finally {
    running = false;
    scheduleNext(hadQueueItems ? POLL_FAST_MS : POLL_SLOW_MS);
  }
}

function scheduleNext(delayMs) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    void processTick();
  }, delayMs);
}

export function startSyncQueueWorker() {
  if (timer) return;

  setTimeout(() => {
    void processTick();
  }, STARTUP_DELAY_MS);

  console.log(
    '[SCC ext] Sync queue worker started (admin/LI focused; 5 min idle / 90s when queued)',
  );
}

export function stopSyncQueueWorker() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

export { processTick as processSyncQueueTick };
