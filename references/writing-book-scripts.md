# Writing Content Scripts for New Bookmakers

Living reference for adding a new book to the Chrome extension. Distilled from [cloudbet.js](../content-scripts/cloudbet.js) and [roobet.js](../content-scripts/roobet.js). **Update this file whenever you learn something non-obvious while shipping a new book.** "Non-obvious" means: a gotcha you'd want to warn the next person about, a pattern that broke and had to be rewritten, or a selector convention that only becomes visible after you use the site live.

---

## What a book script must do

Given a `betData` object from the backend (see `backend/parser.py` for shape), the content script automates the bet slip up to — but not including — the final "Place Bet" click. Two phases, driven by URL:

1. **`search`** on the book's landing/sports page → fill the search box, navigate to the event page.
2. **`fill`** on the event page → locate the right market + selection, click the odds button, fill the stake, show a completion toast.

State is handed across the navigation through `chrome.storage.local` under a per-book key (e.g. `cloudbetState`, `roobetState`).

---

## The adapter pattern

All shared mechanics — state machine, logging/STATUS_UPDATE, React-input filling, slip-open recovery, completion toast, `sleep`/`waitFor` — live in [lib/runner.js](../lib/runner.js). Each book is a small **adapter** that fills in the site-specific holes:

```js
(() => {
  const { sleep, waitFor, lastWord } = window.__arb;

  __arb.run({
    book: 'mybook',
    stateKey: 'mybookState',

    isLandingPage: (path) => /landing-regex/.test(path),
    isEventPage:   (path) => /event-regex/.test(path),

    getRoot:           () => document,                  // or shadow root
    findSearchInput:   (root) => root.querySelector(...),
    findEventResult:   (root, event) => Element | null, // a result element to click/follow
    navigateToEvent:   async (result, event) => { window.location.href = result.href; },

    marketLabel:       (market) => 'Match Result' | null,
    findMarketSection: (root, label, market) => Element | null,
    findOddsButton:    (section, betData, leg, rowLabel) => Element | null,

    findStakeInput:    (root) => root.querySelector(...),

    // Optional hooks (omit if not needed):
    searchSettleMs,                          // pause after fillInput on the search box
    beforeFindMarket(root, ctx),             // e.g. click an "ALL" tab first
    openSlipPanel(root),                     // returns toggle Element if slip is collapsible
    allowReclick,                            // re-click odds once if slip stays empty
    currencySettleMs,                        // pause before filling stake
    clearStakeFirst,                         // two-pass clear-then-fill the stake input
    findHighlightTarget(root),               // element to outline green
    placeBetLabel,                           // label shown in the completion toast
    doneMessage,                             // override the default toast text
    detectCurrency(root),                    // optional: read on-page currency ("JPY"/"USD") for the safety guard
  });
})();
```

The runner only enters one of `doSearch` or `doFill` per page load, decided from `phase` + URL. On error it logs an `error` STATUS_UPDATE and clears `stateKey` so the queue can advance.

The runner exposes helpers on `window.__arb` (`sleep`, `waitFor`, `fillInput`, `lastWord`, `rowLabelFor`) — pull what you need at the top of the adapter.

---

## Non-negotiable patterns

The runner already handles items 1, 2, 3, 7, 8, 9, 10 below — listed here so you know what *not* to re-implement and why.

### 1. React-controlled input filling — *runner*

Plain `input.value = '123'` is silently ignored by React. The runner's `fillInput` uses the native setter + a bubbling `input` event. The two-pass clear-then-fill variant (`clearStakeFirst: true`) is needed when the slip may retain a previous stake — without clearing, the setter call gets appended to React's internal state ("848" + "333" → "848333").

The same native-setter + `input`-event approach works for **Svelte** `bind:value` inputs too (Stake uses Svelte). No adapter-level change needed.

### 2. Odds buttons are toggles — click once — *runner*

Clicking a second time removes the bet. The runner clicks once, then polls for the **next** signal (stake input appearing) with a long timeout. Never retry-click in your adapter.

**Exception:** if the slip stays empty after the long poll *and* after toggling the panel open (3 attempts), the runner re-clicks once more if `allowReclick: true`. Only set this when you've confirmed the slip is genuinely empty at that point (e.g. Cloudbet: ~19 s of failed stake-0 polls + successful panel toggle).

**Other exception — `btn.click()` is silently dropped:** Stake's Svelte
outcome handler ignored plain `btn.click()` from the content-script flow.
The fix is to override `btn.click` in `findOddsButton` so it dispatches the
full pointer sequence (`pointerdown` → `mousedown` → `pointerup` → `mouseup`
→ `click`) after a short hydration-settle delay, with a self-check to re-fire
once if `.selected` didn't appear. See `wrapWithFullClick` in
[stake.js](../content-scripts/stake.js) for the working pattern. **Try plain
`click()` first; only adopt this if the runner reports the click but no slip
state changes.**

### 3. Background-tab throttling is real — *runner*

Chrome clamps timers to ~1 Hz and pauses `requestAnimationFrame` in background tabs. The service worker opens tabs **active: true** and runs books **sequentially** ([service-worker.js](../background/service-worker.js)). The runner's stake-input poll budgets ~10 s.

### 4. Don't walk fixed parent-chains — *adapter responsibility*

`el.parentElement.parentElement.parentElement…` breaks the first time the site adds a wrapper div. Use **structural predicates**:

- Cloudbet: smallest element containing ≥ N odds buttons (`findOddsSection`).
- Roobet: walk up until you hit a node with the `[title, odds]` two-child shape (`findMarketSection`).

Prefer a labelled section first, then fall back to "smallest element with N odds buttons" so a heading rename doesn't take everything out.

### 5. Match by semantic content, not position — *adapter responsibility*

Sites reorder columns. Don't rely on `children[2]` being the Winner column.

- Cloudbet uses **spatial lookup**: find the column header and the row label, then click the odds-button whose bounding-rect center is closest to `(colX, rowY)`.
- Roobet matches the **last word of the row label** inside the button's text (buttons render as "<team><odds>", e.g. "Buffalo Sabres1.65").

Pick whichever suits the site's DOM.

### 6. Team name matching uses the last word — *runner helper, use it in adapter*

Search results and event-page labels often abbreviate team names ("Buffalo Sabres" → "BUF Sabres"). The runner exposes `lastWord(name)`. Use it for (a) the search query (the runner does this automatically — it tries `team2`'s token first, then falls back to `team1`'s; see the gotcha row below), and (b) the row-label match in `findOddsButton` / `findEventResult`.

### 7. Full-page navigation, not SPA pushState — *adapter responsibility*

After finding the event result, do `window.location.href = url` from `navigateToEvent` (Cloudbet), or click + poll for URL change + `window.location.reload()` (Roobet). SPA-internal navigation sometimes fails to trigger the event-page render path.

### 8. Persist state across navigation — *runner*

The runner writes `{ phase: 'fill', betData }` to `chrome.storage.local[stateKey]` immediately before calling `navigateToEvent`, and clears it at the end of `doFill` and in the error handler. Your adapter never touches storage directly.

### 9. STATUS_UPDATE to the popup — *runner*

The runner logs every step via `STATUS_UPDATE` with `{ book, status, message }`. The popup routes these back to the right leg card and the service worker advances the queue on `done`/`error`. Your adapter has no logging concerns; throwing or returning normally is enough.

### 10. Entry point routes by URL — *runner, via adapter predicates*

Your adapter provides `isLandingPage(path)` and `isEventPage(path)`; the runner reads `window.location.pathname` and picks the phase. If both predicates can match the same URL, define them so `isEventPage` is strictly more specific.

---

### 11. Currency conversion + the fill-time guard — *runner + optional adapter hook*

The popup converts each leg's JPY stake into the book's **configured** currency
before dispatch (per-book dropdown in settings, default JPY). The leg the runner
receives therefore carries three fields:

- `leg.stake` — the number to TYPE, already in the book's currency.
- `leg.stake_jpy` — the JPY-equivalent (reference only; don't type this).
- `leg.currency` — `"JPY"` or `"USD"`, the **expected** on-page currency.

The runner fills `leg.stake` as-is (rounding only for JPY). Before filling, it
runs a **currency guard** to prevent the catastrophic ~150x over-bet of typing a
JPY number into a USD field: if the adapter provides `detectCurrency(root)`, the
runner calls it, compares the returned currency against `leg.currency`, and
**aborts the leg** on mismatch. If the adapter has no `detectCurrency` (most
don't yet), the runner logs a `[ARB-<book>] … currency guard unenforced` warning
and proceeds. Add a `detectCurrency` returning the book's on-page currency
string (e.g. read the bet-slip's currency label/symbol) when you want the guard
enforced for a book. Return `null`/unknown to fall back to the unenforced path.

## Site-specific quirks to check for

When exploring a new book, investigate these upfront — they're the things that have bitten us. Most map to a single adapter field.

| Quirk | How to detect | Adapter setting |
|---|---|---|
| **Shadow DOM** | `document.querySelector(...)` returns `null` for visible elements | `getRoot: () => host.shadowRoot`. Every adapter callback uses the root passed in. (Roobet.) |
| **CSS-module class churn** | Class names look like `bt356`, change between visits | Use stable prefixes (`sc-*`, `data-test-id="..."`). `[class*="stable-prefix"]` attribute-contains selectors. On BetTarget/sptpub (Roobet, Betfury), `sc-7elhv3-0` = outcome plate container, `sc-7elhv3-1` = clickable odds button — stable across deployments. |
| **Currency auto-conversion** | Stake input accepts number but multiplies by ~150× | `currencySettleMs: 1500`. Runner pauses, re-queries the input, then fills. (Cloudbet.) |
| **Collapsed bet slip** | Odds click succeeds but no stake input appears | `openSlipPanel: (root) => toggleButton`. Runner clicks it and re-polls (up to 3 attempts). |
| **Empty slip after odds click** | Slip opens but contains no item | `allowReclick: true`. Runner re-clicks the odds button once as a final recovery. |
| **Stake input retains previous value** | Stake fills as "848333" instead of "333" | `clearStakeFirst: true`. Runner does a two-pass clear-then-fill. |
| **Search results need settle time** | Result card not in DOM immediately after search input fills | `searchSettleMs: 1500`. Runner pauses before polling for results. |
| **Markets hidden behind category tabs** | Section title text not in DOM | `beforeFindMarket: async (root) => { allTab.click(); await sleep(600); }`. (Roobet.) |
| **Search result SPA nav** | Click result, URL changes but page doesn't fully re-render | In `navigateToEvent`: click → `waitFor(url change)` → `window.location.reload()`. (Roobet.) |
| **Language/locale coupling** | Column headers in non-English locale | Pin the URL to the English locale in the manifest matches and `BOOK_URLS`. Keep market-label maps English-only. |
| **Locale forced by session cookie** | Assigning `/en/...` redirects back to `/ja/...` (Stake) — can't pin via URL | Embrace the user's locale: match market titles that stay English ("1x2"), use index-based picking for row labels that translate ("ドロー" instead of "Draw"), and set `placeBetLabel` to the locale-specific string ("ベットの登録" on /ja/). |
| **Search input drops programmatic typing** | Runner reports "Searching for: X" but the search field stays empty and no results render (Svelte hydration race in freshly-opened tabs) | Bypass the DOM search: if the book exposes an internal GraphQL/REST endpoint (Stake has `POST /_api/graphql`), call it from the content script with `credentials: 'include'` to reuse the user's session. Have `findSearchInput` return a hidden stub element so the runner's `fillInput` is a no-op, and resolve the result in `findEventResult` by constructing an off-screen `<a>` from the API response. See [stake.js](../content-scripts/stake.js). |
| **Market type lives in a different section per sport** | `findMarketSection` returns the wrong card for one market type (e.g. Cloudbet hockey/basketball groups handicap+totals under "Game lines" but soccer puts 1x2 in its own "Full Time Result" card) | Branch on `market.type` inside `findMarketSection` — title-match for the standalone card, fall back to the shared section finder otherwise. |
| **Row label is an abbreviation that `lastWord` can't resolve** | Button text reads `"RCC1.81"` / `"LEV4.30"` for "Celta Vigo" / "Levante UD" — last-word `"Vigo"`/`"UD"` doesn't appear anywhere | For markets with a small fixed selection enum (`'1' / 'X' / '2'`, `'Over' / 'Under'`), pick by **index** off `leg.selection` instead of text matching. Cloudbet 1x2 uses `{ '1': 0, 'X': 1, '2': 2 }[leg.selection]`. |
| **Live games auto-reject in logged-in sessions** | `slipMarkers` briefly jumps to 7 after click then drops back to 1; no visible UI flash; `Bet slip did not open` timeout | Don't test against `status: "live"` fixtures. Stake's logged-in session aggressively rejects live-game bets where odds shifted between page render and click. Filter GraphQL results to `status === "active"` (or skip live for now) — most recent signals will reference live games, so pick a future fixture for adapter verification before trying real signals. |
| **Click event timing race (framework hydration)** | Plain `btn.click()` runs, runner logs "Clicking …", but `.selected` class never appears and slip stays empty. Manual MCP-driven testing on a settled page works; service-worker-opened tabs sometimes fail (intermittent). Affects both Svelte (Stake) and React/Next.js (Shuffle) — content scripts at `document_idle` can race ahead of when the framework attaches its click handler. | Wrap the button in `findOddsButton` to override `.click` with a delayed dispatch + success-poll + retry. See Stake's `wrapWithFullClick` and Shuffle's `wrapWithHydrationRetry`. **Use a polling-latch (poll every ~150 ms for ~1.5 s, latch on first positive signal) — NOT a fixed-time one-shot check at T+1200 ms.** The runner's `fillInput` briefly remounts the slip's stake input during onChange handling; a one-shot check that lands in that flicker falsely retries, which toggles the (already-selected) button OFF and removes the bet from the slip. Cost us a debugging cycle. |
| **Backend payload field missing at runtime** | `findOddsButton` runs, but `leg.line` / `leg.selection` / etc. is `undefined`. Section + button matching fails silently because string comparisons against `undefined` never match. | Add a one-line entry-diagnostic at the top of `findOddsButton`: `console.log(`[ARB-<book>] findOddsButton: type=${betData.market.type} selection=${leg.selection} line=${leg.line} btns=${buttons.length}`)`. If `line=undefined` shows up, the bug is upstream — most likely `calculator.py`'s `leg_details` not carrying the field through (see CLAUDE.md "backend ↔ adapter payload contract"). The popup also caches `lastBets` in `chrome.storage.local` — after a backend fix the user must click 解析 again to re-fetch. |
| **Search input is hidden behind a toggle button** | `findSearchInput` returns `null` on the landing page even after waiting — but a search icon/button is visible | In `findSearchInput`, look up the input first; if absent, click the toggle (e.g. `button[class*="SearchComponent_searchButton"]`) and return `null` so the runner polls again. The next poll finds the freshly-mounted input. Confirmed multiple toggle clicks are idempotent on Shuffle — safe to retry. (Shuffle.) |
| **`data-testid` is set on only the first sibling button** | Selecting `[data-testid="bet-select"]` returns 1 button per market, not 3 / 6 / 12 — but `parentElement.textContent` clearly shows multiple buttons' worth of text | Stop using the data-testid; switch to a stable class prefix that all outcome buttons share (Shuffle: `button[class*="SportsBetSelectionButton_root"]`). Confirm in DevTools by selecting by class and counting. (Shuffle.) |
| **Default tab on event page hides the full market** | Section title found but only contains a teaser (1-3 buttons) — the rest of the lines exist on another tab | Force the right tab via `?tab=...` URL param in `navigateToEvent` (Shuffle: `WIN_MARKETS` / `HANDICAP_MARKETS` / `TOTAL_MARKETS`). Map `market.type` → tab and append to the link's href before navigating. (Shuffle.) If the URL can't carry tab state, use `beforeFindMarket` with a cross-world click (see below). |
| **Radix UI tabs inside a same-origin iframe ignore all programmatic clicks** | `beforeFindMarket` runs, tab button is found, `.click()` / `dispatchEvent` called — but `data-state` stays "inactive" and section still shows teaser outcomes. Affects any book that wraps a Radix UI sportsbook in an iframe. | Radix tabs require the full pointer event sequence: `pointerover → pointerenter → pointerdown → mousedown → focus → pointerup → mouseup → click`. Plain `.click()` is silently rejected. Additionally, firing events on iframe DOM elements from the outer page (even from main world) doesn't reach the iframe's React root. **The fix is a three-layer mechanism:** (1) isolated-world adapter sends `window.postMessage({ type: 'arb:betsio-click-tab', text: 'All' }, '*')` — `postMessage` is the only reliable cross-world channel (`CustomEvent` dispatch does NOT cross isolated→main); (2) a companion `<book>-main.js` registered in the manifest with `"world": "MAIN"` listens on `window.addEventListener('message', ...)` and injects a `<script>` tag into `iframe.contentDocument` — the injected script runs inside the iframe's own JS context; (3) the injected script dispatches the full `PointerEvent` sequence on the target button. See `betsio-main.js` + `betsio.js beforeFindMarket` for the working implementation. (Betsio soccer handicap_2way.) |
| **Handicap/total grid is a single stacked column, not paired by line** | Found N buttons but the same line value appears twice with different odds — can't pick by line alone | The grid is split halves: first N/2 = team1 / Over, second N/2 = team2 / Under. Pick the half by `leg.selection` first, then match by line prefix within that half. (Shuffle.) |
| **Market grid is 100% canvas — no DOM odds buttons** | `document.querySelectorAll('button')` inside the market section returns 0 results despite visible odds on screen; market area is a `<canvas>` element | Access market data from the Pinia `game` store (`pinia._s.get('game').$state.marketGroups`). Get Pinia via `getVueApp().config.globalProperties.$pinia` — walk up to 20 `parentElement` levels from `.game-panel` to find `__vue_app__` on the betting sub-app (NOT the host app at `#__V3_HOST_APP__`). Return a fake `div` from `findOddsButton` with its `.click` patched to signal the MAIN-world bridge (see below). The arg to `couponAddBet` MUST be `{ market: outcome }` — not bare `outcome`. After `couponAddBet` call `couponStore.couponSetTab(1)` to open the bet slip panel (does NOT auto-open on programmatic calls). (1xbet.) |
| **`el.__vue_app__` not accessible from isolated-world content scripts** | Adapter calls `getVueApp()` and `getGameStore()` — always returns null; `[ARB-book] findMarketSection` log never appears despite `.game-panel` being present in DOM | `el.__vue_app__` is a JavaScript expando property set on the page's V8 DOM wrapper. Isolated-world content scripts get their OWN V8 wrapper for the same C++ DOM node — expandos are NOT shared. The fix is a **MAIN-world bridge script**: a separate content-script entry (`"world": "MAIN"`) that reads Pinia and writes serialized data to a DOM attribute (`document.documentElement.setAttribute('data-arb-...')`). DOM attributes ARE shared across worlds (they live on the C++ DOM node, not the V8 wrapper). The isolated adapter reads the attribute; the bridge observes it for bet requests. See `1xbet-bridge.js` for the pattern. (1xbet.) |
| **SPA search-result card has no href — click triggers Vue router** | `card.href` is empty/undefined; clicking the card doesn't trigger a full page load | In `navigateToEvent`: `card.click()` triggers a Vue router push. Poll `useNuxtApp().$router.currentRoute.value.fullPath` until the path changes to the event URL pattern, then force `window.location.href = newPath` for a full reload so the runner's `doFill` re-enters cleanly. (1xbet.) |
| **Search modal only opens on Enter key — fillInput alone is insufficient** | Search input fills but no modal/results appear | In `findEventResult`, if the modal is not open yet, dispatch `keydown` + `keyup` Enter events on the input and return null (runner retries). The modal mounts asynchronously after Enter. (1xbet.) |
| **Sportsbook lives in a same-origin iframe** | `document.querySelector(...)` finds elements but the actual markets are inside an `<iframe src*="sportsbook">` — all market queries return null | Set `getRoot: () => document.querySelector('iframe[src*="sportsbook"]')?.contentDocument` guarded by a readiness check (e.g., `.sb-BaseLayout` present). All adapter callbacks receive this iframe doc. For `navigateToEvent`, convert the iframe's `/sportsbook/` URL to the outer `/sports/` URL and do `window.location.href = …` for a full reload — the outer URL mirrors the iframe route via History API. For `findSearchInput`, click the toggle on the *main* document (`document.querySelector('.sportsbook-search-btn')`) and return null; the runner's waitFor will retry until the input mounts in the iframe. Native-setter + input-event fill works across same-origin realms (C++ setters are realm-agnostic in Chromium). (Betsio.) |
| **Tennis match-winner arrives as `handicap_2way`, not `1x2`** | A tennis (or any draw-less sport: MMA, 1v1 esports) moneyline leg has `market.type === "handicap_2way"`, `line === null`, `selection` `"1"`/`"2"` — even when the signal literally wrote "1X2". The parser maps draw-less match-winners to `handicap_2way` (a 2-leg `1x2` would be self-contradictory: no draw). | In `findOddsButton`, handle tennis `handicap_2way` as a **2-button card** (no draw): pick by index `{ '1': 0, '2': 1 }[leg.selection]`, same indexing as soccer `1x2` minus the draw. Don't route it through the basketball/hockey "Winner column" spatial path (that path expects the Game-lines grid). The market card title is the book's plain match-winner label (Cloudbet: `"Winner"`). (Cloudbet tennis.) |
| **Search input drops the runner's typed value (hydration race) → stuck at search screen even though the match exists** | In a freshly-opened service-worker tab, React/Svelte may not have attached the search input's onChange when the runner types, so the value sets but NO query fires → no result tiles → `findEventResult` times out at the search screen. The user sees an empty/stale search even though the game is obviously on the book. Distinct from the *click* race — this is the *search* side. | Give the adapter a `fillSearchInput(input, term, { sleep })` hook that re-types until result tiles actually render: each pass clear→set→dispatch `input` (clear first so React sees a real change), optionally a `keyup`, `await sleep(~1200)`, then check for the result-tile selector; loop ~6×, re-querying the input each pass in case hydration remounts it. Bail with a log if tiles never appear. (Shuffle, 2026-06-17.) The same race on the *odds click* is the row below — both must be handled for a freshly-opened tab. |
| **Odds click dropped on BetTarget / iframe / shadow-DOM books (hydration race)** | Event page reached, correct market + outcome found, but the bet is never selected and the slip never opens. The SDK (BetTarget/sptpub on roobet/betfury/betsio) or iframe sportsbook mounts well after `document_idle`, so the runner clicks an outcome whose handler isn't wired yet. Works when you test manually on a settled page; fails via the service-worker-opened tab. | Wrap the returned clickable so the runner's `.click()`: waits ~1200 ms for hydration, fires the full pointer sequence (`pointerdown→mousedown→pointerup→mouseup→click`), then polls ~1.5 s for a slip-open signal and re-fires once if nothing happened. Get the slip signal from the element's own root: `el.getRootNode()` returns the shadow root (betfury) or iframe document (betsio), so the slip query works across realms. Betfury/betsio/stake/shuffle all carry this now; copy any of their wrappers. (2026-06-17.) |
| **Book's search index surfaces an event under one team's name but not the other's** | Runner times out at the search screen — but the match exists and shows if you search the *other* team (1xbet found "Balcatta vs Perth Azzurri" by "Balcatta", returned nothing for "Azzurri"). A valid arb gets silently skipped; worse, the *other* leg may still place, leaving a one-sided/unhedged position. | Fixed centrally in `lib/runner.js` `doSearch`: it builds candidate terms `[searchTerm(team1), searchTerm(team2)]` (home first) and on a timeout clears the box and retries with the next. `findEventResult` still requires BOTH team names in the matched card, so the broader term can't produce a false match. First attempt uses a shorter 6 s timeout, the last gets the full 12 s. **Order matters beyond the index:** the first/from-empty search is the reliable path; the fallback re-search may hit a book's in-place re-type quirks (1xbet's Vue-reactive box ignores a programmatic value *replacement* — only a from-empty search fires; see the 1xbet row), so team1-first is what made the Balcatta case work without needing the fallback. (All books, 2026-06-17.) |
| **`lastWord` picks a generic club designator (SK/IF/FC/United/City) as the search term** | "Enkoping SK" → searched "SK" (matches half of Sweden) → no result or wrong event. The literal last token isn't distinctive. | `lib/runner.js` `searchTerm()` skips trailing generic club tokens (a small allow-list: sk, if, ik, fc, sc, united, city, …) the same way `lastWord` skips initials, landing on the distinctive token ("Enkoping"). Used for the *search query*; matching still uses first-OR-last-word tokens. Extend `GENERIC_CLUB_TOKENS` when a new designator bites. (All books, 2026-06-18.) |
| **Signal team name and book render are different romanizations of the same name** | Search surfaces the event but `findEventResult` rejects it: signal "Ragsved"/"Enkoping" vs site "Raagsveds"/"Enköpings". Two independent gaps — diacritics (å vs a) AND letter-doubling (å→"a" in the signal, å→"aa" on the book) — so a raw `text.includes(token)` is false even after lowercasing. | Use `norm()` from `lib/runner.js` (exposed on `window.__arb`) on **both** sides before matching. It NFD-folds diacritics, lowercases, and collapses runs of a repeated letter (`raagsveds → ragsveds ⊇ ragsved`). It preserves spaces (callers tokenize with `norm(name).split(/\s+/)`). Adapters should `norm()` the tile/card text and build tokens from `norm(team)`. A few accents don't NFD-fold (ø ł ß) — handle case-by-case. (shuffle, 1xbet so far; 2026-06-18.) |
| **Search returns the senior fixture alongside Women / U23 / youth variants with the SAME team names** | "Balcatta" search returns three cards: "Balcatta - Perth", "Balcatta (Women) - Perth (Women)", "Balcatta U23 - Perth U23". A token match on both teams accepts ALL THREE — risking a real-money bet on the wrong division. | Build a division set from the signal (teams + `betData.league`) and from each card's text (regex for women/`(w)`, `U\d{2}`, youth, reserves). Accept a card only if its divisions are all ⊆ the signal's (so a senior-men signal — empty division set — rejects any decorated card, but a genuine Women signal still matches its Women card). Then prefer the shortest matching text. `findEventResult` receives `betData` as its 3rd arg (runner passes it). (1xbet; 2026-06-18.) |
| **Tennis player names are "Surname I." — `lastWord` would return the initial** | Search runs for "S." and finds nothing; event-result matching fails. Tennis signals write players as "Schnyder S." / "Voracek E. M." (surname first, then initials), so the literal last token is a useless initial. | Fixed centrally in `lib/runner.js` `lastWord`: it now skips trailing single-letter initials, returning the surname ("Schnyder S." → "Schnyder"). Books render tennis players surname-last ("Sara Schnyder") or also abbreviated ("Schnyder S."), so the surname matches either way. No per-adapter change needed — every adapter that uses `lastWord` for search/match inherits the fix. (All books, tennis.) |
| **Bringing up a market when the book is unreachable for live DOM checks** | You need to ship a new (sport, market) combo but the book is blocked/flaky in the browser tool (Cloudflare bot-check on Stake; BetTarget SDK won't deep-link on Betfury; iframe flakiness on Betsio; whole domain blocked on 22bet) so you can't confirm the exact section title. | Don't hardcode one guessed title. (1) Make `marketLabel` return a non-null best-guess (runner aborts on null). (2) In `findMarketSection`, branch for the new combo and try an ordered list of CANDIDATE titles (e.g. `['Winner','1x2','Match Winner','Moneyline']`), returning the first that matches. (3) On miss, `console.log` the list of titles actually rendered (`[ARB-<book>] … available:`), so the live test reveals the real title for a one-line fix instead of a silent timeout. (4) Reuse the book's existing 1x2 outcome-matching (player-name or index) for a 2-way moneyline — it's the same shape minus the draw. (5) Leave the capability-matrix entry enabled but comment it `NOT live-verified` so the next person knows to confirm. Applied for tennis match-winner on stake/shuffle/betsio/betfury (2026-06-16). |
| **A market card uses a different wrapper class than the book's other markets** | Shuffle's `findSectionByTitle` walked up to a `subCollapseRoot` ancestor — works for soccer/hockey handicap+total, but the tennis match-winner card sits in `StackedCollapseGroup_item` / `Collapse_collapseRoot`, AND **soccer 1x2** also has no `subCollapseRoot` ancestor. The title matched (`titles present: ['1x2']`) but the walk returned null → silent market-section timeout. The trap: the on-miss log showed the title *was* present, so it looked like a match-logic bug, not a container-walk bug. | Don't assume one fixed wrapper class. Match the title, try the `subCollapseRoot` walk first (precise where it applies), then **fall back to a structural walk** to the nearest ancestor that actually contains the selection buttons (`for (n=titleEl; n; n=n.parentElement) if (n.querySelectorAll(BTN).length>=2) return n`). `findSectionByTitle` now does both. Also: when a section isn't found, **always log the titles actually present** — but remember a present title can still fail the *walk*, so verify `findOddsButton` logs `btns=N` too. Titles are **locale-translated** on cookie-locked sessions (Shuffle JP match-winner = "勝者"). (Shuffle tennis 2026-06-16, soccer 1x2 2026-06-18.) |
| **Per-sport query-param name differs** | Cloudbet uses `?tab=` for soccer/basketball/hockey but **`?markets-tab=`** for tennis — appending `?tab=all` to a tennis URL silently does nothing and the set-specific markets never render. | Branch the tab-param construction on `sport` in `navigateToEvent`. For Cloudbet tennis, `?markets-tab=all` renders both the "Winner" card and the "Total games in set 1" card, so one param covers both market types. Don't assume the param name that works for other sports carries over. (Cloudbet tennis.) |
| **Sportsbook rendered in Shadow DOM via third-party SDK** | `document.querySelector(...)` returns null for all markets — they're inside a `shadowRoot` with no stable host id/class | `getRoot()` must tree-walk `document` looking for a `shadowRoot` containing the SDK's stable marker element (e.g., `[data-editor-id="navbar"]`). Cache the result. Return the `shadowRoot` itself — it supports `querySelector` like a document fragment. The outer page may have a separate unrelated search (casino games, etc.) — find the SDK's own search icon via a unique attribute (`data-cy="ic-search"`) inside the shadow DOM. `data-editor-id` attributes are stable semantic identifiers; prefer them over hashed `sc-*` or numeric `bt<N>` classes. (Betfury / BetTarget platform.) |
| **Tennis match-winner group collides in name with an unrelated existing group, not missing entirely** | A `handicap_2way`/`line===null` tennis leg routed to the wrong Pinia group (`"Handicap"`, which genuinely exists and holds spread markets) instead of erroring — silent wrong-market risk, not a crash. | On 1xbet, tennis (and other draw-less) match-winner data lives in the **`"1X2"`** group (same name as soccer's 3-way market), with only 2 columns (no draw) and outcomes identified by `typeId` 1 (player1/"W1") and 3 (player2/"W2") — the same skip-2 typeId scheme as soccer 1x2, just without a draw entry. Don't assume "Handicap" just because `line===null` mirrors the ice-hockey `handicap_2way` shape — verify against the live `marketGroups` group names first; a same-named group existing is not proof it's the right one. (1xbet tennis.) |

---

## Before you start: DOM exploration

Before writing any code, open the book in a regular tab and document the DOM. Save findings in `extension/references/<book>-dom-notes.md` (see [cloudbet-dom-notes.md](cloudbet-dom-notes.md) and [roobet-dom-notes.md](roobet-dom-notes.md) for the template). Cover at minimum:

1. **Search input** — selector, whether it's in Shadow DOM, whether it's React-controlled.
2. **Search results** — how each result is rendered, what link/click target to use, how to match by team names.
3. **Event page URL pattern** — how to tell search page vs event page from `pathname`.
4. **Market sections** — how each market (handicap/total/1x2) is demarcated, whether section titles are stable text.
5. **Odds buttons** — stable selector, whether text contains team name + odds (for value-based matching), the spatial layout if it's a column-header / row-label grid.
6. **Bet slip** — selector for stake input, whether it auto-opens, any currency/delay quirks.
7. **Market type → site label** mapping — English only; fill in the full list we support.

Write the DOM notes *first*. Writing the content script without them invariably hits one of the gotchas above and you burn time debugging blind.

---

## Wiring a new book into the extension

For each new book you need to touch:

1. **Create** `content-scripts/<book>.js` — the adapter. Copy [cloudbet.js](../content-scripts/cloudbet.js) (Document-based) or [roobet.js](../content-scripts/roobet.js) (Shadow DOM) as the starting template.
2. **[manifest.json](../manifest.json)**:
   - Add the site origin to `host_permissions`.
   - Add the site URL pattern to the `visibility-spoof.js` matches.
   - Add a content-script entry with **both** `lib/runner.js` and `content-scripts/<book>.js` in `js` (runner must come first).
3. **[background/service-worker.js](../background/service-worker.js)**: add the book to `BOOK_URLS` with the landing-page URL.
4. **[popup/popup.js](../popup/popup.js)** → `BOOK_CAPABILITIES`: declare which (sport, market_type, period) combos are verified end-to-end. Leave untested combos out — the popup greys out unsupported legs using this matrix.
5. **[references/<book>-dom-notes.md](.)**: DOM exploration notes (see above).

---

## Testing protocol

1. Pick a real signal message in `backend/test_messages/` that targets the book.
2. **Use a future / non-live fixture for adapter bring-up.** Books may auto-reject bets on live games (rapid odds shifts → backend invalidates the slip selection without UI feedback). Stake exhibited this; took half a debugging session to figure out. Write the test message against an `active` (not-yet-started) match the book actually has — query the book's API or sports listing to confirm. Save the live-game test for after the adapter is otherwise solid.
3. Run the backend (`uv run python server.py`), open the popup, paste the message, click 解析 (parse).
4. Click 実行 (execute) on the leg for this book. The tab must be foregrounded when the script runs — let the service worker open it, don't switch away.
5. **Watch the DevTools console with "Preserve log" enabled** — without it, Chrome wipes the search-phase logs when the tab navigates to the event page, hiding the most useful failure signals.
6. Verify: search → navigate → correct market + selection clicked → stake filled → green toast appears → `<book>State` is cleared in storage.
7. Test at least one each of: `handicap_2way`, `over_under`, `1x2` on basketball and ice hockey. Edge cases (OT-included markets, draws, totals half-points) break first — test them explicitly.
8. Intentionally test with the popup closed — STATUS_UPDATE messages should still route correctly when the popup reopens.

### Logged-out vs logged-in DOM exploration

Logged-out exploration covers **everything except** the Place Bet button:
search, navigation, market discovery, odds-button clicks, slip population,
stake input filling all work without auth. Use the logged-out state for
fast iteration during adapter bring-up.

But: **some failures only manifest logged-in.** Stake's auto-reject-on-live
behavior was logged-in-only. When the runner reports a click but no slip
state, the user must re-test signed in (they're the only one with
session cookies) and share the post-click diagnostic log.

---

## Debugging adapter failures: diagnostics before hypotheses

When a click silently fails or a section never resolves, **add a `console.log` before you guess the cause**. Two lines of code save twenty minutes of speculation. Patterns that have paid off:

- **At the entry of `findOddsButton`**: log `betData.market.type`, `leg.selection`, `leg.line`, `buttons.length`. Catches upstream payload bugs (a missing `line` looks identical to a button-text mismatch from the outside).
- **At `findMarketSection`**: if section is `null`, log the candidate titles you scanned (`Array.from(document.querySelectorAll('span[class*="MarketCollapseHeader_title"]')).map(e=>e.textContent.trim())`). Catches title-string drift between regulation and OT-incl variants.
- **In `wrap*Click`**: log post-click `.selected` state, slip-marker count, stake-input presence. Catches hydration races vs. selector drift.

Prefix logs with `[ARB-<book>]` so the user can grep them out of Chrome's console.

**Re-verify in MCP before assuming a code bug.** Run the same selectors / picks in the live tab with `mcp__claude-in-chrome__javascript_tool`. If it works in MCP but fails via service-worker tab, the bug is timing-related (hydration race, runner timeout, ?tab= not applied). If it fails in MCP too, the bug is in the selector / logic. This split has resolved every adapter regression so far.

**MCP browser is sometimes slow on the book sites.** Cloudbet in particular can return empty results (`oddBtns: 0`) on first load — wait 4-6 s and retry, or pre-warm by navigating in a regular tab first. Don't assume the page is broken because one query returned nothing.

## When you learn something new

This document and the per-book dom-notes files are **living references**, not one-time write-ups. The cost of stale instructions is a future session re-debugging an issue that's already in someone's head.

- If you hit a gotcha not listed in the quirks table above — add a row.
- If an existing row is wrong, incomplete, or has a better mitigation — rewrite it (don't append a contradicting row).
- If the gotcha is general enough to belong in `lib/runner.js`, lift it there and document the new adapter field in the quirks table.
- If the gotcha is site-specific (DOM structure, selector convention, locale handling), put it in `<book>-dom-notes.md` and reference it from the quirks table.
- If the gotcha changes the project-level mental model (backend contract, build-plan ordering, working style), promote it to `CLAUDE.md` as well.
- **Update in the same commit as the fix.** Days-later doc updates don't happen; bundle them with the change that motivated them.

The handoff prompt at the end of each session is the other living artifact — make sure new gotchas show up there too so the next session has them in its working context, not just in files it might not read.
