# Chrome Web Store listing — Arb Betting Assistant (Unlisted)

Copy/paste these into the Web Store developer dashboard when submitting. Set
**Visibility: Unlisted** so only people with the link can install. Unlisted
items are still reviewed (usually 1–3 days).

## Store listing fields

**Name:** Arb Betting Assistant

**Summary (132 char max):**
Pre-fills arbitrage bet slips across bookmaker sites from signals on your own server. You review and place every bet manually.

**Category:** Productivity

**Description:**
> Arb Betting Assistant streamlines arbitrage betting. It connects to your own
> backend server, receives parsed betting opportunities, calculates optimal
> per-leg stakes, and opens the relevant bookmaker pages with the bet slip
> pre-filled. You always review and click "Place Bet" yourself — the extension
> never places a bet automatically and never handles your passwords or logins.
>
> Access is controlled by a personal key issued by the operator. Without a
> valid key the extension cannot fetch any data.

## Privacy practices (required justifications)

Google's review form asks why each permission is needed. Use these:

- **storage** — saves your server URL and personal access key locally so you
  don't re-enter them each session.
- **tabs** — opens bookmaker bet-slip pages in new tabs as part of the
  pre-fill flow.
- **scripting** — injects the per-bookmaker content scripts that locate the
  odds and fill the stake fields.
- **alarms** — keeps the connection to your server alive / retries on wake.
- **host_permissions (bookmaker domains)** — the content scripts must read odds
  and fill bet slips on these specific betting sites.
- **host_permissions (localhost + *.onrender.com)** — the extension talks to
  your backend server (local during development, Render in production) over
  HTTP/WebSocket.

**Data usage declarations:**
- Does NOT collect or transmit personally identifiable information.
- Does NOT handle credentials/passwords (acts on already-logged-in sessions).
- The only network calls are to the operator's own backend server.
- No analytics, no third-party data sharing.

**Single purpose (required):**
> Pre-fill arbitrage bet slips on supported bookmaker sites using opportunities
> supplied by the user's own backend server.

## Onboarding a customer after publish

1. Send them the Unlisted install link.
2. Generate their key:  `cd backend && uv run python keys.py gen <name>`
   (add `--expires YYYY-MM-DD` for a subscription end date).
3. Merge the printed JSON into `EXTENSION_KEYS` in the Render dashboard, redeploy.
4. Give the customer their key + the server URL (`https://arb-nc5y.onrender.com`).
   They open the popup → settings → paste both.

## Blocking a customer

Edit `EXTENSION_KEYS` in Render: set their entry's `"active": false` (or let
`"expires"` lapse), then redeploy. Takes effect on the next request. No effect
on anyone else's key.
