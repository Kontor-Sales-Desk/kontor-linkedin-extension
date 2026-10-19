import { getConnection, getAdminSecret } from './credentials.js';

export async function invokeScheduler(body) {
  const connection = getConnection();
  const adminSecret = getAdminSecret();
  if (!connection?.supabaseUrl || !connection.supabaseAnonKey || !connection.siteId || !adminSecret) {
    return { success: false, error: 'Backend not configured in extension' };
  }

  const res = await fetch(`${connection.supabaseUrl}/functions/v1/site-sales-scheduler`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-secret': adminSecret,
      apikey: connection.supabaseAnonKey,
    },
    body: JSON.stringify({ siteId: connection.siteId, ...body }),
  });

  return res.json().catch(() => ({ success: false, error: 'Invalid scheduler response' }));
}
