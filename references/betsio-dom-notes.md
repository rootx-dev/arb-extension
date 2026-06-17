# Betsio DOM Notes

Explored: 2026-05-13 — Cleveland Cavaliers v Detroit Pistons (NBA), Finland v Germany (IIHF World Championship), Aston Villa v Liverpool (Premier League)

## Architecture

Betsio embeds its sportsbook in a **same-origin iframe**:

```
Outer page:   https://www.betsio.com/sports[/<sport>/<slug>-m-<id>]
Iframe src:   https://www.betsio.com/en/sportsbook  (always this src)
Iframe route: https://www.betsio.com/sportsbook[/<sport>/<slug>-m-<id>]
```

The iframe is **same-origin** → `iframe.contentDocument` is accessible from the content script. All selectors in the adapter target the iframe doc via `getRoot()`.

When the iframe navigates via History API, the outer page URL mirrors it with `/sports/` replacing `/sportsbook/`. This means:
- `isLandingPage` / `isEventPage` check `window.location.pathname` (outer URL) — works correctly.
- `navigateToEvent` converts the event link href (`/sportsbook/…`) → outer URL (`/sports/…`) and does `window.location.href = …` for a full page reload.

**CSS class prefix**: all platform elements use `sb-*` classes. These appear stable (not hashed).

## Main Page Search

- **Button (main document)**: `.sportsbook-search-btn` (a `<div>`, not an `<input>`)
- Clicking it opens a search modal INSIDE the iframe.
- **Input (iframe)**: `input.sb-SearchBar-input` with placeholder "Search"
- Results appear inside `.sb-ModalWindow.sb-SearchModal`
- Each result is an `<a href*="-m-">` link with sport in the href path: `/sportsbook/<sport>/<slug>-m-<id>`. Text format: `"{time}{Team1}—{Team2}{sport}・{league}"`
- Use `lastWord(team1)` + `lastWord(team2)` to match. Skip links whose text contains "Cyber" or "Esport".
- **Also filter by sport slug in the href** — betsio search is cross-sport; e.g. searching "Knights" returns baseball results alongside NHL "Golden Knights". The adapter stores `_sportPath` from `findSearchInput(root, betData)` and skips results where `href` doesn't include `/<sport>/`.

The adapter's `findSearchInput` checks for the input first; if absent it clicks `.sportsbook-search-btn` and returns null (runner retries via waitFor).

## Event Page URL Pattern

```
Outer:  https://www.betsio.com/sports/<sport>/<team1>-<team2>-m-<id>
Iframe: https://www.betsio.com/sportsbook/<sport>/<team1>-<team2>-m-<id>
```

`isEventPage` regex: `/\/sports\/[^/]+\/[^/]+-m-\d+/`

## Market Sections

Each market is a `div.sb-MarketTable`. Title is inside `.sb-MarketTable-name`. Outcomes are `button.sb-MarketTable-outcome` elements.

### Market Name → Signal Mapping (verified 2026-05-13/14)

| Signal `market.type` | `period`   | Sport      | Betsio market name                            |
|---|---|---|---|
| `handicap_2way`      | `ot_incl`  | basketball | `Points Handicap`                             |
| `over_under`         | `ot_incl`  | basketball | `Total Points`                                |
| `1x2`                | `null`     | soccer     | `Match Result`                                |
| `over_under`         | `null`     | soccer     | `Total Goals`                                 |
| `handicap_2way`      | `null`     | soccer     | `Goals Handicap`                              |
| `handicap_2way`      | `ot_incl`  | ice_hockey | `Match Winner (Including Overtime)` — 2-way H/A, no line |
| `over_under`         | `null`     | ice_hockey | `Total Goals (Regular Time)` — reg time only  |
| `handicap_2way`      | `null`     | ice_hockey | `Goals Handicap (Regular Time)` — reg time only |

**Ice hockey OT markets** (verified 2026-05-14, Minnesota Wild vs Colorado Avalanche NHL playoff game):
- `"Match Winner (Including Overtime)"` — 2-way H/A moneyline (no handicap line). Button text is just `"{Team Name}{odds}"` e.g. `"Minnesota Wild1.45"`. Match by `lastWord(team)`.
- No "Total Goals (Including Overtime)" exists on betsio for NHL — only regular-time totals are offered.
- BOOK_CAPABILITIES: `ice_hockey: { handicap_2way: ['ot_incl'] }` (no over_under).

**Basketball markets** ("Points Handicap", "Total Points") have no "Regular Time" qualifier, suggesting they are full-game (OT-inclusive) — consistent with BOOK_CAPABILITIES `ot_incl`.

## Odds Button Structure

```
.sb-MarketTable
  └── .sb-MarketTable-name     → "Total Points"
  └── .sb-MarketTable-toggle   → collapse button (not an odds button)
  └── .sb-MarketTable-outcome.sb-Odd.sb-AnimatedOdd-wrapper  → odds button
        └── span.sb-Odd-label        → label text e.g. "Over 2.5"
        └── div.sb-AnimatedOdd.sb-Odd-value  → odds value e.g. "1.81"
        textContent (combined): "{label}{odds}" e.g. "Over 2.51.81"
```

Button text patterns:
- **H/A (Match Winner)**: `"Cleveland Cavaliers2.33"` / `"Detroit Pistons1.58"`
- **1x2**: `"Aston Villa2.86"` / `"Draw3.62"` / `"Liverpool2.20"`
- **Handicap**: `"Cleveland Cavaliers (+3.5)1.94"` / `"Detroit Pistons (-3.5)1.87"`
- **Basketball OU**: `"Over 212.51.89"` / `"Under 212.51.91"`
- **Soccer OU**: `"Over 2.51.52"` / `"Under 2.52.39"` (after "Total" tab switch)

**Matching strategy**:
- OU: `startsWith("Over"/"Under")` AND `includes("Over " + leg.line)` (line appears before odds)
- 1x2 Draw: `includes("Draw")`
- All others: `lastWord(teamName)` appears in button text

No `aria-label` attributes on outcome buttons.

## Bet Slip

Clicking an odds button adds it to a floating counter `.sb-FloatingTicket` (shows "1").
Full bet slip opens in `.sb-Drawer-content` after clicking `.sb-FloatingTicket`.

| Element | Selector |
|---|---|
| Floating ticket button | `.sb-FloatingTicket` |
| Bet slip drawer | `.sb-Drawer-content` |
| Single bet item | `.sb-BetSlipSingleBet` |
| Stake input | `input.sb-StakeInput-input` or `.sb-Input.sb-StakeInput-input` |
| Place Bet button | button with text "Place Bet" inside `.sb-SlipFooter-placeBet` |

Stake input is inside the drawer → only visible after clicking FloatingTicket.
`openSlipPanel` returns `.sb-FloatingTicket` if drawer not yet open (guards against double-click toggling it closed).

React/framework setter trick: `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set` from the content script's outer window works on the iframe's input elements (same-origin, C++ native setters are realm-agnostic in Chromium).

## `getRoot()` readiness check

Return `null` until `.sb-BaseLayout` exists in the iframe's document — this prevents the runner from querying an uninitialised frame on page load.

## Tab Switching for Soccer Markets (Critical Gotcha)

The event page loads with a "Top" tab active by default. Soccer markets require switching tabs to expose all lines:

| Market type  | Required tab | Reason |
|---|---|---|
| `handicap_2way` (soccer) | **All** | Top shows only 2 featured outcomes; All shows every line |
| `over_under` (soccer)    | **Total** | Top shows one default line only; Total shows all ~13 lines |
| Basketball / Hockey OU/HA | no switch needed | Top tab already shows all relevant options |

For soccer `over_under`, the "Total Goals" section on the Top tab only shows the single default line (e.g. "Over 3" / "Under 3"). Switching to the "Total" tab exposes all available lines (e.g. 0.5 through 6.5), including 2.5.

Tab buttons are `button.sb-TabsTrigger` with text: Top | All | Total | Handicap | Period | ...

### Why programmatic click fails — and the working fix

**Root cause:** Betsio uses Radix UI for tabs. Radix only responds to a full pointer event sequence (`pointerover → pointerenter → pointerdown → mousedown → focus → pointerup → mouseup → click`). A bare `.click()` is silently ignored. Additionally, dispatching events on iframe elements from the outer page (even from main world) doesn't trigger React/Radix event delegation inside the iframe.

**What was tried and failed:**
- `tab.click()` from content-script isolated world
- `new MouseEvent('click', {bubbles: true})` from isolated world
- `chrome.scripting.executeScript` from service worker
- `window.dispatchEvent(new CustomEvent(...))` — does NOT cross isolated→main world boundary
- `tab.click()` from main-world `betsio-main.js` on iframe elements — outer-page click doesn't fire React inside iframe
- `<script>` injection into iframe with bare `tab.click()` from injected script — Radix ignores it

**What works:**
1. `betsio.js` (isolated world) sends `window.postMessage({ type: 'arb:betsio-click-tab', text: 'All' }, '*')`
2. `betsio-main.js` (main world, `world: "MAIN"` in manifest) receives it via `window.addEventListener('message', ...)`
3. `betsio-main.js` injects a `<script>` tag into the iframe's `contentDocument` — this runs inside the iframe's own JS context
4. The injected script dispatches the **full PointerEvent sequence** (`pointerover, pointerenter, pointerdown, mousedown, focus, pointerup, mouseup, click`) on the target `button.sb-TabsTrigger`

Key note: `window.postMessage` crosses isolated→main world boundary. `window.dispatchEvent(new CustomEvent(...))` does NOT.

After the tab switch, the "Goals Handicap" section renders 18 outcomes covering all lines. `beforeFindMarket` polls for the tabs to appear (SPA renders them ~1-2s after mount), dispatches the postMessage, then waits 1000ms for React to re-render.

## Lazy Loading / Scroll Requirement

League-page game rows use `.sb-LazyComponentLoader` — they don't render until scrolled into view. This only affects the league listing pages, not the event page (which we navigate to directly). No scroll needed in the adapter.

## Tennis (explored 2026-06-17)

Verified live on Bergs Z. vs Fritz T. (ATP Halle, future). Sportsbook is in the
same-origin iframe; market tables `.sb-MarketTable`, title `.sb-MarketTable-name`,
outcomes `.sb-MarketTable-outcome`. All four tennis markets render by default — no
tab switch needed (the `beforeFindMarket` "All"/"Total" tab logic is gated to skip
tennis).

| Signal market | period | `.sb-MarketTable-name` (EXACT) |
|---|---|---|
| handicap_2way (match winner) | null | `Match Winner` |
| handicap_2way (1st-set winner) | 1st_set | `1 Set Winner` |
| over_under (full game totals) | null | `Total Games` |
| over_under (1st-set game totals) | 1st_set | `1 Set Total Games` |

**Use EXACT title equality** — the event also lists `Player 1 Total Games`,
`Player 2 Total Games`, `1 Set Player 1 Total Games`, `Total Sets`, etc. A
`Total Games` substring/`startsWith` match would grab the wrong (per-player) table.

- Winner outcomes: player full name + odds, e.g. `Zizou Bergs3.35` / `Taylor Fritz1.24`.
  Matched by `lastWord(team)`. sel '1'=team1, '2'=team2 (no draw).
- Totals outcomes: `Over {line}{odds}` / `Under {line}{odds}` e.g. `Over 231.75`,
  `Over 10.52.11`. Matched by the existing `startsWith(prefix) && includes("{prefix} {line}")`
  branch (same as soccer/basketball) — works unchanged for tennis.
- Every returned outcome goes through `wrap()` (hydration-race click fix).
