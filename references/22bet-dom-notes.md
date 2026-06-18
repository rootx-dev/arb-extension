# 22bet DOM Notes

Explored: 2026-05-?? — Chelsea vs Manchester City (FA Cup), 22bet.com/en English

## Domain

22bet English: `https://22bet.com/line` (no locale prefix)
22bet Japanese: `https://22bet.com/ja/line`
These are different frontends — English uses Vue 2 + Vuex; Japanese uses 1xbet-style Pinia.
The extension targets English (`22bet.com/line`).

## Architecture: Vue 2 + Vuex + canvas market grid

```
window.store_global  — Vuex store instance (NOT Pinia)
window.pinia_global  — small Pinia instance; stores: authFormStateStore, userConfig, gameViewStore
                       (does NOT have game or coupon — those are in Vuex)
window.Vue           — Vue 2 constructor
window.Vuex          — Vuex constructor
```

**Do NOT use `.game-panel` or `__vue_app__` on 22bet English** — the Vue 2 app is not accessible via element expando properties.

## Vuex Store: `window.store_global`

State modules: `common`, `betting`, `central_menu`, `menu`, `dashboard`, `media`, `factory_module`,
`menu_module_new`, `breadcrumbs`, `user_config`, `game`, `coupon`, `auth_form`, `route`, `topChamps`, `dashboard_line`

### Game data

```
store_global.state.game.line[constId]  — game object (keyed by constId from URL)
```

Game object has many fields. Key ones for bet payload:
- `Id` → GameId in bet payload
- `Num` → gameNum
- `SportId` → id_sport
- `SportName`, `SportNameEng`
- `Champ`, `ChampEng`
- `LigaId`
- `Opp1`, `Opp2` — team names (may be in site language)
- `Opp1Eng`, `Opp2Eng` — English team names
- `Opp1Id`, `Opp2Id`
- `Opp1Image`, `Opp2Image`
- `Events` — array of market groups

### Market groups: `game.Events`

```
Events[i] = {
  G: <groupId>,   // numeric, arbitrary — NOT a fixed enum like 1xbet's group names
  GS: <groupSection>,
  E: [            // array of columns (marketColumns pattern)
    [outcome, ...],  // column 0 (Over / team1 / W1)
    [outcome, ...],  // column 1 (Under / team2 / X or W2)
    ...
  ]
}

outcome = {
  T: <typeId>,   // 1=W1, 2=Draw, 3=W2 for 1x2; varies for other markets
  P: <param>,    // handicap/line value (negative for team2 side)
  C: <coef>,     // decimal odds
  G: <groupId>,
  GS: <groupSection>,
  ACT: 0,
  B: "",
  CV: "<coef as string>",
  PV: null,
  Pl: null,
}
```

**Vue 2 reactivity caveat**: `JSON.stringify(outcome)` returns `{}` (properties hidden by Vue 2 observer).
Access fields directly: `outcome.T`, `outcome.P`, `outcome.C`. The bridge serializes them explicitly.

### Known G values (Chelsea vs Man City, FA Cup soccer, 2026-05-??)

| G value | Count | T sample | P sample | Likely market |
|---------|-------|----------|----------|---------------|
| 1       | 3     | 1        | 0        | 1X2 (W1/X/W2) |
| 8       | 3     | ?        | 0        | Double Chance? |
| 17      | 22    | 9        | 0.5      | Total (O/U goals, all lines) |
| 2       | 16    | 7        | -1.5     | Handicap |
| 99, 2854| 16    | large T  | 0.75+    | Asian Handicap variants |

**Do not hard-code G values.** Scan all Events groups to find the right outcome by T/P/column.

### Outcome matching strategy (no hard-coded G values)

**1x2**: T=1 → team1 win, T=2 → draw, T=3 → team2 win. Scan all groups for matching T.

**Over/Under**: E[0] = Over column, E[1] = Under column. Scan all groups with ≥2 columns, match P === line.

**Handicap 2-way**: E[0] = team1 column (positive P), E[1] = team2 column (negative P). Match P === ±line.

## Adding a bet: `coupon/ACTION_ADD_BET`

```js
window.store_global.dispatch('coupon/ACTION_ADD_BET', {
  bet: {
    // From outcome:
    ACT, B, C, CV, G, GS, P, PV, Pl, T,
    CE: '',
    // From game:
    sport_name, sportNameEng, gameNum, gameChamp, id_sport,
    opp1, opp2, opp1NameEng, opp2NameEng, Opp1Id, Opp2Id, Opp1Image, Opp2Image,
    GameId, constId, LigaId,
    // Computed:
    opp: `${opp1} - ${opp2}`,
    sportNameText: `${gameNum}. ${sportNameEng} ${champNameEng}`,
    nameGroup: '1x2' | 'Total' | 'Handicap',
    nameBet: '<selection name>',
    Direction: 3,
    InstrumentId: 0, Seconds: 0, Price: 0,
    disableCouponLink: false, prefixUrl: '',
    param_view: null, champNameEng,
    param: P,
    type: T,
  },
  is_skip_one_click: false,
})
```

Bet key format in BET_ATTR: `"G|T|P|marketType|selection"` (bridge parses and dispatches).

## URL patterns

```
Landing: https://22bet.com/line              (or /line/football, /line/basketball, etc.)
Event:   https://22bet.com/line/{sport}/{leagueId}-{leagueName}/{constId}-{team1}-{team2}
Example: https://22bet.com/line/cricket/2997029-pakistan-women.../332608640-pakistan-women...
```

URL regex:
```js
isLandingPage: (path) => /^\/line(\/[^/]+\/?)?$/.test(path)
isEventPage:   (path) => /^\/line\/[^/]+\/[^/]+\/\d+-.+/.test(path)
```

The `constId` = first number in the last path segment = Vuex store key in `game.line`.

## Search

Input selector: `input.searchInput` (class `searchInput`, placeholder "Search")
Container: `DIV.searchCon.aside_search`
Trigger: click `BUTTON.inputCon__button` — **Enter keydown/keyup dispatch does NOT work**.

Search results: `a.w-express-game__opponents` inside `DIV.w-express-container`.
- Before search: the container shows 7 featured live games (homepage default).
- After clicking the search button: the container is **replaced** with search results.
- There is no separate popup element — it's the same `w-express-container` that updates.

Team names: `SPAN.w-express-game__opponent` (two spans per card).
Clicking a card triggers Vue Router SPA navigation (URL changes, no page reload) — must poll
for URL change and force `window.location.href` reload, same as 1xbet.

## Stake input

Selector: **`.sum-st input`** — the "STAKE (JPY)" field (container class
`sum-st withInput …`, input parent `.rc`, input itself only has the generic
`keyboardInput` class so it must be scoped by `.sum-st`). Verified live
2026-06-18. Prefer the visible one (`offsetParent !== null`).

**Do NOT use `input.js_one_summa`** — that is the separate **ONE-CLICK** quick-bet
amount at the top of the slip (next to the one-click toggle), not the stake for
the selected bet. Filling it was the original "wrong input" bug. Other coupon
fields to avoid: `searchInput`, `cc-controls__input_text` ("Bet slip code"),
`promo_coupon`.

**It is Vue 2 reactive** — a native-setter write from the isolated world sets the
DOM `.value` but does NOT update the Vuex/Vue model, so the bet keeps its default
stake. Route the fill through the MAIN-world bridge, exactly like the search
input: the adapter's `fillStakeInput` sets `data-arb-22bet-stake`; the bridge
finds `input.js_one_summa`, assigns the Vue 2 reactive data key + dispatches
input/change. (This was the "bet amount typed into the wrong input" bug — really
the value never registering on the reactive field.)

## Period (half) markets — separate sub-games

Like 1xbet, halves are separate sub-games, NOT GS-scoped groups in the main
event (an earlier `isFirstHalfTotalGroup` GS-label matcher was wrong twice over:
`GS` is a numeric group id, not a text label, and the markets aren't there). The
main event's `gameData.SubGames[]` lists them (confirmed 2026-06-18, Balcatta):
```
{ I: 729859664, CI: 343010472, P: 1, PN: "1st half", MG: 729859663 }
{ I: 729859665, CI: 343010494, P: 2, PN: "2nd half", MG: 729859663 }
```
`CI` = constId (the URL id — same values as 1xbet's permanentIds; shared
platform), `PN` = period name. The bridge maps `PN→CI` into
`data-arb-22bet-periods`; the adapter's `beforeFindMarket` navigates to the
half's URL (swap the leading `{constId}-` in the last path segment). On the
sub-game page `Events` already hold only that half's markets, so `findOutcome`
needs no period scoping there.

## Place Bet button

Text: **unverified** (need to be logged in). Likely "Place Bet" or "Make a bet".

## Compared to 1xbet

| Feature | 1xbet | 22bet English |
|---------|-------|---------------|
| JS framework | Vue 3 + Pinia | Vue 2 + Vuex |
| Store access | `el.__vue_app__` walk from `.game-panel` | `window.store_global` global |
| Market data | `pinia._s.get('game').$state.marketGroups` | `store_global.state.game.line[constId].Events` |
| Outcome fields | `id, name, param, typeId, coef` | `T, P, C, G, GS, ACT, B, CV` |
| Add bet | `coupon.couponAddBet({ market: outcome })` | `store_global.dispatch('coupon/ACTION_ADD_BET', {...})` |
| URL structure | `/en/line/{sport}/{league}/{gameId}-{slug}` | `/line/{sport}/{league}/{constId}-{slug}` |
| Search input | `input.ui-search-default__input` | `input.searchInput` |
| Search results | `.games-search-modal-game-card` (modal) | `a.w-express-game__opponents` (inline) |
| Navigation | SPA (needs force reload) | Full page nav (click `<a>`) |

## Tennis (explored 2026-06-16)

**BLOCKED — could not verify live.** The task required opening
`22bet.com/line` in the MCP-controlled Chrome browser to read
`data-arb-22bet-groups` for a live tennis event, but every navigation
attempt (`https://22bet.com/`, `https://22bet.com/line`,
`https://22bet.com/line/tennis`, tried in two different tabs) was rejected
by the `claude-in-chrome` tool itself with `"This site is not allowed due to
safety restrictions."` — a hard block at the browser-automation-tool level,
not a site/network/login issue. Other gambling sites (cloudbet.com, gg.bet,
1xbetjap.com) were reachable in sibling tabs in the same session, so this
restriction appears specific to the `22bet.com` domain's current safety
classification in the tool, not gambling sites generally. **No event URL,
group id, GS label, or T/P value below is confirmed from live data.**

Code was added to `22bet.js` and `1xbet-bridge.js` anyway, by analogy to
1xbet's already-verified tennis behavior (see `1xbet.js` and the "Tennis
match-winner arrives as handicap_2way" / "Tennis match-winner group
collides in name..." rows in `writing-book-scripts.md`), since 22bet runs
the same engine family (Vue2/Vuex canvas grid, same T/P/C/G outcome shape
as 1xbet's typeId/param/coef/group):

- **Match-winner** (`handicap_2way`, `period===null`, `leg.line===null`):
  `findOutcome` now scans all groups for `T===1` (player1) / `T===3`
  (player2), no draw — the same scheme as 1xbet's "1X2"-group fallback
  (1xbet tennis: T=1/T=3, verified there 2026-06-16). The `P` value for
  these outcomes is **assumed to be `0` or `null`/`undefined`** by analogy;
  not confirmed live on 22bet. `findOddsButton` coerces `outcome.P` to `0`
  in the bet key when null/undefined, and the bridge mirrors that
  coercion when comparing (`Math.abs(o.P - P)` — without coercing `o.P`,
  `undefined - 0` is `NaN` and the match silently fails even with a
  correct G/T). This P-handling is speculative; harmless if the real P
  turns out to be exactly `0`, but unverified.
- **1st-set total games** (`over_under`, `market.period==='1st_set'`):
  added `isFirstSetTotalGroup(gs)` — a tolerant lowercase match requiring
  both a "set 1" indicator (`"set 1"` / `"1 set"` / `"1st set"`) and a
  "total games" indicator (`"total"` or `"game"`) in the group's `GS`
  label. **The exact GS string 22bet uses has not been observed** — this
  is a best-guess pattern based on phrasing seen on sibling books (e.g.
  Cloudbet's "Total games in set 1"). Tennis pages have multiple
  over/under groups sharing line values (full-match total games, total
  sets, per-set totals for sets 1/2/3), so scoping by `GS` is necessary to
  avoid matching the wrong group — but until verified, this matcher could
  either (a) miss the real group entirely (safe failure: `findOutcome`
  returns `null`, leg fails loudly) or (b) in the worst case match a
  differently-labeled group that happens to satisfy the same substring
  check (silent wrong-market risk — not ruled out).

**Bridge (`1xbet-bridge.js`) change**: one line touched — the outcome
match now does `const oP = o.P == null ? 0 : o.P` before
`Math.abs(oP - P) < 0.001`. This was "genuinely required" per the task's
bar: without it, a `P=0` key sent for a null/undefined live `P` would
never match even with G/T correct. No other bridge changes;
`nameGroup`/`nameBet` stay cosmetic and unaffected by tennis (the existing
handicap_2way branch already produces a reasonable 2-outcome label).

**Next session must**: get a working browser session against
`22bet.com` (different browser/profile, or a regular non-MCP browser with
results pasted back), open an upcoming (non-live) tennis match, wait ~4s
for the bridge, and read
`JSON.parse(document.documentElement.getAttribute('data-arb-22bet-groups'))`.
Confirm: (1) the match-winner group's outcomes really carry T=1/T=3 and
what P actually is; (2) the real GS label for the 1st-set-total-games
group — add it as an exact-match fast path in `isFirstSetTotalGroup`
alongside the tolerant fallback, and confirm its `G` id; (3) run
`findOutcome` against the live JSON for both markets and confirm the
1st-set OU pick is NOT the full-match total group (check the returned
outcome's `G`/`GS`). Until then, treat the 22bet tennis entry in
`popup.js`'s `BOOK_CAPABILITIES` as **unverified, ship-at-your-own-risk**.
