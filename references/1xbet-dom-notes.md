# 1xBet DOM Notes

Explored: 2026-05-14 — Anaheim Ducks vs Vegas Golden Knights (NHL), 1xbetjap.com

## Domain

1xbet operates under many country-specific mirror domains:
- `1xbetjap.com` (Japan — verified)
- `1xbet.com` (international)
- Many other regional mirrors

The manifest and BOOK_URLS should match the domain the user actually logs in with.
The URL structure is identical across all mirrors.

## No Shadow DOM

```js
document.querySelectorAll('*').filter(el => el.shadowRoot).length === 0
```

## Architecture: Nuxt + Canvas market grid

1xbet uses a multi-app Nuxt setup. Key globals:
- `window.nuxtApp__BETTING_APP__` — Vue app hosting the event page
- `window.useNuxtApp()` — returns the active Nuxt app (includes `$router`)

**Critical**: The market grid (`div.game-panel__markets`) renders entirely on `<canvas>` elements — there are NO DOM elements for market names or odds buttons. All market data lives in the Pinia `game` store.

```
div.market-grid--theme-gray-60.market-grid.game-panel__markets
  └── div.market-grid-canvas.market-grid__canvas
        └── div.market-grid-canvas__container
              ├── canvas.market-grid-canvas__canvas   ← main render canvas
              └── canvas.market-grid-canvas__offscreen-canvas
```

This means the adapter cannot use `findMarketSection` / `findOddsButton` in the normal DOM way. Instead it accesses Pinia stores and returns a fake element with a patched `.click()`.

## Pinia Store Access

There are TWO Vue app instances on 1xbet event pages:
- **Host app** at `#__V3_HOST_APP__`: stores `global`, `screen`, `seo`, `userConfig`, `account`, `abTestsStore`, `navigation`, `contacts`, `licenses` — does NOT have `game` or `coupon`.
- **Betting sub-app**: stores `global`, `screen`, `coupon`, `media`, `betting`, `userConfig`, `account`, `game` — this is the one needed.

Use `.game-panel` as the anchor to find the betting sub-app — it is mounted before the canvas renders (even during skeleton loading). Walking up from `.market-grid-canvas__canvas` also works but the canvas only renders AFTER market data loads, causing a race with the runner's 15s timeout.

```js
function getVueApp() {
  let el = document.querySelector('.game-panel');
  if (!el) return null;
  for (let i = 0; i < 20 && el; i++) {
    if (el.__vue_app__) return el.__vue_app__;
    el = el.parentElement;
  }
  return null;
}
const pinia = getVueApp().config.globalProperties.$pinia;
const gameStore   = pinia._s.get('game');
const couponStore = pinia._s.get('coupon');
```

Store IDs (betting sub-app): `global`, `screen`, `coupon`, `media`, `betting`, `userConfig`, `account`, `game`

## Game Store: market data

`gameStore.$state.marketGroups` — array of market group objects.

Each group:
```json
{
  "id": "101:38:720679398",
  "foreignId": 101,
  "name": "Team Wins",
  "gameId": 720679398,
  "marketColumns": [
    [{ "name": "W1", "param": 0, "typeId": 401, "coef": 1.945, "id": "720679398-0-401-0", "gamePeriodId": 0, ... }],
    [{ "name": "W2", "param": 0, "typeId": 402, "coef": 1.934, "id": "720679398-0-402-0", "gamePeriodId": 0, ... }]
  ]
}
```

Outcome ID format: `"{gameId}-{param}-{typeId}-{playerId}"` (e.g. `"720679398--1.5-7-0"` for -1.5 handicap).

All markets have `gamePeriodId: 0` in the default "All markets / Regular time" view. "Team Wins" is the OT-inclusive 2-way moneyline for ice hockey (one team always wins eventually in NHL).

### Market group → signal mapping

| Signal `market.type` | `period`   | Sport      | 1xbet group name                          | Notes |
|---|---|---|---|---|
| `handicap_2way`      | `ot_incl`  | ice_hockey | `Team Wins` (line=null) / `Handicap` (line≠null) | Team Wins = 2-way moneyline; Handicap = with spread. Verified 2026-05-14. |
| `over_under`         | `ot_incl`  | ice_hockey | `Total`                                   | Verified 2026-05-14. |
| `1x2`                | `null`     | soccer     | `1X2`                                     | 3 cols: W1/X/W2. Verified 2026-05-15 (Real Madrid vs Real Oviedo, Copa del Rey). |
| `over_under`         | `null`     | soccer     | `Total`                                   | Verified 2026-05-15. |
| `handicap_2way`      | `null`     | soccer     | `Handicap`                                | Verified 2026-05-15. |
| `handicap_2way`      | `ot_incl`  | basketball | `Handicap`                                | Group name consistent with other sports — e2e unverified (no pre-match NBA available 2026-05-15). |
| `over_under`         | `ot_incl`  | basketball | `Total`                                   | Same — e2e unverified. |
| `handicap_2way`      | `null`     | tennis     | `1X2`                                     | Match-winner, no draw. 2 cols, outcomes by typeId (1=player1/"W1", 3=player2/"W2"). Verified 2026-06-16 (Andrey Rublev vs Hubert Hurkacz, ATP Halle). **NOT** the "Handicap" group (that holds spread lines). |
| `handicap_2way`      | `1st_set`  | tennis     | **NOT PRESENT**                           | No standalone 1st-set winner group in 1xbet Pinia marketGroups. `groupName()` returns `null`; the runner logs available groups and reports unsupported market. Verified 2026-06-17 (Bergs vs Fritz, ATP Halle). |
| `over_under`         | `null`     | tennis     | `Total`                                   | Full-match total games. Lines ~21–27. Outcome names: `"Over 21.5"` / `"Under 21"` (prefix format). Existing `startsWith` logic works. Verified 2026-06-17. |
| `over_under`         | `1st_set`  | tennis     | `Total 1`                                 | 1st-set total games. Lines ~10.5–12. Outcome names: `"10.5 Over"` / `"11 Under"` (**reversed** format — `param` comes first). Must match with `endsWith('Over'/'Under') && param===line`, NOT `startsWith`. Verified 2026-06-17. |

### Outcome matching

**Team Wins** (ice_hockey, handicap_2way ot_incl, line=null):
- selection '1' → `name === 'W1'` (typeId 401)
- selection '2' → `name === 'W2'` (typeId 402)

**Handicap** (ice_hockey, handicap_2way ot_incl, line≠null):
- `marketColumns[0]` = team1 outcomes, `marketColumns[1]` = team2 outcomes
- selection '1' → col 0, `outcome.param === parseFloat(leg.line)`
- selection '2' → col 1, `outcome.param === -parseFloat(leg.line)` (opposite sign)

**Total** (over_under):
- outcomes flat: `name.startsWith('Over')` / `name.startsWith('Under')` + `param === parseFloat(leg.line)`

**1X2** (soccer):
- W1 typeId=1, X typeId=2, W2 typeId=3
- selection '1' → typeId 1; 'X' → typeId 2; '2' → typeId 3

## Adding a bet: couponStore.couponAddBet

**Call signature** (discovered by intercepting canvas click with `$onAction`):
```js
couponStore.couponAddBet({ market: outcome })
```

NOT `couponStore.couponAddBet(outcome)` — it must be wrapped in `{ market: outcome }`.

Returns a Promise. After it resolves, the `bets` array is populated and the bet slip shows the bet.

`couponStore.couponSetTab(1)` opens the bet slip panel (tab index 1 = bet slip). Call this after `couponAddBet` to ensure the stake input is visible.

## Stake input

```css
input.ui-number-input__field
```

Value: pre-filled with the minimum bet amount (1000 JPY in tested session). Uses React/Vue native-setter input technique (standard runner `fillInput` should work).

## Place Bet button

When **logged out**: button text is `"REGISTRATION"`.
When **logged in**: expected `"Place Bet"` or `"Make a bet"` — **unverified, check when logged in**.

## URL pattern

```
Event page: /en/line/{sport}/{leagueId}-{leagueName}/{permanentId}-{team1slug}-{team2slug}
Example:    /en/line/ice-hockey/30619-nhl/332683856-anaheim-ducks-vegas-golden-knights
```

Sport slugs: `ice-hockey`, `football` (soccer), `basketball`

```js
isLandingPage: (path) => /^\/en\/line(\/[^/]+\/?)?$/.test(path)
isEventPage:   (path) => /\/en\/line\/[^/]+\/[^/]+\/\d+-.+/.test(path)
```

## Search

- Input: `input.ui-search-default__input` (placeholder "Search by match"), lives in the header breadcrumb bar
- Trigger: press **Enter** on the input (fillInput alone is not enough — the modal only opens on Enter)
- After Enter: a search modal appears with `.games-search-modal-game-card` result cards
- Result text: `span.games-search-modal-card-info__main` contains `"Team1 - Team2"`
- Clicking a card triggers **SPA navigation** (Vue router `push`) — no full page reload

### Virtual / SRL games (critical gotcha)

1xbet search returns **SRL (Soccer Robot League)** virtual simulated games alongside real pre-match events. These live at `/en/live/cyber-stream/...`, not `/en/line/...`. Content scripts are only injected on `/en/line*`, so if the adapter clicks an SRL card, `navigateToEvent` follows the SPA nav to `/en/live/...` and the runner never re-injects on the new page — the bet silently fails.

**Fix**: In `findEventResult`, skip any card whose anchor href does not contain `/en/line/`.

### findEventResult strategy

Call `findEventResult` in a polling loop (runner handles via `waitFor`):
1. If modal card not present: dispatch Enter keydown/keyup on the search input to open modal; return null (runner retries)
2. If modal present: iterate cards, **skip any card whose anchor href lacks `/en/line/`** (filters SRL virtual games), find card where text includes lastWord(team1) AND lastWord(team2)

### navigateToEvent strategy (hard-nav approach)

1xbet search cards are `<a>` tags. Extract `anchor.href` directly and set `window.location.href` — this forces a full page reload at the event URL, which re-injects the content scripts. No need to poll SPA URL changes.

The original SPA-detection loop was unreliable: the card click either caused an immediate hard nav (killing the loop) or navigated to a non-`/en/line/` URL (SRL game). Always prefer direct href extraction.

### navigateToEvent strategy

```js
navigateToEvent: async (card) => {
  const nuxt = window.useNuxtApp();
  const before = nuxt.$router.currentRoute.value.fullPath;
  card.click();  // triggers SPA navigation
  // Poll until URL changes to an event page path
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const after = nuxt.$router.currentRoute.value.fullPath;
    if (after !== before && /\/en\/line\/[^/]+\/[^/]+\/\d+-.+/.test(after)) {
      window.location.href = after;  // force full reload for runner to re-enter doFill
      return;
    }
  }
  window.location.reload();  // fallback if card click was already on the event page
}
```

## Bet slip panel

When the bet slip is collapsed (right-side tab), the stake input is not in the DOM. After adding a bet via `couponAddBet`, call `couponStore.couponSetTab(1)` to ensure the panel opens. If it still doesn't, use `openSlipPanel` to find and click the "Bet slip" toggle tab on the right.

The "Bet slip" tab button: `.user-control-dashboard-ticket` (a link element in the header). **However**, after adding a bet via the canvas (verified), the bet slip panel auto-opens — the canvas click fires `couponSetTab(1)` internally. When calling `couponAddBet` from JS, `couponSetTab` is NOT automatically called and must be invoked explicitly.

## Fake button pattern

Since no DOM button exists for odds, `findOddsButton` returns a synthetic element:
```js
const fakeBtn = document.createElement('div');
fakeBtn.click = async () => {
  await couponStore.couponAddBet({ market: outcome });
  couponStore.couponSetTab(1);
};
return fakeBtn;
```

The runner calls `fakeBtn.click()`, then polls `findStakeInput` (the stake input appears once couponAddBet resolves and the panel opens). Budget ~3s polling time — async is fast.

## Tennis (explored 2026-06-16)

Event: `https://1xbetjap.com/en/line/tennis/65187-atp-halle/342238318-andrey-rublev-hubert-hurkacz` (ATP Halle, Andrey Rublev vs Hubert Hurkacz — upcoming, not live).

**Match-winner group name: `"1X2"`** — the same group name 1xbet uses for soccer's 3-way market, NOT `"Handicap"` and NOT a tennis-specific name like "Winner"/"To Win". This was the key surprise: the old `groupName()` code routed any non-hockey `handicap_2way` with `line===null` to `"Handicap"`, which **does exist** as a real group (holding spread markets with non-null params) — so the bug was a silent wrong-group match, not a missing-group crash.

**Outcome identification: by `typeId`, not by `name` matching alone** (though `name` happens to agree). The group has exactly 2 columns (no draw column, unlike soccer's 3-column 1X2):

```json
[
  [{ "id": "729143463-0-1-0", "name": "W1", "param": 0, "typeId": 1, "coef": 2.003 }],
  [{ "id": "729143463-0-3-0", "name": "W2", "param": 0, "typeId": 3, "coef": 1.881 }]
]
```

- `typeId: 1` ("W1") = `firstOpponentName` = team1 = selection `'1'` (Andrey Rublev, coef 2.003)
- `typeId: 3` ("W2") = `secondOpponentName` = team2 = selection `'2'` (Hubert Hurkacz, coef 1.881)
- `typeId: 2` (draw) does not appear — same skip-2 scheme as soccer 1x2, just with the draw column absent entirely rather than present-but-irrelevant.
- `gamePeriodId: 0` on both outcomes, confirming this is the "all markets / regular time" view → maps to our schema's `period: null`.

Cross-checked team-order via `gameStore.$state.gamesById[currentGameId]`: `firstOpponentName: "Andrey Rublev"`, `secondOpponentName: "Hubert Hurkacz"` — matches the page title and URL slug order, confirming W1/typeId1 is genuinely team1, not an artifact of API field-naming.

**Bridge change needed: NO.** `1xbet-bridge.js`'s 1xbet bet-add path (`init1xbet()`) finds the outcome purely by `o.id === outcomeId` (walking `marketGroups`) and calls `coupon.couponAddBet({ market: outcome })` — it never reconstructs a name/line string. The `nameGroup`/`nameBet` reconstruction in the bridge (lines ~112-125) only exists in `init22bet()` (Vuex action payload requires a human-readable bet description); 1xbet's Pinia `couponAddBet` takes the raw outcome object as-is, so a null `param`/line flows through fine.

**Verification**: ran the proposed `groupName`/`findOutcome` logic live against the real `marketGroups` data for `betData = {sport:'tennis', market:{type:'handicap_2way', period:null}, legs:[{book:'1xbet', line:null, selection:'1'|'2'}]}`. selection `'1'` → group `"1X2"`, outcome `{id: "729143463-0-1-0", coef: 2.003}` (Rublev). selection `'2'` → group `"1X2"`, outcome `{id: "729143463-0-3-0", coef: 1.881}` (Hurkacz). Both correct.

## Tennis additional markets (explored 2026-06-17)

Event: `https://1xbetjap.com/en/line/tennis/65187-atp-halle/342564882-zizou-bergs-taylor-harry-fritz` (ATP Halle, Zizou Bergs vs Taylor Fritz — future, not live).

All 24 group names on this event page:
`1X2`, `Total`, `Handicap`, `Total 1`, `Total 2`, `Correct Score`, `1, Result + Total`, `1, Result + Total Sets`, `2, Result + Total`, `2, Result + Total Sets`, `Tie-Break`, `Total Even`, `European Handicap`, `3Way Total`, `Sets Handicap`, `Set To Finish 6:0 (0:6) In The Match`, `Player To Lose 1st Set But Come Back To Win`, `Total Sets`, `Match Point Total`, `Player 1 To Save Match Point And Win The Match`, `Player 2 To Save Match Point And Win The Match`, `Highest Scoring Set Total`, `Sets Scoring`, `Set / Match`

### Full-match total games (`over_under`, `period: null`) → group `"Total"`

Outcome name format: `"Over 21.5"` / `"Under 21"` — `param` matches the line. typeId 9 = Over, typeId 10 = Under. The existing `name.startsWith('Over'/'Under') && param === line` logic works as-is.

Sample outcomes at line 21.5: `{id: "729409701-21.5-9-0", name: "Over 21.5", param: 21.5, typeId: 9, coef: 1.41}`, `{id: "729409701-21.5-10-0", name: "Under 21.5", ...}`.

### 1st-set total games (`over_under`, `period: '1st_set'`) → group `"Total 1"`

**Critical difference**: outcome name format is REVERSED — `"{line} Over"` / `"{line} Under"` (e.g. `"10.5 Over"`, `"11 Under"`). Match with `name.endsWith('Over'/'Under') && param === line`. The existing `startsWith` approach fails entirely for this group.

typeId 11 = Over (1st set), typeId 12 = Under (1st set). Lines typically 10.5–12.

Sample outcomes: `{id: "729409701-10.5-11-0", name: "10.5 Over", param: 10.5, typeId: 11, coef: 1.69}`, `{id: "729409701-11-12-0", name: "11 Under", param: 11, typeId: 12, coef: 1.98}`.

The `findOutcome` for `over_under` now tries `startsWith` first (works for "Total"), then falls back to `endsWith` (works for "Total 1" / "Total 2") — so both period variants work with one code path.

### 1st-set winner (`handicap_2way`, `period: '1st_set'`, `line: null`) → **NOT PRESENT**

No standalone 1st-set winner group exists in 1xbet's Pinia `marketGroups`. The closest groups are:
- `"Set / Match"`: combination bet (W1/W1, W1/W2, W2/W1, W2/W2) — not a moneyline.
- `"Sets Scoring"`: compares relative set sizes (`"1st Set > 2nd"` etc.) — not a player-winner bet.
- `"Sets Handicap"`: set handicap lines, not a moneyline winner.

`groupName()` returns `null` for this combo, causing `findMarketSection` to log the available groups and exit cleanly (no silent wrong-market match).
