# GGBet DOM Notes

Explored: 2026-05-14 — Detroit Pistons v Cleveland Cavaliers (NBA)

## Architecture

GGBet is a **standard React SPA** — no Shadow DOM, no meaningful iframes for the sportsbook. All selectors work directly on `document`. Stable `data-test` attributes are used throughout.

## URL Structure

```
Event page: https://gg.bet/sports/match/{team1-slug}-vs-{team2-slug}-{DD}-{MM}
Sport listing: https://gg.bet/sports?sportId={sportId}
```

**IMPORTANT**: The `DD-MM` at the end of the event slug is NOT always the game date — it appears to be the date when the event was first listed. Do NOT construct event URLs from the game date. Instead, scan `a[href*="/sports/match/"]` on the listing page and match by team name slug.

Sport ID values: `basketball`, `ice_hockey`, `football` (soccer — NOT "soccer")

## Search / Event Discovery

GGBet has a search button that opens an inline text input. Typing into it does **NOT filter** the event cards on the listing page. Instead:

1. Navigate to `gg.bet/sports?sportId={sport}` (event card links are all on this page).
2. Click `button[textContent="search"]` to open the inline input (`[data-test="base-input__input-undefined"]`).
3. Type team name into input (harmless — doesn't filter, but runner.js requires an input element).
4. In `findEventResult`, scan `a[href*="/sports/match/"]` and match by slug content:
   - `lastWord("Minnesota Wild")` = `"wild"` matches slug `"...minnesota-wild-..."`

`isLandingPage`: `path.startsWith('/sports') && !path.startsWith('/sports/match')`  
`isEventPage`: `path.startsWith('/sports/match/')`

## Market Sections

Each market is a card div. Hierarchy (level 0 = innermost):

| Level | Element | Key Attribute |
|---|---|---|
| 0 | Market name label | `[data-test="market-name"]` |
| 1 | Header row (toggle) | `[data-category="Match - Markets"][data-action="Toggle market group"]` |
| 2 | Cursor wrapper | `div.cursor-pointer` |
| 3 | **Market card** | (no stable id — use parentElement×3 from label) |

Within the market card: `[data-test="market-group"]` contains all outcomes.

### Market Name → Signal Mapping (verified 2026-05-14)

| Signal `market.type` | `market.period` | Sport | GGBet `market-name` text |
|---|---|---|---|
| `1x2`           | `null`     | soccer      | `"1x2"` |
| `over_under`    | `null`     | soccer      | `"Total"` |
| `over_under`    | `ot_incl`  | basketball  | `"Total (incl. overtime)"` |
| `over_under`    | `ot_incl`  | ice_hockey  | `"Total"` (bare — GGBet's NHL Total IS OT-inclusive) |
| `handicap_2way` | `null`     | soccer      | `"Handicap"` |
| `handicap_2way` | `ot_incl`  | basketball  | `"Handicap (incl. overtime)"` |
| `handicap_2way` | `ot_incl`  | ice_hockey  | `"Handicap"` (bare — same reason) |

**CRITICAL**: Hockey `ot_incl` and soccer `null` both map to bare `"Total"`/`"Handicap"`. The adapter uses `betData.sport` (passed via runner.js 4th arg to `findMarketSection`) to distinguish them.

Verified: basketball NBA (Pistons v Cavaliers, 2026-05-14), soccer LaLiga (Real Madrid v Real Oviedo, 2026-05-14), ice hockey NHL (Avalanche v Wild, 2026-05-14).

## Outcome Structure

Each outcome button: `[data-action="Select odd"]` (the clickable div)

Inside each button:
- `[data-test="odd-button__title"]` — selection label
- `[data-test="odd-button__result"]` — odds value

**Selection label formats:**

| Market type | Example label | Notes |
|---|---|---|
| `over_under` | `"over 206.5"` / `"under 206.5"` | lowercase, space-separated |
| `handicap_2way` | `"-9.5"` / `"+9.5"` | **explicit `+` for positive lines** (unlike betfury which uses parens) |
| `1x2` | `"Detroit Pistons"` / `"draw"` / `"Cleveland Cavaliers"` | full team name |

**CRITICAL for handicap**: leg.line is a bare number (e.g., `9.5`), but GGBet shows `"+9.5"`. Adapter adds `+` prefix for non-negative lines:
```js
const n = Number(leg.line);
const lineStr = n >= 0 ? `+${n}` : `${n}`;
```

Clicking an odds button toggles it — do NOT click twice.

## Bet Slip

The bet slip is always visible as a right sidebar.

| Purpose | Selector |
|---|---|
| Slip container | `[data-test="betslip-component"]` |
| Empty indicator | `[data-test="betslip-stub"]` — text `"0Match"` when empty, `"1Match"` after selection |
| Selection item | `[data-test="betslip-odd"]` |
| Stake input | `[data-test="base-input__input-betslip-amount-input-field"]` |
| Place bet button | `[data-test="place-bet"]` — text `"Sign In & Bet"` when logged out |

**findStakeInput** must check that a bet has been added before returning the input (the input is always in the DOM, even when empty):
```js
const stub = document.querySelector('[data-test="betslip-stub"]');
if (!stub || stub.textContent.trim().startsWith('0')) return null;
return document.querySelector('[data-test="base-input__input-betslip-amount-input-field"]');
```

Stake input is React-controlled; use native setter + input event.

## Known Issues / Unverified

1. **Place Bet button text when logged in**: logged-out shows `"Sign In & Bet"`. Logged-in label unknown — `placeBetLabel` is set to `"Place Bet"` (guessed). Update after first live test.
2. **Ice hockey market naming quirk**: NHL uses bare `"Total"`/`"Handicap"` (NOT `"Total (incl. overtime)"`). GGBet's hockey Total is OT-inclusive despite the name. The adapter checks `betData.sport` to handle this.
3. **Default stake**: not observed. `clearStakeFirst: true` set for safety.

## Tennis (explored 2026-06-16, extended 2026-06-17)

**Initial exploration** (2026-06-16): `https://gg.bet/ja/sports/match/magdalena-frech-vs-eva-lys-16-06` (WTA Berlin, Singles).
**Extended exploration** (2026-06-17): `https://gg.bet/ja/sports/match/frances-tiafoe-vs-sho-shimabukuro-17-06` (ATP Halle, Singles, future match — confirmed all four target markets and JP-locale transliteration quirk).

**sportId**: `tennis` — `gg.bet/sports?sportId=tennis` works directly (no underscore/alias needed, unlike `ice_hockey`).

**Locale note**: navigating to `gg.bet/en/...` redirects back to `/ja/...` (browser/session locale, cookie-locked). Market-name text is always the **Japanese-locale string** for this session. EN equivalents below are listed for completeness but should never actually appear in practice. The `findMarketSection` branches accept both JP and EN strings via `===` for forward compatibility.

**Market list observed on a tennis event** (`[data-test="market-name"]`, JP locale, ATP Halle 2026-06-17):
```
勝者                          <- match-winner (handicap_2way, period null)
第1stセット - 勝者              <- 1st set winner (handicap_2way, period 1st_set)
ゲーム総数                     <- full-match total games (over_under, period null)
試合ハンディキャップ             <- match handicap (handicap_2way with leg.line set; existing lined-handicap path)
第1stセット - ゲーム総数         <- 1st set total games (over_under, period 1st_set)
セットハンディキャップ           <- set handicap (not supported)
セット総数                     <- total sets (not supported)
第1stセット - ゲームハンディキャップ <- 1st set game handicap (not supported)
```

### Signal type → market-name mapping (tennis)

| Signal `market.type` | `market.period` | JP market-name | EN candidates (cookie-forced, may never appear) |
|---|---|---|---|
| `handicap_2way` | `null`     | `"勝者"`                  | `"winner"` |
| `handicap_2way` | `1st_set`  | `"第1stセット - 勝者"`     | `"1st set - winner"`, `"winner - 1st set"`, `"1st set winner"` |
| `over_under`    | `null`     | `"ゲーム総数"`              | `"total games"`, `"games total"` |
| `over_under`    | `1st_set`  | `"第1stセット - ゲーム総数"` | `"1st set - total games"`, `"total games - 1st set"`, `"1st set total games"` |

**CRITICAL — substring collision**: `"勝者"` is a substring of `"第1stセット - 勝者"`, and `"ゲーム総数"` is a substring of `"第1stセット - ゲーム総数"`. The adapter MUST use `===` (exact equality), NOT `includes()`, to prevent the full-match branch from matching the 1st-set card. Verified 2026-06-17.

### Outcome button format

**Winner cards** (`handicap_2way`, line null — both full match and 1st set):
- Always exactly **2 buttons** in team1/team2 order (no draw).
- Title text = full player name or JP transliteration.
- **JP locale may transliterate player names to katakana** (e.g. `"Frances Tiafoe"` → `"ティアフォー,フランセス"`), breaking the `lastWord` name-match. The adapter tries name-match first; on failure falls back to **positional index** (`sel '1'` → button[0], `sel '2'` → button[1]). The card is always exactly 2 buttons in team1/team2 order — confirmed ATP Halle 2026-06-17.

**Total-games cards** (`over_under`, both periods):
- Format: `"over 22.5"` / `"under 22.5"` — **lowercase, space-separated** (same as soccer/basketball totals). Multiple lines offered; matched via `text === "${selection.toLowerCase()} ${line}"`.
- 1st-set totals use the same format: `"over 8.5"`, `"under 9.5"`, etc.

### Live verification (2026-06-17, Tiafoe vs Shimabukuro, ATP Halle)

All four sections found and all button picks correct:

| Market | Period | Section matched | sel '1' pick | sel '2' / Over pick | Under pick |
|---|---|---|---|---|---|
| `handicap_2way` | `null` | `"勝者"` | `"ティアフォー,フランセス"` @ 1.39 (positional) | `"Sho Shimabukuro"` @ 2.98 (name) | — |
| `handicap_2way` | `1st_set` | `"第1stセット - 勝者"` | `"ティアフォー,フランセス"` @ 1.53 (positional) | `"Sho Shimabukuro"` @ 2.50 (name) | — |
| `over_under` | `null` | `"ゲーム総数"` | Over 22.5 @ 1.67 | Under 22.5 @ 2.11 | ✓ |
| `over_under` | `1st_set` | `"第1stセット - ゲーム総数"` | Over 9.5 @ 1.49 | Under 9.5 @ 2.48 | ✓ |

Cross-period collision check: `handicap_2way` + `null` → `"勝者"` (not `"第1stセット - 勝者"`); `handicap_2way` + `1st_set` → `"第1stセット - 勝者"` (not `"勝者"`). No collision. ✓

**Event slug matching**: unchanged — `findEventResult`'s `lastWord(team)` slug-matching works for tennis without modification.
