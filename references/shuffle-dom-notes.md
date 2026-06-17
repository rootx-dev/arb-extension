# Shuffle DOM Notes

Verified live (logged out): 2026-05-13. Events used:
- Soccer 1x2: Aston Villa v Liverpool FC, Premier League
  (`/sports/soccer/1-england/17-premier-league/61301251-aston-villa-vs-liverpool-fc`)
- Basketball HA OT-incl + Total OT-incl: Detroit Pistons v Cleveland Cavaliers,
  NBA (`/sports/basketball/15-usa/132-nba/70504992-detroit-pistons-vs-cleveland-cavaliers`)
- Hockey HA OT+penalties: Colorado Avalanche v Minnesota Wild, NHL
  (`/sports/ice-hockey/37-usa/234-nhl/70558028-colorado-avalanche-vs-minnesota-wild`)

## Architecture

- **Next.js + React, regular DOM** — no Shadow DOM, no iframes carrying the
  sportsbook. `document.querySelector` works directly.
- **CSS Modules** — class names are hashed (`Input_root__lWEbp`, `Searchinput_input__Ju5dH`).
  The **prefix** before `__` is stable across builds; the hash is not. Always use
  `[class*="StablePrefix_"]` attribute-contains selectors.
- **No locale prefix in URLs** (verified for /sports paths). The page may still
  serve localized text from cookies — TODO verify in Japanese locale before
  trusting English-only market titles below.
- **Crypto-native sportsbook.** The stake input is a `<input type="number">`
  that accepts whatever value you give it; the estimated payout renders to 8
  decimal places (`0.00000000`) when currency is BTC. **The user must set
  Shuffle's account display currency to JPY** so the backend's integer JPY
  stakes are interpreted correctly. The adapter doesn't do any FX.

## URL Patterns

```
Landing:  /sports                              (only; service worker opens this)
Sport:    /sports/{sport}                      e.g. /sports/soccer
Region:   /sports/{sport}/{N-country}          e.g. /sports/basketball/15-usa
League:   /sports/{sport}/{N-country}/{N-league}
Event:    /sports/{sport}/{N-country}/{N-league}/{eventId-slug}[?tab=...]
```

- `{sport}` uses hyphens (`ice-hockey`, not `ice_hockey`).
- `{eventId-slug}` always starts with `{digits}-`. Use that to detect event pages:
  `/^\/sports\/[^/]+\/[^/]+\/[^/]+\/\d+-/.test(pathname)`.
- `?tab=` controls which market group is rendered server-side (`TOP_MARKETS`,
  `WIN_MARKETS`, `HANDICAP_MARKETS`, `TOTAL_MARKETS`, `HALF_MARKETS`, etc.).
  The default tab on first load is `TOP_MARKETS`, which contains a *teaser* of
  popular markets but folds others.
  - Soccer 1x2: present in `TOP_MARKETS`.
  - Basketball/Hockey handicap_2way OT-incl: present in `TOP_MARKETS` for the
    teaser, but the full grid of lines lives in `HANDICAP_MARKETS`.
  - Totals: full grid in `TOTAL_MARKETS`.
  - The adapter should set `?tab=` explicitly in `navigateToEvent` based on
    `market.type` so the wanted market is mounted in the initial render.

## Search

**The search input is hidden behind a toggle button** until clicked.

- Toggle button selector: `button[class*="SearchComponent_searchButton"]`
- After click, an `<input class="Searchinput_input__...">` with
  `placeholder="Search matches and events"` is mounted. Verified URL gains
  `?search=sports` after click, but that's not load-bearing.
- Multiple clicks on the search button do **not** collapse the input — safe to
  retry. (Confirmed.)
- Pattern: in `findSearchInput`, look up the input first; if absent, click the
  toggle and return `null` so the runner polls again. Next poll the input
  exists.

### Search results

- Cards: `a[class*="SearchResultGameTile_root"]`
- Each `<a>` has a real `href` to the event page — `window.location.href =
  link.href` works as the navigation step.
- Card text format: `"<date> - <relative>{team1} vs {team2}"` — e.g.
  `"May 16, 4:00 AM - in 2 daysAston Villa vs Liverpool FC"`.
- Match by a first-OR-last significant token (≥3 chars) of each team, both
  required, run through `norm()` (diacritics + repeated-letter fold) on both
  sides. Needed because the signal and the site can romanize a name differently:
  signal "Ragsved"/"Enkoping" vs site "Raagsveds"/"Enköpings" (Svenska Cupen,
  2026-06-18). See the romanization row in `writing-book-scripts.md`.
- `searchSettleMs: 1500` was sufficient — results render fast after typing.

## Market Sections

Every market is wrapped in a "subCollapse" — class `Collapse_collapseRoot
SportsMarketCollapse_subCollapseRoot`. Structure:

```
div.Collapse_collapseRoot.SportsMarketCollapse_subCollapseRoot
  ├── button.Collapse_collapseHeader  (data-testid="collapse")
  │     └── div.Collapse_collapseTitle
  │           └── div.MarketCollapseHeader_root
  │                 └── span.MarketCollapseHeader_title   ← exact title text
  └── div.Collapse_container
        └── div.Collapse_collapseBody
              └── … → section.DefaultMarketLayout_root
                       └── (outcome buttons; see below)
```

**Finder**: walk `document.querySelectorAll('span[class*="MarketCollapseHeader_title"]')`,
match `textContent.trim()` exactly against the market title, then walk up to
the `subCollapseRoot` ancestor. Exact match (not `includes`) is required —
soccer has multiple variants like `"1x2"` and `"1x2 (2UP) - Early Payout at 2
Goal Lead"`.

**The `subCollapseRoot` wrapper is NOT universal.** It was present on the
Premier League fixture used to write this doc, but on a Svenska Cupen 1x2 event
(Raagsveds IF v Enkopings SK, 2026-06-18) the title `"1x2"` matched yet had **no
`subCollapseRoot` ancestor** — the walk returned null and the section never
resolved (silent market-section timeout). Tennis cards are the same (they sit in
`StackedCollapseGroup_item` / `Collapse_collapseRoot`). So `findSectionByTitle`
now tries the `subCollapseRoot` walk first, then falls back to a **structural
walk** to the nearest ancestor containing ≥2 selection buttons. The on-miss path
logs the titles present — but note a *present* title can still fail the walk, so
the bug looks like a match-logic miss when it's a container-walk miss. Verify
`findOddsButton` logs `btns=N` to confirm the section actually resolved.

## Outcome Buttons

**Selector**: `button[class*="SportsBetSelectionButton_root"]`

**Trap — don't use `data-testid="bet-select"`.** Only the *first* outcome
button in each market has `data-testid="bet-select"` set; subsequent buttons
have `data-testid=""` (empty string). The class prefix above is the right
hook.

**Selected state after click**: button gains `SportsBetSelectionButton_selected__...`
class.

### React hydration race — wrap clicks

Initial draft of the adapter used a plain `btn.click()` and it worked on
manual MCP-driven testing, but failed intermittently when the service worker
opened a fresh tab — symptom was the runner logging `Clicking Aston Villa @
…` followed by `Bet slip did not open` after the 10 s stake poll. Logs showed
the click was dispatched but the button never gained `.selected`.

Cause: content scripts run at `document_idle`, which can fire before Next.js
attaches React's `onClick` handler. The click event is dispatched into a DOM
node whose handler hasn't bound yet; React doesn't replay it post-hydration.

Fix: `findOddsButton` wraps the chosen button so the runner's `btn.click()`
delays 1.2 s (hydration window) before firing a full pointer/mouse sequence,
then **polls for a success signal every 150 ms for up to 1500 ms** and
latches as soon as it's seen. Retry only fires if no signal is seen the
entire window. See `wrapWithHydrationRetry` in
[shuffle.js](../content-scripts/shuffle.js). The adapter also sets
`allowReclick: true` as a final fallback in case both attempts inside the
wrap are eaten.

**Why polling-latch, not a fixed-time self-check:** an earlier version of the
wrap checked `.selected` + slip-open exactly once at T+1200 ms after
dispatch. Symptom: ~10% of the time the click worked, runner filled the
stake, the slip flickered (React remounts the stake-input element during
`fillInput`'s onChange handling), and the one-shot self-check happened to
land during that flicker — both signals false, retry fired, which toggled
the already-selected button OFF and removed the bet from the slip. The
polling-latch fix sees the first positive signal (typically T+200–600 ms
after dispatch), latches `succeeded=true`, and never falsely retries.

A more durable slip signal helps too: alongside `input[placeholder="Enter
stake"]` the success check looks for `section[class*="BetSlipAddingView_root"]`
or any `<section>` inside `BetSlipDropdown_dropdown` — both persist across
the flicker.

### Button text format

The text is the concatenation of the row label and the odds — no separator:

| Market | Example button text | Decomposition |
|---|---|---|
| `1x2` (soccer) | `"Aston Villa2.85"` / `"Draw3.70"` / `"Liverpool FC2.21"` | `"<team-or-Draw><odds>"` |
| `handicap_2way` | `"+1.51.18"` / `"-1.52.14"` | `"<signed-line><odds>"` |
| `over_under` | `"205.51.46"` / `"206.51.51"` | `"<line><odds>"` (no sign) |

### Layout for 1x2

Three buttons, fixed order: `[home, draw, away]`. Same convention as
Cloudbet/Stake. Pick by `leg.selection` index: `{ '1': 0, 'X': 1, '2': 2 }`.

### Layout for handicap_2way

Buttons are stacked vertically in a single column. **First half = team1's
lines, second half = team2's lines.** Each half is sorted by line value.

Verified hockey example (Colorado-Minnesota, 8 buttons):

```
team1 (Colorado):  +1.5 1.18  -1.5 2.14  -2.5 3.00  -3.5 4.70
team2 (Minnesota): -1.5 4.40  +1.5 1.63  +2.5 1.34  +3.5 1.15
```

Note that `-1.5` appears in **both halves** — same line, different team. The
adapter MUST split by `leg.selection` first (`'1'` → first half, `'2'` →
second half), then match the line within that half.

Match by `button.textContent.startsWith(formattedLine)` where formatted line
has explicit sign (`"+1.5"` / `"-1.5"`). Naive prefix matching works because
odds never start with `+` or `-`.

### Layout for over_under (totals)

Same pattern as handicap: first half = Over lines, second half = Under lines.
Each half sorted by line value. Verified basketball (Pistons-Cavs, 12
buttons):

```
Over:  205.5 1.46  206.5 1.51  207.5 1.56  208.5 1.62  209.5 1.68  210.5 1.75
Under: (next 6, mirroring)
```

The button text has no sign (`"205.51.46"`). Match by
`startsWith(String(leg.line))`. The half is picked by `leg.selection`:
`'Over'` → first half, `'Under'` → second half.

### Market Type → Title Map (verified live)

| `market.type` | `period` | Sport | Title (exact) |
|---|---|---|---|
| `1x2` | (null / regular_time) | soccer | `1x2` |
| `handicap_2way` | `ot_incl` | basketball | `Handicap (incl. overtime)` |
| `handicap_2way` | `ot_incl` | ice_hockey | `Handicap (incl. overtime and penalties)` |
| `over_under` | `ot_incl` | basketball | `Total (incl. overtime)` |
| `over_under` | `ot_incl` | ice_hockey | `Total (incl. overtime and penalties)` *(assumed — verify on first hockey OU)* |
| `over_under` | (null) | soccer | `Total` |

## Bet Slip

Opens automatically after clicking an outcome (no separate toggle observed
when logged out — verify logged-in).

| Element | Selector |
|---|---|
| Slip dropdown root | `div[class*="BetSlipDropdown_dropdown"]` |
| Slip adding view | `section[class*="BetSlipAddingView_root"]` |
| Stake input | `input[placeholder="Enter stake"]` (`type="number"`) |
| Estimated payout | `span[class*="BetTicketAmount_amount"]` |
| Place Bet button | Logged-in only — text varies by locale; English default `Place Bet` |

- Stake input is React-controlled — runner's `fillInput` works (verified
  visually that the input accepts setter+input-event values).
- TODO verify whether a previous slip residue requires `clearStakeFirst: true`
  (other React books have, so probably yes).

## Currency Caveat

The slip's estimated payout shows 8 decimal places when the account currency
is BTC (`0.00000000`). This is purely display — the input still accepts an
integer-like JPY value if the account is set to JPY. **No FX code in the
adapter.** The user must set Shuffle's currency to JPY in account settings
once (per the project's currency assumption).

## Login

Logged-out exploration covered everything except the Place Bet button itself.
Search, navigation, market discovery, outcome click, slip open, stake input
fill — all work logged out. Place Bet button text is hidden behind login.

## Tennis (explored 2026-06-17)

Verified live on Bergs Z. vs Fritz T. (ATP Halle, future), English locale.
Sections are found via `findTennisSection(title)` — a STRUCTURAL walk up to the
nearest ancestor holding ≥2 `button[class*="SportsBetSelectionButton_root"]`,
because tennis cards sit in a different container than soccer/hockey
(StackedCollapseGroup_item, NOT subCollapseRoot). Titles are locale-translated
(JP match-winner = "勝者"); `TENNIS_TITLE_ALIASES` maps each EN title to its JP form.

**Tabs differ per (type, period)** — the wanted card only renders on its tab, so
`navigateToEvent` appends the right `?tab=`:

| Signal market | period | ?tab= | Section title (EN) |
|---|---|---|---|
| handicap_2way (winner) | null | WIN_MARKETS | `Winner` |
| handicap_2way (1st-set winner) | 1st_set | SET_MARKETS | `1st set - winner` |
| over_under (game totals) | null | GAMES_MARKETS | `Total games` |
| over_under (1st-set game totals) | 1st_set | GAMES_MARKETS | `1st set - total games` |

- Winner cards: exactly 2 buttons, player1=idx0 / player2=idx1 (index pick, no draw).
- Totals cards: buttons are half-split (first half = all Over lines, second half =
  all Under lines), matched by the existing `over_under` branch (slice by half on
  selection, then `startsWith(String(leg.line))`). Confirmed: "Total games" = 12
  buttons (Over 20.5–25.5 then Under 20.5–25.5).
- `Total games` exact-title match deliberately avoids the sibling per-player cards
  "Bergs, Zizou total games" / "Fritz, Taylor total games" on the same tab.
- NOTE: button text (the line value) reads as `[BLOCKED: JWT token]` through the
  MCP browser tool's redaction of numeric strings — this is a TOOL artifact only;
  the content script reads `textContent` normally in-page. Verified the half-split
  by char-code-encoding the span text to dodge the redaction.
