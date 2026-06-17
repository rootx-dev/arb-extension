# Betfury DOM Notes

Explored: 2026-05-13 — Manchester City v Crystal Palace (Premier League)
Updated: 2026-06-17 — Atmane Terence vs Medvedev Daniil, ATP Halle (tennis new markets)

## Architecture

Betfury uses the **BetTarget / sptpub.com BTRenderer SDK**. The entire sportsbook renders inside a **Shadow DOM** (NOT an iframe):

```
Outer page:   https://betfury.io/sports[/<path>]
Shadow host:  anonymous <div> with no id/class (must tree-walk to find)
Shadow root:  contains all BTRenderer-rendered content
```

The shadow host has no stable id or class — find it by walking `document` looking for a `shadowRoot` that contains `[data-editor-id="navbar"]`. Cache the result.

**BTRenderer API** (`window.BTRenderer.appInstance`): `initialize`, `goToPage`, `action`, `command`, `updateOptions`. `goToPage({ name: 'search' })` is broken (serializes params as `[object+Object]`). Do NOT use it; instead click the search icon in the shadow DOM.

**Stable selectors**: BTRenderer elements use `data-editor-id` attributes throughout — these are the preferred selectors. Numeric `bt<N>` classes (bt332, bt352, bt354, etc.) and Styled Components hashed classes (`sc-7elhv3-0 czyPR`) are secondary / potentially unstable.

## Search Flow

Sports search is inside the shadow DOM (betfury has a separate casino game search on `.search-button` — do NOT use that).

- **Search icon**: `[data-cy="ic-search"]` SVG → click its **parent div** (`[data-editor-id="navbarIcon"]`).  
  Clicking navigates to `/sports/search` and mounts the search input.
- **Search input**: `input[placeholder="Search"]` (class `bt579 bt584`)
- **Result cards**: `[data-editor-id="eventCard"]`; each contains an `a[href*="/sports/"]` with the full event URL
- **Result matching**: use `lastWord(team1/team2)` against `card.textContent`; skip cards whose text includes `esoccer`, `cyber`, or `esport`

fillInput (native setter + `input` event) works on the shadow DOM search input — it's React-controlled and same-window.

`searchSettleMs: 2000` — the URL updates async after the input event; results need ~1-2 s to populate.

## Event Page URL Pattern

```
https://betfury.io/sports/<sport>/<country>/<league>/<team1>-<team2>-<matchId>
```

Examples:
- `/sports/soccer/england/premier-league/manchester-city-crystal-palace-2662800915362357282`
- `/sports/basketball-2/<country>/<league>/...`  (basketball sport slug is `basketball-2`)

`isEventPage` regex: `/^\/sports\/.+-\d{15,}$/` (last path segment ends with 15+ digit numeric ID)

## Market Sections

Each market is `[data-editor-id="tableMarketWrapper"]` (= `div.bt332`). The section's **raw textContent starts with the market name** immediately followed by outcome labels (no separator), so `textContent.trim().startsWith(name)` is reliable.

### Market Name → Signal Mapping (verified 2026-05-13, tennis added 2026-06-17)

| Signal `market.type` | `market.period` | Sport | Betfury section title (match strategy) |
|---|---|---|---|
| `1x2`           | `null`     | any       | `"1x2"` — skip "1x2Early Payout" and period variants (startsWith) |
| `handicap_2way` | `null`     | tennis    | `"Winner"` — exact title match via `children[0]` |
| `handicap_2way` | `1st_set`  | tennis    | `"First set - winner"` — exact title match via `children[0]` |
| `over_under`    | `null`     | tennis    | `"Total games"` — exact title match via `children[0]` |
| `over_under`    | `1st_set`  | tennis    | `"First set - total games"` — exact title match via `children[0]` |
| `over_under`    | `null`     | soccer    | `"Total"` — skip `"Total ("` (= "Total (Asian)") (startsWith) |
| `over_under`    | `ot_incl`  | basketball | `"Total (incl. overtime)"` (startsWith) |
| `over_under`    | `ot_incl`  | ice_hockey | `"Total (incl. overtime and penalties)"` (startsWith) |
| `handicap_2way` | `null`     | soccer    | `"Handicap"` — skip `"Handicap ("` (= "Handicap (Asian)") (startsWith) |
| `handicap_2way` | `ot_incl`  | basketball | `"Handicap (incl. overtime)"` (startsWith) |
| `handicap_2way` | `ot_incl`  | ice_hockey | `"Handicap (incl. overtime and penalties)"` (startsWith) |

**IMPORTANT**: The adapter uses `startsWith('Total (incl. overtime')` (no closing `)`) to match both basketball and hockey with one check. Same for Handicap.

Verified: soccer (Man City v Crystal Palace), basketball NBA (Pistons v Cavaliers), ice hockey NHL (Avalanche v Wild, 2026-05-13).

Outcome name formats are identical across soccer and basketball: OU → `"over 206.5"`, handicap → `"(-9.5)"`. Same `sc-7elhv3-1` button selector works.

## Outcome Structure (inside market section)

```html
<div data-editor-id="tableOutcomePlate" class="sc-7elhv3-0 … jIJSdy">
  <div class="bt348"></div>
  <div data-editor-id="tableOutcomePlateName" class="sc-7elhv3-2 dAtdcF">
    <span class="sc-7elhv3-3 dJEQNf">Manchester City</span>   ← outcome label
  </div>
  <div class="bt352 sc-7elhv3-1 czyPR" id="outcome-<matchId>_<pos>__<id>">
    <span class="bt354">1.2</span>                             ← odds value
  </div>
</div>
```

**Outcome label formats by market type:**

| Market type      | Example label text          | Notes |
|---|---|---|
| `1x2`           | `"Manchester City"` / `"draw"` / `"Crystal Palace"` | lowercase "draw" |
| `over_under`    | `"over 2.5"` / `"under 2.5"` | lowercase, includes line |
| `handicap_2way` | `"(-4.5)"` / `"(4.5)"`       | signed line in parens, no team name |

**Clicking**: use `plate.querySelector('[class*="sc-7elhv3-1"]')`. The Styled Components hash `sc-7elhv3` is the same as Roobet (same BetTarget platform) and is stable between deployments. **Do NOT use `div.bt352`** (numeric class, unstable between page loads) or `[id^="outcome-"]` (absent in some renders). No role="button" — it's a plain div.

## Bet Slip

The bet slip is always visible as a right sidebar. Clicking `[id^="outcome-"]` auto-adds the selection; no explicit "open panel" step needed.

| Element | Selector |
|---|---|
| Bet slip container | `[data-editor-id="betslipContent"]` |
| Selection item | `[data-editor-id="betslipSelection"]` |
| Selection odds display | `[data-editor-id="betslipSelectionOdd"]` |
| Stake input (LABEL) | `[data-editor-id="betslipStakeInput"]` |
| Stake input (INPUT) | `[data-editor-id="betslipStakeInput"] input` |
| Total line | `[data-editor-id="betslipTotalLine"]` |
| Potential win | `[data-editor-id="betslipPotentialWin"]` |
| Place Bet button (logged-out shows "Login") | `[data-editor-id="betSlipLoginButton"]` when logged out; likely `[data-editor-id="betSlipPlaceBetButton"]` when logged in — **UNVERIFIED** |

Default stake is `"5"`. Use `clearStakeFirst: true`.

Stake input is React-controlled (confirmed via `__reactFiber$…` key). Native setter + `input` event fills it correctly.

## Shadow DOM vs Runner.js

`getRoot()` returns the shadow root (a `DocumentFragment`). All `root.querySelector()` calls inside the adapter work correctly in shadow DOM. The runner's `fillInput` uses `window.HTMLInputElement.prototype` — same window, so no realm issues (no iframe involved).

## Tennis

Verified 2026-06-17 — Atmane Terence vs Medvedev Daniil, ATP Halle Germany (future match, starts same day).

### Section titles (live-verified, from `children[0].textContent.trim()`)

| Market | Period | Section title (exact) |
|---|---|---|
| `handicap_2way` | `null` | `Winner` |
| `handicap_2way` | `1st_set` | `First set - winner` |
| `over_under` | `null` | `Total games` |
| `over_under` | `1st_set` | `First set - total games` |

The adapter uses `children[0].textContent.trim().toLowerCase() === target` (exact match) rather than `startsWith` to prevent "winner" ⊂ "first set - winner" substring collision.

Other tennis sections visible on the event page (NOT handled in current adapter):
`Second set - winner`, `Game handicap`, `First set - game handicap`, `First set - will there be a tiebreak`,
`Set handicap`, `Total sets`, `Correct score`, `Exact sets`, `First set - odd/even games`, `Total tiebreaks in the match`.

### Outcome plate name formats (live-verified)

| Market | Plate name examples |
|---|---|
| `handicap_2way` winner (any period) | `"Atmane, Terence"` / `"Medvedev, Daniil"` — player full name, sentence case |
| `over_under` totals (any period) | `"over 8.5"` / `"under 8.5"`, `"over 20.5"` / `"under 20.5"` — lowercase, space between side and line |

The OU plate name is an exact match: `name === "over 8.5"` (lowercase). This is the same format as other sports (soccer, basketball).

### All sections visible on event page (DOM order)

0. `Winner`
1. `First set - winner`
2. `Second set - winner`
3. `Game handicap`
4. `First set - total games`
5. `Second set - total games`
6. `First set - game handicap`
7. `First set - will there be a tiebreak`
8. `Total games`
9. `Set handicap`
10. `Total sets`
11. `<player> to win a set`
12. `Correct score`
13. `Exact sets`
14. `First set - odd/even games`
15. `<player> to win a set`
16. `Total tiebreaks in the match`

## Known Issues / Unverified

1. **Place Bet button `data-editor-id`**: Logged-out state shows "Login" (`betSlipLoginButton`). Logged-in label and ID unknown. Update `betfury-dom-notes.md` and `placeBetLabel` after first live test.
2. **Ice hockey OT market names differ from basketball**: Hockey uses `"Total (incl. overtime and penalties)"` and `"Handicap (incl. overtime and penalties)"` — basketball uses `"Total (incl. overtime)"`. The adapter uses a prefix without closing `)` to match both. Verified 2026-05-13 on Avalanche v Wild.
