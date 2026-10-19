import { invokeScheduler } from './scheduler-client.js';
import { getConnection, getSendMode, getLinkedInEnabled, getLinkedInAutomationEnabled, isBackendConfigured } from './credentials.js';
import { getSessionCookies } from './session.js';
import { runAgentLinkedInTool } from './linkedin-voyager-core.js';

const POLL_MS = 5 * 60 * 1000;
const STARTUP_DELAY_MS = 45 * 1000;
const BETWEEN_ACTIONS_MS = { min: 45_000, max: 120_000 };

let timer = null;
let running = false;

function randomDelayMs() {
  const span = BETWEEN_ACTIONS_MS.max - BETWEEN_ACTIONS_MS.min;
  return BETWEEN_ACTIONS_MS.min + Math.floor(Math.random() * span);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildToolInput(item) {
  const prospect = item.sales_prospects ?? {};
  const linkedinUrl = String(prospect.linkedin_url ?? '').trim();
  const base = {
    linkedin_url: linkedinUrl,
    prospect_id: item.prospect_id,
  };

  switch (item.action_type) {
    case 'linkedin_connect':
      return { ...base, note: String(item.body ?? item.subject ?? '').slice(0, 300) };
    case 'linkedin_message':
      return { ...base, message: String(item.body ?? '').slice(0, 1900) };
    case 'linkedin_endorse':
      return { ...base, skill: String(item.subject ?? item.body ?? '').trim() };
    case 'linkedin_follow':
    default:
      return base;
  }
}

async function processTick() {
  if (running) return;
  running = true;

  try {
    if (!isBackendConfigured()) return;

    const connection = getConnection();
    const sendMode = getSendMode(connection?.siteId);
    if (!getLinkedInAutomationEnabled(connection?.siteId)) return;
    if (sendMode !== 'auto') return;
    if (!getLinkedInEnabled(connection?.siteId)) return;

    const cookies = await getSessionCookies();
    if (!cookies) return;

    const claimed = await invokeScheduler({
      action: 'claimLinkedInQueue',
      limit: 1,
    });

    if (!claimed?.success || !Array.isArray(claimed.items) || claimed.items.length === 0) {
      return;
    }

    for (let i = 0; i < claimed.items.length; i++) {
      if (i > 0) await sleep(randomDelayMs());

      const item = claimed.items[i];
      const toolInput = buildToolInput(item);
      let outcome;

      try {
        outcome = await runAgentLinkedInTool(item.action_type, toolInput, cookies);
      } catch (err) {
        outcome = { ok: false, error: err?.message ?? String(err) };
      }

      await invokeScheduler({
        action: 'finishLinkedInItem',
        itemId: item.id,
        success: outcome.ok === true,
        error: outcome.error ?? outcome.errorText ?? '',
        outcome,
      });
    }
  } catch (err) {
    console.warn('[SCC ext] LinkedIn outreach queue:', err?.message ?? err);
  } finally {
    running = false;
  }
}

export function startOutreachQueueWorker() {
  if (timer) return;

  setTimeout(() => {
    void processTick();
  }, STARTUP_DELAY_MS);

  timer = setInterval(() => {
    void processTick();
  }, POLL_MS);

  console.log('[SCC ext] Outreach queue worker started (5 min, auto mode only)');
}

export function stopOutreachQueueWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export { processTick as processOutreachQueueTick };
