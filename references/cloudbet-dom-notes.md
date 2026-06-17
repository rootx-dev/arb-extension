# Cloudbet DOM Notes

Explored: 2026-04-22 — BOS Bruins v BUF Sabres, NHL, event ID 34141117

## Search Bar

- **Selector**: `input.input`
- Single `<input type="text">` on the sports page, no `id` or `name`.
- Filling via React requires the native setter trick (not a plain `input.value =`):
  ```js
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, term);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  ```

## Search Results

- After typing, results appear under an **Events** heading.
- Each result is an `<a class="team" href="/en/sports/{sport}/{league}/{event-id}">`.
- Inside each link: `<span class="sr-only">TEAM1 v TEAM2</span>` — use this for matching.
- To navigate: `window.location.href = link.href` (SPA-aware nav fails; full reload works).

## Event Page URL Pattern

```
https://www.cloudbet.com/en/sports/ice-hockey/usa-nhl/34141117?tab=popular
```
- `tab=popular` shows the Game lines section immediately.
- Breadcrumb: Ice Hockey → USA → NHL → BOS v BUF

## Game Lines Section Card

- **Selector**: `div` whose `className` includes `bg-surface-0` + `rounded-2xl`, with exactly 2 children, and whose text includes both "Game lines" and "Winner".
- **children[0]**: Header area — section title + column headers.
- **children[1]**: `[data-test-id="expandable-content"]` — team names + odds buttons.

### Column Headers (inside header area)

```
headerArea
  └── querySelector('[class*="text-on-tertiary"]')   ← header row div
        ├── children[0]  → empty (spacer for team name column)
        └── children[1]  → flex wrapper
              ├── children[0]  → "Handicap (Incl. Overtime and Penalties)"
              ├── children[1]  → "Total (Incl. Overtime and Penalties)"
              └── children[2]  → "Winner (Incl. Overtime and Penalties)"
```

Column index is consistent between header and odds rows — use it to find the right market.

### Odds Row Structure (inside expandable-content)

```
[data-test-id="expandable-content"]
  └── div.overflow-hidden
        └── div.cv-auto
              └── div.grid.grid-cols-2  (grid)
                    ├── children[0]  → team names column
                    │     ├── children[0]  → home team (BOS Bruins)
                    │     └── children[1]  → away team (BUF Sabres)
                    └── children[1]  → odds column
                          └── children[0]  → div.flex-1.flex.justify-center.gap-x-1  (oddsInner)
                                ├── children[0]  → Handicap odds
                                ├── children[1]  → Total odds
                                └── children[2]  → Winner odds
                                      └── querySelectorAll('button[data-test-id="odd-button"]')
                                            ├── [0]  → home team odds (1.89)
                                            └── [1]  → away team odds (1.98)
```

## Odds Buttons

- **Selector**: `button[data-test-id="odd-button"]`
- Row index matches team order: `0` = home/team1, `1` = away/team2.
- Clicking via `button.click()` works even when the expandable-content is visually collapsed.

## Bet Slip Panel

Appears on the right side of the page after clicking an odds button.

| Element | Selector |
|---------|----------|
| Bet slip item (per bet) | `[data-test-id="betslip-item"]` |
| Stake input | `[data-test-id="stake-0"]` |
| Footer / Place bet area | `[data-test-id="betslip-footer"]` |
| Place bet button | `button` with text `"Place bet"` inside betslip-footer |

- Stake input is also React-controlled — use the same native setter + `input` event trick.
- After filling, "To return" updates immediately (confirmed: ¥5319 → ¥10532 at 1.98×).

## Tab Navigation by Sport + Market

Soccer has a different tab structure than basketball/hockey:

| Sport | Market | Tab | Card |
|-------|--------|-----|------|
| basketball/ice_hockey | any | `?tab=popular` | "Game lines" card |
| soccer | 1x2 | `?tab=main` (default) | "Full Time Result" card |
| soccer | over_under | `?tab=goals` | "Total Goals" card |
| soccer | handicap_2way | `?tab=asianLines` | "Asian Handicap" card |

The adapter appends the right tab in `navigateToEvent` by reading `betData.sport` + `betData.market.type` from `chrome.storage.local.cloudbetState` (written by the runner just before navigation).

## Market Type → Column Name Mapping

| Signal `market.type` | Sport | Cloudbet column (EN) |
|---|---|---|
| `handicap_2way` | basketball/ice_hockey | `Winner (Incl. Overtime and Penalties)` |
| `over_under` | basketball/ice_hockey | `Total (Incl. Overtime and Penalties)` |
| `1x2` | soccer | `Full Time Result` |
| `over_under` | soccer | Card title: **`Total Goals`** (Goals tab `?tab=goals`, `findSectionByTitle` with minButtons=2) — **moved from Main to Goals tab, updated 2026-05-15** |
| `handicap_2way` | soccer | Card title: **`Asian Handicap`** (Asian lines tab, `findOddsSection`) |

**Soccer OU structure (Goals tab, verified 2026-05-15):**
- "Total Goals" card shows only the featured line (e.g. line 3). Other lines (2.5, 3.5 …) are in separate sections further down the Goals tab.
- Adapter searches the **whole page** (`document`) for a leaf element matching `leg.line`, then walks up to find the ancestor with exactly 2 odd-buttons (that line's row), and picks Over=0 / Under=1.
- Do NOT scope the search to the "Total Goals" section — the target line is often outside it.

## Selection → Row Index Mapping

| Signal `selection` | Row index |
|---|---|
| `"1"` / `"Over"` | `0` (home / team1) |
| `"2"` / `"Under"` | `1` (away / team2) |

## Cloudbet Team Name Abbreviations

Search results and event pages use abbreviated names:
- "Buffalo Sabres" → "BUF Sabres"
- "Boston Bruins" → "BOS Bruins"

When searching, use the last word of the full team name (e.g., "Sabres"). This avoids abbreviation mismatches and still uniquely identifies the team.

## Tennis (explored 2026-06-16)

Explored: Hynek Barton v Kimmer Coppejans, ATP Challenger Poznan, event ID 34961802, kickoff June 16, 2026 6:00 PM (confirmed future/not-yet-started — no "LIVE" badge, no Set-2+ markets rendered, page copy says "Lock in your picks before the first ball toss").

Event URL: `https://www.cloudbet.com/en/sports/tennis/challenger-atp-challenger-poznan-poland-men-singles/34961802`

Tennis uses a different query param name than other sports: **`?markets-tab=...`** (soccer/basketball/hockey use `?tab=...`). Tab buttons are plain `<button>`s with no `href`; clicking one updates the URL via client-side routing. Observed values: `popular` (default), `sets`, `games`, `all`.

### Match Winner ("Winner")

- **Section title**: `"Winner"` (not "To Win Match" / "Match Winner" / "Moneyline").
- **Tab**: `?markets-tab=popular` (default tab when no param given).
- Card structure matches the existing hockey/soccer pattern: `findTitleEl('Winner')` → walk up ancestors to the first one containing exactly 2 `button[data-test-id="odd-button"]`.
- **Button index → player mapping**: `0` = player1 (first-listed name, e.g. "Barton"), `1` = player2 (second-listed name, e.g. "Coppejans"). Verified via button text: `"Barton1.76"`, `"Coppejans2.09"`. Same index convention as soccer/hockey home/away.
- No draw outcome (tennis is always 2-way).

### 1st-Set Total Games ("Total games in set 1")

- **Section title**: `"Total games in set 1"` — exact string, lowercase "set".
- **Tab**: only renders under **`?markets-tab=all`** ("All markets"). It is listed by name in the "Sets" and "Games" tab's market-search dropdown menu but the card itself does **not** render on either of those tabs — only on `all`. Don't assume the obviously-named tab has the market; check `all` first for any set/game-number-specific market.
- **Over/Under labels are present as DOM text**, not index-only: header row has `data-test-id="market-header-0"` (empty spacer), `market-header-1` = `"Over"`, `market-header-2` = `"Under"`. Button order matches: index `0` = Over, index `1` = Under.
- **Each line is its own row** with exactly 2 odd-buttons, structure:
  ```html
  <div class="flex-1 flex items-center justify-center h-full flex-wrap gap-1">
    <span class="...">8.5</span>                          <!-- line value, plain text, NOT a button -->
    <div class="w-full flex-1 flex justify-center"><button data-test-id="odd-button">1.33</button></div>  <!-- Over -->
    <div class="w-full flex-1 flex justify-center"><button data-test-id="odd-button">3.25</button></div>  <!-- Under -->
  </div>
  ```
  This match had 3 lines simultaneously rendered: 8.5, 10.5, 12.5 (6 odd-buttons total under the card). Same approach as the soccer-goals adapter: search the page for a leaf node whose `textContent.trim()` equals `leg.line`, then take its parent row and pick Over=button[0]/Under=button[1] (or just the two sibling `<button>` descendants of that row).
- Per-player "Total Games" (e.g. "Hynek Barton Total Games") is a **separate** market/card from the unqualified "Total Games" and from "Total games in set 1" — don't confuse them when matching by partial title text; match the full title exactly.

### Full-match Total Games ("Total Games")

Explored: Adrian Mannarino v Arthur Fery, ATP London, event ID 34986535, scheduled 17 Jun 21:50 (GMT+9), confirmed pre-match (countdown "Match Start" displayed, no "LIVE" badge on the match — "Bet Builder is live" refers to the feature, not the match).

- **Section title**: `"Total Games"` — exact string, capital T and G. Distinct from per-player cards ("Adrian Mannarino Total Games") and "Total games in set 1" (lowercase "games").
- **Tab**: `?markets-tab=all`. Present on the `all` tab alongside `Winner`, `Game Handicap`, `Total games in set 1`, etc.
- **Structure**: identical to "Total games in set 1". Multiple lines rendered simultaneously (observed 5 lines: 21.5, 22, 22.5, 23, 23.5 = 10 buttons total). Each line is its own row with exactly 2 odd-buttons: `button[0]` = Over, `button[1]` = Under. The "Over"/"Under" column header labels are present in the DOM (same `market-header-*` pattern as set-1 card) and spatially confirm the ordering: Over header aligns with btn[0], Under header aligns with btn[1].
- **Adapter**: scope line search to the section (`findSectionByTitle('Total Games', 2)`) to avoid matching per-player "Total Games" cards. Walk up from line leaf to ancestor with 2 buttons, pick Over=0/Under=1. This is identical logic to the set-1 branch — the only difference is the section title.

### 1st-Set Winner ("Winner of set 1")

Same exploration: Mannarino v Fery, event 34986535.

- **Section title**: `"Winner of set 1"` — exact string. NOT "1st set - winner" / "Set 1 winner" / "Winner (set 1)".
- **Tab**: `?markets-tab=all`. Does NOT render on the `popular` tab (only "Winner" match-winner renders there by default).
- **Structure**: exactly 2 buttons (no draw). `button[0]` = player1 (Mannarino, 1.81), `button[1]` = player2 (Fery, 1.98). Same index convention as the match-winner "Winner" card and all other 2-way tennis cards.
- **Adapter**: `findSectionByTitle('Winner of set 1', 2)` scopes the section; then `{ '1': 0, '2': 1 }[leg.selection]` picks the button. The `findOddsButton` branch is the same as the match-winner branch — `findMarketSection` already picks the right card based on `market.period`.

### Quirks

- Tennis matches with no live indicator can still only show Set-1-scoped markets in the popular/sets/games tabs if the match hasn't started; this is expected, not a loading bug.
- The market-search dropdown (visible by clicking into "Search all markets..." or just reading its option list) names markets that exist for the event but may not be rendered as cards on the currently selected tab — always re-check on `?markets-tab=all` before concluding a market is absent.
- No "Show more" expander was needed to reveal the 1st-set games card; it appears directly on the `all` tab without extra interaction. (Did not test live/in-play matches, which add per-set/per-game live markets — those may behave differently.)
- "Bet Builder is live" appears on the page for pre-match events — this text does NOT mean the match is live. Confirm live status by checking for the "LIVE" badge adjacent to the scoreboard or the "Markets are live" message, not by scanning all page text.
- A completed match still shows a "Winner" card and "Total Games" card in the DOM (for post-match settlement display), but lacks 1st-set markets. Don't test the 1st-set winner card on finished matches.
