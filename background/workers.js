import { loadStoredCredentials, isBackendConfigured, getConnection, getLinkedInEnabled } from './credentials.js';
import { startOutreachQueueWorker, stopOutreachQueueWorker } from './queue-worker.js';
import { startSyncQueueWorker, stopSyncQueueWorker } from './sync-queue-worker.js';

let workersStarted = false;

export function refreshBackgroundWorkers() {
  if (!isBackendConfigured()) {
    stopOutreachQueueWorker();
    stopSyncQueueWorker();
    workersStarted = false;
    return;
  }

  const siteId = getConnection()?.siteId;
  if (!getLinkedInEnabled(siteId)) {
    stopOutreachQueueWorker();
    stopSyncQueueWorker();
    workersStarted = false;
    return;
  }

  startWorkersIfNeeded();
}

export async function initBackgroundWorkers() {
  await loadStoredCredentials();
  refreshBackgroundWorkers();
}

export function startWorkersIfNeeded() {
  if (workersStarted) return;
  if (!isBackendConfigured()) return;
  const siteId = getConnection()?.siteId;
  if (!getLinkedInEnabled(siteId)) return;
  workersStarted = true;
  startOutreachQueueWorker();
  startSyncQueueWorker();
}

export function onCredentialsUpdated() {
  refreshBackgroundWorkers();
}
