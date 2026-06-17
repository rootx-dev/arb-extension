# Stake DOM Notes

Verified working: 2026-05-13.
Reference event: Aston Villa v Liverpool, Premier League
(`/sports/soccer/england/premier-league/46527588-aston-villaocc-liverpool`).
Earlier exploration also covered Argentinos Juniors v CA Huracán
(`/ja/sports/soccer/argentina/superliga/46547627-argentinos-juniors-huracan`).

## Architecture

- **Regular DOM** — no Shadow DOM. `document.querySelector` works directly.
- **Framework**: Svelte. Styled elements carry a `svelte-XXXXXX` class hash
  (changes per build — don't depend on it). Different from Cloudbet (React)
  and Roobet (React in Shadow DOM).
- **Locale by session cookie**:
  - `/ja/sports/...` → Japanese UI
  - `/sports/...` (no prefix) → English UI
  - Assigning a URL with a non-current locale prefix may redirect or stay,
    depending on the user's settings. **Read locale at runtime from
    `location.pathname`**, don't hard-code.
- **GraphQL API**: `POST https://stake.com/_api/graphql` with session cookies.
  The page uses it for everything; the adapter does too (see Search below).

## Search — use GraphQL, not the DOM input

The adapter does **not** type into Stake's search input. We tried; it failed
for two compounding reasons:

1. **Svelte input dropped programmatic events** in the freshly-opened
   content-script tab flow. The runner's `fillInput` (native value setter +
   bubbling `input` event) works fine when the page has been settled for a
   while (manual MCP exploration confirmed) but produced no visible typing
   when the tab was opened by `chrome.tabs.create({ url, active: true })`.
   Likely a Svelte hydration race specific to fresh-load isolated-world
   content scripts.
2. **The home-page search input only filters featured fixtures**, not the
   global catalog — smaller leagues are missing from results even when typing
   does work.

Instead, the adapter calls Stake's own search query directly:

```graphql
query StakeArbSearch($q: String!) {
  sportFixtureQuery(query: $q) {
    fixture { ... on SportFixture {
      slug name
      tournament { slug category { slug sport { slug } } }
    } }
  }
}
```

- **Endpoint**: `POST /_api/graphql` (same origin, `credentials: 'include'`
  reuses the user's session cookies).
- **Query variable**: `lastWord(event.team2)` — e.g. `"Huracan"` or
  `"Liverpool"`. Avoid passing full team names since Stake's tokenizer is
  loose.
- **Match filter**: `fixture.name + ' ' + fixture.slug` must contain BOTH
  `lastWord(team1)` and `lastWord(team2)` — avoids picking the wrong
  Manchester game when searching for Liverpool.
- **URL construction**: `${localePrefix()}/sports/${sport.slug}/${category.slug}/${tournament.slug}/${fixture.slug}`
  where `localePrefix()` is `/ja` if `location.pathname` starts with `/ja/`,
  else `''`.

To slot into the runner's `findEventResult` contract (which expects an
`Element`), the adapter creates an off-screen `<a href="…">` once the
GraphQL promise resolves, and returns it from subsequent polls. A hidden
`<input data-arb-stake-stub>` is appended so the runner's `fillInput` call
has a real target — it's a no-op as far as Stake is concerned.

## Event Page URL Pattern

```
{localePrefix}/sports/{sport}/{country}/{league}/{eventId}-{team1-slug}-{team2-slug}
```

- `{sport}` is hyphenated (`ice-hockey`, not `ice_hockey`).
- `{eventId}` is a large integer prepended with `-` before the team slugs.
- Path depth (after the optional locale prefix) ≥ 4 → event page.
- Path depth (after the optional locale prefix) ≤ 1 → landing
  (e.g. `/sports/home`, `/sports/upcoming`).

The adapter uses `sportsDepth(path)` to make these checks locale-agnostic.

## Market Sections

Every market is wrapped in a `div.secondary-accordion` whose first child
holds the title text. Structure:

```
<div class="secondary-accordion level-2 rounded svelte-... is-open">
  <div>{market title}</div>                          <!-- children[0] -->
  <div class="content svelte-... is-open">           <!-- children[1] -->
    <div class="market svelte-...">
      <button class="outcome ..." data-testid="fixture-outcome">...</button>
      …
    </div>
  </div>
</div>
```

**Finder**: exact match on `accordion.children[0].textContent.trim()`. No
walk-up needed.

## Odds Buttons & The Click Trick

- **Selector**: `button.outcome[data-testid="fixture-outcome"]`
- **Text**: `"{team-or-label} {odds}"` with a single space separator
  (e.g. `"Aston Villa 2.95"`, `"Draw 2.00"`, `"Liverpool 6.50"`).
- **Selected state**: after a successful click, the button gains the
  `.selected` class — useful as a post-click sanity check.

### Plain `btn.click()` is unreliable — dispatch a full pointer sequence

This was the **big lesson**. The runner's default `btn.click()` was silently
dropped by Stake's Svelte outcome handler in the content-script tab flow,
even though the same code worked from MCP-driven manual exploration on a
settled page. Two compounding causes:

1. Stake's handler appears to require the full pointer / mouse event chain
   (not just `click`).
2. Content scripts at `document_idle` can race ahead of Svelte hydration —
   the DOM element is there before its listeners are attached.

The fix in [stake.js](../content-scripts/stake.js) wraps the button so the
runner's `btn.click()` actually fires:

```js
function wrapWithFullClick(btn) {
  const dispatch = () => {
    btn.scrollIntoView({ block: 'center' });
    const opts = { bubbles: true, cancelable: true, button: 0, view: window };
    btn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
    btn.dispatchEvent(new MouseEvent('mousedown', opts));
    btn.dispatchEvent(new PointerEvent('pointerup',   { ...opts, pointerId: 1, pointerType: 'mouse' }));
    btn.dispatchEvent(new MouseEvent('mouseup',   opts));
    btn.dispatchEvent(new MouseEvent('click',     opts));
  };
  btn.click = () => {
    // 1.5s pre-click delay = Svelte hydration window.
    setTimeout(() => {
      dispatch();
      // Self-check: if .selected didn't appear after 1.5s, fire again.
      setTimeout(() => {
        const ok = btn.classList.contains('selected') ||
                   !!document.querySelector('input[data-testid="input-bet-amount"]');
        if (!ok) dispatch();
      }, 1500);
    }, 1500);
  };
  return btn;
}
```

`findOddsButton` wraps the chosen button before returning it. The runner's
poll budget (10s) absorbs the 1.5s pre-click delay easily.

### Selection → Button Index (1x2)

For 1x2 the three buttons are in fixed order, regardless of locale or
account state:

| `leg.selection` | Button index |
|---|---|
| `"1"` | `0` (home / team1) |
| `"X"` | `1` (draw — label is `"Draw"` on /sports/, `"ドロー"` on /ja/) |
| `"2"` | `2` (away / team2) |

Index-based picking sidesteps the locale-dependent label entirely.

## Bet Slip

- **Stake input**: `input[data-testid="input-bet-amount"]` (stable selector;
  the placeholder is currency-formatted and changes per account).
  Visibility filter (`offsetParent !== null`) rules out a collapsed copy.
- **Place Bet button**: text `"Place Bet"` on `/sports/`, `"ベットの登録"` on
  `/ja/sports/`. Hidden until login.
- **Slip toggle**: a `<button>` with text `"Bet Slip"` (or `"ベットスリップ"` on
  /ja/). The adapter exposes `openSlipPanel` for it — the runner will click
  it and re-poll if the slip is collapsed.
- **Slip markers** for diagnostics: any element with
  `[data-testid^="betslip-"]`. Useful counts:
  - `1` → just `betslip-estimated-payout` (empty slip baseline)
  - `4+` → at least one selection added (`betslip-bet`, `betslip-bet-remove`,
    `betslip-odds-payout`, etc.)

## Market Type → Stake Title Mapping (verified 2026-05-13; tennis updated 2026-06-17)

Stake appends `"  TableAll"` (or `"  SelectAll"`) to accordion titles in the
DOM, so `findMarketSection` uses `startsWith(label)` not exact match.

| Signal `market.type` | Sport | Period | Stake accordion title (startsWith, English) | Japanese |
|---|---|---|---|---|
| `1x2` | soccer | — | `1x2` | `1x2` |
| `draw_no_bet` | soccer | — | `Draw No Bet` | `ドロー、ベットなし` |
| `over_under` | soccer | — | `Asian Total` | `アジアントータル` |
| `over_under` | basketball (OT-incl) | — | `Total (Incl. Overtime)` | TODO |
| `over_under` | ice_hockey (OT-incl) | — | `Total (Incl. Overtime and Penalties)` | TODO |
| `over_under` | tennis | `null` (full match) | `Total Games` | TODO |
| `over_under` | tennis | `1st_set` | `1st Set - Total Games` | TODO |
| `handicap_2way` | soccer | — | `Asian Handicap` | `アジアンハンディキャップ` |
| `handicap_2way` | basketball (OT-incl) | — | `Handicap (Incl. Overtime)` | TODO |
| `handicap_2way` | ice_hockey (OT-incl) | — | `Handicap (Incl. Overtime and Penalties)` | TODO |
| `handicap_2way` | tennis | `null` (full match) | `Winner` | TODO |
| `handicap_2way` | tennis | `1st_set` | `1st Set - Winner` | TODO |

## Tennis Markets (verified live 2026-06-17 — de Minaur v Shapovalov, ATP London)

Reference event: `stake.com/sports/tennis/atp/atp-london-great-britain-men-singles/46633466-r16p1-r16p2`

All tennis accordion titles confirmed (from `div.secondary-accordion children[0].textContent.trim()`):
```
"Winner"
"1st Set - Winner"
"2nd Set - Winner"
"Set Handicap  TableAll"
"Game Handicap  TableAll"
"Total Games  TableAll"
"1st Set - Total Games  TableAll"
"Correct Score  SliderAll"
"Double Result (1st Set/Match)  SelectAll"
```

### No startsWith collision between market titles

- `"Winner"` does NOT start with `"1st Set - Winner"` (different prefix entirely).
- `"1st Set - Winner"` does NOT start with `"Winner"`.
- `"Total Games"` does NOT start with `"1st Set - Total Games"` and vice versa.

All four tennis market titles are safe to use as `startsWith` prefixes in `findMarketSection`.

### 1st-set winner (`handicap_2way`, `period="1st_set"`)

Section title startsWith: **`"1st Set - Winner"`**

2 `button.outcome` elements. No draw. Button order:
- Index 0 → player1 (`leg.selection === '1'`)
- Index 1 → player2 (`leg.selection === '2'`)

`aria-label` = player's full name (e.g. `"Alex de Minaur"`, `"Denis Shapovalov"`).
Use index-based picking (same as full-match winner).

### Full-match total games (`over_under`, `period=null`)

Section title startsWith: **`"Total Games"`**

Buttons are interleaved pairs: `Over N, Under N, Over N+1, Under N+1, …`
`aria-label` = `"Over 21.5"` / `"Under 21.5"` etc. — same format as soccer/basketball OU.
Match: `aria-label === "${leg.selection} ${leg.line}"`. Verified: `"Over 22.5"` and `"Under 22.5"` found.

### 1st-set total games (`over_under`, `period="1st_set"`)

Section title startsWith: **`"1st Set - Total Games"`**

Same interleaved-pair button format and same `aria-label` scheme as full-match totals.
`aria-label` = `"Over 9.5"` / `"Under 9.5"` etc. Verified: `"Over 9.5"` and `"Under 9.5"` found.

## Over/Under Button Matching

**All sports**: OU buttons are interleaved pairs — `(Over N, Under N, Over N+1, Under N+1, …)`.
Each button carries `aria-label="Over 5.5"` / `"Under 5.5"`. Match on exact
`aria-label` = `"{leg.selection} {leg.line}"`. Never rely on button text order or count.

This is simpler than Cloudbet (column-spatial) and Roobet (startsWith on text),
and survives layout changes as long as aria-labels are maintained.

## Handicap Button Matching

`aria-label` = `"{Team Name} ({signed_line})"`, e.g. `"Colorado Avalanche (-1.5)"` / `"Minnesota Wild (1.5)"`.

**Critical**: hockey (puck-line style) lists the same absolute line for BOTH teams — e.g. both `-1.5` and `+1.5` can appear for team1 AND team2 at different odds. Matching on line alone is ambiguous. Always match by BOTH:
1. `lastWord(teamName)` (from `betData.event.team1/team2` via `leg.selection`) in the aria-label (case-insensitive)
2. `(${leg.line})` in the aria-label

Basketball lines are unique per team (one always gets the negative side), but using both criteria is still safe and consistent.

## Don't Test On Live Games

This burned a lot of cycles. Stake's logged-in session aggressively
auto-rejects bets on live (`status: "live"`) games where odds shifted
between page-render and click — the slip briefly populates
(`slipMarkers=7`) then empties without any UI feedback. The Aston Villa
upcoming match (`status: "active"`) worked first time once the click
fix was in.

Filter the `sportFixtureQuery` response by `fixture.status === 'active'` (not
`'live'`) when picking test events. The GraphQL query in the search
function doesn't request `status` currently — add it if you need to filter.

## Login State (for testing)

DOM exploration works fully logged out. Logged-out lets you verify:

- Search resolves the right event
- Navigation lands on the event page
- Market accordion exists with the right title
- Click adds `.selected` and populates the slip
- Stake input becomes visible

The Place Bet button itself only appears after login (logged-out shows
`"Register"` / `"ログイン"` instead). End-to-end fill (stake value typed in,
green toast) is testable logged out — but the user obviously needs to be
signed in to actually place the bet.
