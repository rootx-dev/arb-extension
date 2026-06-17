# Roobet DOM Notes

Explored: 2026-04-22 — BOS Bruins v BUF Sabres, NHL, event ID 2658544278950780933
Updated: 2026-04-23 — Buffalo Sabres v Boston Bruins, NHL Series
Updated: 2026-06-17 — Atmane Terence vs Medvedev Daniil, ATP Halle (tennis new markets)

## Architecture

Roobet's entire sportsbook is rendered inside a **Shadow DOM** on a single `<div>` host element.
All queries must go through the shadow root — standard `document.querySelector` returns nothing.

```js
const host = Array.from(document.querySelectorAll('div')).find(el => el.shadowRoot);
const sr = host.shadowRoot;
```

## Search Input

- **Selector**: `sr.querySelector('input[placeholder="Search"]')`
- Class: `sc-14wacgx-2 cfNTcg`
- React-controlled — use the native setter trick:
  ```js
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  setter.call(input, term);
  input.dispatchEvent(new Event('input', { bubbles: true }));
  ```

## Search Results

- Results appear as `<a>` links inside the shadow root.
- **Selector**: `sr.querySelectorAll('a[href]')` filtered by href containing both team slugs.
- Class: `bt456`
- `href` format: `https://roobet.com/sports/{sport}/{country}/{league}/{team1-slug}-{team2-slug}-{eventId}`
- Team slug: `teamName.toLowerCase().replace(/\s+/g, '-')` (e.g. "Boston Bruins" → "boston-bruins")

## Event Page URL Pattern

```
https://roobet.com/sports/ice-hockey/usa/nhl/boston-bruins-buffalo-sabres-2658544278950780933
```

- Full team names slugified — no abbreviations.
- Event ID is a large integer appended after the last `-`.

## Sports Page URL

- `/sports` — landing page (use for search phase)
- `/sports/ice-hockey-4` — Ice Hockey listing
- `/sports/ice-hockey/usa/nhl/{event-slug}` — event page (5 path segments, filter Boolean)

## Market Sections

Each market is wrapped in a container div with exactly 2 children:
- `children[0]` — header row (contains title span + collapse button)
- `children[1]` — unnamed div — odds content

**Note**: The `bt*` class names on the container change with builds (was `bt251`, now `bt356`). Use structure + stable classes to identify sections.

### Finding a market section by name

```js
const span = Array.from(sr.querySelectorAll('span'))
  .find(el => el.textContent.trim() === marketTitle);
// Walk up 5 parentElement calls:
// SPAN → bt360 → bt359 → bt358 → bt368 → bt356 (section container)
// bt-numbers change per build, but the 5-level walk is stable
let node = span;
for (let i = 0; i < 5; i++) node = node.parentElement;
// Validate: children[1] must contain sc-7elhv3-0 clickable buttons
```

## Odds Buttons

Inside section.children[1] (the unnamed odds div):

```
div (unnamed)
  └── div.sc-2gsnxx-0.DjnCi.bt353  — row of bets (bt-number changes with builds)
        ├── div.sc-7elhv3-0.jTEjvt.sc-9oeyuj-0.jIJSdy  [onclick=true]  — home/team1 bet
        │     ├── div.bt288  — icon/spacer
        │     ├── div.sc-7elhv3-2.dwaytB → span.sc-7elhv3-3.dJEQNf  — team name
        │     └── div.bt292.sc-7elhv3-1.czyPR → span.bt294  — odds value
        └── div.sc-7elhv3-0.jTEjvt.sc-9oeyuj-0.jIJSdy  [onclick=true]  — away/team2 bet
```

**IMPORTANT**: The `bt*` numbered classes change with every build. Use stable `sc-*` prefixed classes:
- Clickable bet buttons: `[class*="sc-7elhv3-0"]` — this IS the button, no need to walk up
- Team name span: `[class*="sc-7elhv3-3"]`

Finding clickables: `oddsArea.querySelectorAll('[class*="sc-7elhv3-0"]')`
Each button's `textContent` contains team name + odds value (e.g. "Buffalo Sabres1.65")

## Bet Slip

Opens automatically when an odds button is clicked (no separate toggle needed).

| Element | Selector |
|---------|----------|
| Stake input | `sr.querySelector('input[inputmode="decimal"]')` |
| PLACE BET button | Yellow button in betslip panel (user clicks manually) |

- Stake input is React-controlled — use the same native setter + `input` event trick.
- After filling stake, "POTENTIAL WIN" updates in real time.

## Market Type → Roobet Title Mapping

Hockey/basketball event pages render **two Total sections** in DOM order:
`"Total"` (regulation) first, then `"Total (incl. overtime and penalties)"`
second. An `includes("total")` match latches the regulation section. For
OT-incl signals, use the longer title verbatim so the includes-match only
hits the OT-incl section. Only one `Winner` section exists (the OT-incl
one), so the same precaution isn't strictly required there but the longer
title is used uniformly for symmetry.

**IMPORTANT**: The adapter uses **exact `===` match** on the title span text
(not `includes`). This prevents "Winner" from accidentally matching
"First set - winner" when tennis period-variant sections are present.

| Signal `market.type` | `market.period` | Sport | Roobet section title |
|---|---|---|---|
| `1x2` | (any) | any | `1x2` |
| `handicap_2way` | `ot_incl` | hockey/basketball | `Winner (incl. overtime and penalties)` |
| `handicap_2way` | `null` | non-tennis | `Winner` |
| `handicap_2way` | `null` | tennis | `Winner` |
| `handicap_2way` | `1st_set` | tennis | `First set - winner` |
| `over_under` | `ot_incl` | hockey/basketball | `Total (incl. overtime and penalties)` |
| `over_under` | `null` | non-tennis | `Total` |
| `over_under` | `null` | tennis | `Total games` |
| `over_under` | `1st_set` | tennis | `First set - total games` |

## Tennis

Verified 2026-06-17 — Atmane Terence vs Medvedev Daniil, ATP Halle Germany (future match).

### Section titles (live-verified)

| Market | Period | Section title (exact) |
|---|---|---|
| `handicap_2way` | `null` | `Winner` |
| `handicap_2way` | `1st_set` | `First set - winner` |
| `over_under` | `null` | `Total games` |
| `over_under` | `1st_set` | `First set - total games` |

All four sections appear as top-level `[title, odds]` two-child containers in the shadow DOM (same structure as non-tennis sections). `findMarketSection` uses exact `===` title match to avoid "Winner" ⊂ "First set - winner" substring collision.

### Button text format

- **Winner / First set - winner**: `"<player name><odds>"` e.g. `"Atmane, Terence3.2"` — player name match via `lastWord`.
- **Total games / First set - total games**: `"over 21.51.6"` / `"under 8.55.0"` — same `"<side> <line><odds>"` format as other OU markets. Match by `startsWith("over 21.5")` / `startsWith("under 8.5")`.

The total-games sections contain 10+ buttons (5+ lines × 2 sides). Prefix-match is unambiguous for half-point lines.

## OU button text format

Each side has its own button per line: `"over 5.51.58"` / `"under 5.52.38"`
— `"<side> <line><odds>"` with a space between side and line but **no
space** between line and odds. Match by `"<side> <line>"` prefix
(`startsWith`, lowercase) since `lastWord("Over")` alone hits the first
over-button regardless of line.

The OU section can contain 14+ buttons (7+ lines × 2 sides). Prefix-match
with `"over 5.5"` only matches the 5.5 line. Caveat: integer lines like
`5` would prefix-match `5.5` too if Roobet displays them as `"over 5"`;
half-point lines (the common case for signals) are unambiguous.

## Selection → Row Index

| Signal `selection` | Row index |
|---|---|
| `"1"` / `"Over"` | `0` (home / team1) |
| `"2"` / `"Under"` | `1` (away / team2) |
