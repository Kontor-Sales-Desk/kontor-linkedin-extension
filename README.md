# Kontor for LinkedIn — Chrome Extension

Open-source Chrome extension that connects your **real LinkedIn session** in Chrome to the [Kontor](https://getkontor.eu) web desk. Download and install steps: [getkontor.eu/support-software](https://getkontor.eu/support-software).

This is a parallel local executor to the Electron built-in browser. The Supabase agent, delegation protocol, and CRM stay unchanged.

## What it does

- **Passive context** — scrapes the LinkedIn page you're viewing (profile, search, messages) for the sales agent
- **Agent tools** — `linkedin_connect`, `linkedin_message`, `linkedin_enrich`, `linkedin_status`, and the rest of the Voyager tool set
- **Admin bridge** — exposes the same API surface as `window.salesDesktop` on your admin origin

## Install

### Option A — Load unpacked (best for dev)

No zip needed. Chrome reads the folder directly.

1. Open Chrome → [`chrome://extensions`](chrome://extensions)
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `chrome-extension/` folder in this repo
5. Pin the extension if you want — optional but handy

Updates after code changes: click the **reload** icon on the extension card in `chrome://extensions`.

### Option B — Pack a zip (share / backup)

From the repo:

```bash
cd chrome-extension
npm run pack
```

Creates `chrome-extension/dist/cold-sales-engine-linkedin-v0.2.0.zip`.

To install from the zip:

1. Unzip somewhere permanent (e.g. `~/Extensions/cold-sales-engine-linkedin/`)
2. `chrome://extensions` → **Load unpacked** → select that folder

(Unzipping alone is not enough — Chrome always installs unpacked folders or store CRXs, not raw zips.)

### Option C — Pack a `.crx` (single file install)

1. `chrome://extensions` → **Pack extension**
2. **Extension root directory:** `chrome-extension/`
3. **Private key:** leave empty the first time — Chrome creates `chrome-extension.pem`
4. Keep the `.pem` file safe; reuse it for updates so the extension ID stays the same

Install the `.crx` by dragging it onto `chrome://extensions` (Developer mode required unless published to the Web Store).

### After install

1. Open `http://localhost:3000/admin/sales/` (add your production URL to `manifest.json` first)
2. Open [linkedin.com](https://www.linkedin.com) in the **same browser profile** and sign in
3. Connect the admin backend — credentials sync to the extension automatically
4. Integrations → LinkedIn should show **Connected**

### Brave / Opera troubleshooting

If Integrations stays on **Extension** or PING times out:

1. **Reload the extension** at `brave://extensions` or `opera://extensions`
2. **Grant site access** — extension details → “Site access” → allow `localhost:3000` (or “On all sites” for dev)
3. **Set extension ID in the web app** — copy the ID from the extensions page, add to repo root `.env.local`:
   ```bash
   NEXT_PUBLIC_SALES_EXTENSION_ID=your-extension-id-here
   ```
   Restart `npm run dev`. The admin page talks to the extension via `chrome.runtime.sendMessage` (no content-script relay required).
4. Hard-refresh the admin tab (`Cmd+Shift+R`)

Quick console check (admin tab):

```js
localStorage.getItem('scc-extension-id')  // should be your extension ID
chrome.runtime.sendMessage(
  localStorage.getItem('scc-extension-id'),
  { channel: 'scc-ext:admin-request', id: 'ping', type: 'PING', payload: {} },
  (r) => console.log(r, chrome.runtime.lastError),
);
// expect: { id: 'ping', ok: true, result: { version: '0.2.4', ready: true } }
```

## Background workers (v0.2.0)

After the admin page syncs credentials (`registerConnection`), the extension runs:

| Worker | Interval | Gate |
|--------|----------|------|
| **Outreach queue** | 5 min | `outreach_send_mode === auto` only |
| **DM sync queue** | 5 min idle / 90s when queued | Admin or LinkedIn window focused |

Credentials are pushed from the web admin automatically when you connect (stored in `chrome.storage.local` — same trust model as web localStorage).

Manual **Sync LI** and **search scrape** work via `syncLinkedInNow` / `scrapeLinkedInSearch` on the extension API.

## Production admin URL

Before publishing, add your admin host to:

- `manifest.json` → `host_permissions` and both `content_scripts` entries for `admin-bridge.js`
- `shared/config.js` → `ADMIN_ORIGIN_PATTERNS` (documentation)

## Architecture

```
Admin page (React)
  ↔ admin-bridge.js (content script)
  ↔ service-worker.js
  ↔ linkedin-page.js + linkedin-extractor.js (on linkedin.com)
  ↔ Voyager API via fetch('/voyager/api/...') in the user's tab
```

Voyager orchestration is ported from `electron/browser/linkedinVoyager.cjs`.

## Open source

This folder is designed to be split into its own public repository when ready:

- MIT licensed (`LICENSE`)
- No secrets — cookies never leave the browser
- Self-contained MV3 extension

## Status (v0.2.0)

| Feature | Status |
|---------|--------|
| LinkedIn context for chat | ✅ |
| All 8 agent Voyager tools | ✅ (ported from Electron) |
| Prospect status in UI | ✅ |
| Queue/sync background workers | ✅ |
| Manual sync + search scrape | ✅ |
| Chrome Web Store listing | 🔜 |

## Electron coexistence

If the desktop app is open, Electron wins (`window.salesDesktop` takes priority). The extension activates for **web-only** usage.

## License

MIT — see [LICENSE](./LICENSE).
