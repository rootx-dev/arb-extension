// 1xBet adapter for the shared runner (extension/lib/runner.js).
//
// Architecture quirk: market grid is 100% canvas-rendered — no DOM elements for odds.
// Pinia stores (game, coupon) are only accessible from MAIN world (el.__vue_app__ is a
// JS expando, not visible to isolated-world content scripts). A companion MAIN-world
// script (1xbet-bridge.js) reads Pinia and writes serialized group data to a DOM
// attribute (data-arb-1xbet-groups). This adapter reads that attribute. Bet placement
// is triggered by writing data-arb-1xbet-bet=outcomeId; the bridge observes and calls
// couponAddBet({ market: outcome }).
//
// Search flow: fill input → Enter → modal opens → find card → card.click() triggers
// SPA navigation → poll location.pathname → force full reload for runner to re-enter doFill.
//
// Verified 2026-05-14 (ice hockey NHL, Anaheim Ducks vs Vegas Golden Knights):
//   ice_hockey  handicap_2way  ot_incl  line=null  → "Team Wins" group
//   ice_hockey  over_under     ot_incl             → "Total" group
//   soccer      1x2            null                → "1X2" group
// Verified 2026-06-16 (tennis ATP Halle, Andrey Rublev vs Hubert Hurkacz):
//   tennis      handicap_2way  null     line=null  → "1X2" group (2 cols, no draw: W1/typeId1, W2/typeId3)
// Verified 2026-06-17 (tennis ATP Halle, Zizou Bergs vs Taylor Fritz):
//   tennis      over_under     null                → "Total" group   (full-match total games; names "Over 21.5")
//   tennis      over_under     1st_set             → "Total 1" group (1st-set total games; names "10.5 Over" — reversed)
//   tennis      handicap_2way  1st_set  line=null  → NOT PRESENT on 1xbet (no dedicated 1st-set winner group)

(() => {
  console.log('[ARB-1xbet] script loaded on', location.pathname);
  const { sleep, norm } = window.__arb;

  const isVisible = (el) => !!(el && el.offsetParent !== null);

  // Once the search modal is open it can mount a SECOND input.ui-search-default__input,
  // so querySelector (DOM order) may return the hidden header one. Always target the
  // visible input — that's the one the user sees and the modal reads from.
  const visibleSearchInput = () => {
    const inputs = [...document.querySelectorAll('input.ui-search-default__input')];
    return inputs.find(isVisible) || inputs[0] || null;
  };

  const GRP_ATTR = 'data-arb-1xbet-groups';
  const BET_ATTR = 'data-arb-1xbet-bet';
  const PERIOD_ATTR = 'data-arb-1xbet-periods';

  // Period (half/quarter) markets live on a separate sub-game with its own
  // permanentId URL. Map our period enum → the sub-game's 1xbet gamePeriodName
  // (as written to PERIOD_ATTR by the bridge).
  const PERIOD_GAMENAME = { '1st_half': '1st half', '2nd_half': '2nd half' };

  // ── Market group name from betData ─────────────────────────────────────────

  function groupName(betData) {
    const { sport } = betData;
    const { type, period } = betData.market;
    const leg = betData.legs.find(l => l.book === '1xbet');
    const line = leg?.line ?? null;

    if (type === '1x2') return '1X2';
    if (type === 'over_under') {
      // Tennis set-level totals use "Total 1" (1st set) / "Total 2" (2nd set).
      if (sport === 'tennis' && period === '1st_set') return ['Total 1'];
      if (sport === 'tennis') return ['Total'];
      // Soccer totals split across TWO groups by line granularity:
      //   "Total"       — typeId 9/10 — half-point (1.5) and integer (1, 2) lines
      //   "Asian Total" — typeId 3827/3828 — quarter lines (0.75, 1.25, 1.75…)
      // A given line lives in exactly one group, so we hand both to
      // findMarketSection and search across them by param (findOutcome). Halves
      // are a separate sub-game page (beforeFindMarket navigates there); the
      // gameName requirement in findMarketSection keeps period markets distinct.
      if (sport === 'soccer') return ['Total', 'Asian Total'];
      // Hockey / basketball full-match total.
      return ['Total'];
    }
    if (type === 'handicap_2way') {
      // Draw-less match-winner (tennis, MMA, 1v1 esports) arrives as
      // handicap_2way with line=null. On 1xbet this data lives in the same
      // "1X2" group used for 3-way soccer — NOT "Handicap" (that group holds
      // spread markets with non-null params and would silently mismatch).
      if (line === null && sport === 'tennis') {
        // 1st-set winner (period='1st_set') does NOT exist as a standalone
        // group on 1xbet — the market is absent from the Pinia marketGroups.
        // Return null so findMarketSection logs the available groups and the
        // runner reports an unsupported market rather than silently failing.
        if (period === '1st_set') return null;
        return '1X2';
      }
      if (sport === 'ice_hockey' && line === null) return 'Team Wins';
      return 'Handicap';
    }
    return null;
  }

  // ── Outcome lookup within a group (works on plain JSON objects from bridge) ─

  function findOutcome(group, betData, leg) {
    const { type } = betData.market;
    const { selection } = leg;
    const line = leg.line != null ? parseFloat(leg.line) : null;

    if (type === '1x2') {
      const tid = selection === '1' ? 1 : selection === 'X' ? 2 : 3;
      return group.marketColumns.flat().find(o => o.typeId === tid);
    }

    if (type === 'over_under') {
      const side = selection === 'Over' ? 'Over' : 'Under';
      const flat = group.marketColumns.flat();
      // Full-match totals: names like "Over 21.5" — match by prefix
      const byPrefix = flat.find(o => o.name.startsWith(side) && o.param === line);
      if (byPrefix) return byPrefix;
      // 1st-set (and 2nd-set) totals: names like "10.5 Over" — reversed format
      return flat.find(o => o.name.endsWith(side) && o.param === line);
    }

    if (type === 'handicap_2way') {
      if (betData.sport === 'tennis' && line === null) {
        // "1X2" group, no draw column — same typeId scheme as soccer 1x2
        // (1=player1, 3=player2), just missing typeId 2 (no draw exists).
        const tid = selection === '1' ? 1 : 3;
        return group.marketColumns.flat().find(o => o.typeId === tid);
      }
      if (betData.sport === 'ice_hockey' && line === null) {
        return group.marketColumns.flat().find(
          o => o.name === (selection === '1' ? 'W1' : 'W2')
        );
      }
      const colIdx = selection === '1' ? 0 : 1;
      const col = group.marketColumns[colIdx] || [];
      const targetParam = selection === '1' ? line : -line;
      return col.find(o => o.param === targetParam);
    }

    return null;
  }

  // ── Adapter ────────────────────────────────────────────────────────────────

  __arb.run({
    book: '1xbet',
    stateKey: '1xbetState',

    isLandingPage: (path) => /^\/en\/line(\/[^/]+\/?)?$/.test(path),
    isEventPage:   (path) => path.split('/').filter(Boolean).length >= 5 && path.includes('/en/line/'),

    getRoot: () => document,

    // NOTE: no fillSearchInput hook. 1xbet's search box is bound to a framework
    // reactive model that ignores any isolated-world value REPLACEMENT (native
    // setter, input event, Escape+retype all fail — confirmed via logs). Only a
    // search typed into an EMPTY box reliably fires. The runner searches team1
    // first, which lands on that from-empty path; the team2 fallback would need a
    // value replacement and may not fire here. A fully reliable fallback would
    // route the search through the MAIN-world bridge (like 22bet's
    // data-arb-22bet-search) to write the reactive model directly — not yet built.
    findSearchInput: () => visibleSearchInput(),

    findEventResult: (root, event, betData) => {
      const firstCard = root.querySelector('.games-search-modal-game-card');
      if (!firstCard) {
        const input = visibleSearchInput();
        if (input && input.value) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
          input.dispatchEvent(new KeyboardEvent('keyup',   { key: 'Enter', keyCode: 13, bubbles: true }));
        }
        return null;
      }

      // 1xbet may render a multi-word team by EITHER word ("Perth Azzurri" shows
      // as "Perth"), so match on any significant token (first or last word ≥3
      // chars), requiring both teams. norm() folds diacritics + repeated letters.
      const tokensFor = (name) => {
        let ws = norm(name).split(/\s+/).filter(Boolean);
        const sig = ws.filter(w => w.length >= 3);
        if (sig.length) ws = sig;
        return [...new Set([ws[0], ws[ws.length - 1]].filter(Boolean))];
      };
      const t1 = tokensFor(event.team1);
      const t2 = tokensFor(event.team2);

      // Division guard: the search returns the senior men's fixture alongside
      // Women / U23 / youth variants with the SAME team names. Only accept a card
      // whose division qualifiers are all present in OUR signal (teams + league) —
      // never auto-select a Women/U23 game for a senior-men signal (wrong-event
      // bet = real money lost). Built from league too, so a genuine Women signal
      // still matches its Women card.
      const divisionsIn = (s) => {
        const d = new Set();
        if (/\bwomen'?s?\b|\(w\)/i.test(s)) d.add('women');
        for (const m of s.matchAll(/\bu-?\s?(\d{2})\b/gi)) d.add('u' + m[1]);
        if (/\byouth\b/i.test(s)) d.add('youth');
        if (/\breserves?\b/i.test(s)) d.add('reserves');
        return d;
      };
      const allowed = divisionsIn(`${event.team1} ${event.team2} ${betData?.league || ''}`);

      const matches = [];
      for (const card of root.querySelectorAll('.games-search-modal-game-card')) {
        const anchor = card.tagName === 'A' ? card : card.querySelector('a') || card.closest('a');
        const href = anchor?.href || '';
        // Skip virtual/simulated (SRL) games — they live under /en/live/, not /en/line/
        if (!href.includes('/en/line/')) continue;
        const text = norm(card.querySelector('.games-search-modal-card-info__main')?.textContent || '');
        const m1 = t1.some(tok => text.includes(tok));
        const m2 = t2.some(tok => text.includes(tok));
        const divOk = [...divisionsIn(text)].every(d => allowed.has(d));
        if (m1 && m2 && divOk) matches.push({ card, text });
      }
      if (!matches.length) return null;
      // Prefer the most specific (shortest text): the bare senior fixture
      // "Balcatta - Perth" beats any decorated Women/U23 variant that slipped through.
      matches.sort((a, b) => a.text.length - b.text.length);
      console.log(`[ARB-1xbet] event match: "${matches[0].text}"`);
      return matches[0].card;
    },

    navigateToEvent: async (card) => {
      // Try to get the event URL directly from the card's anchor.
      // 1xbet search cards are anchor tags — extract href and force a hard nav
      // so the isolated-world content script re-injects on the event page.
      const anchor = card.tagName === 'A' ? card : card.closest('a') || card.querySelector('a');
      if (anchor?.href && anchor.href.includes('/en/line/')) {
        console.log('[ARB-1xbet] navigating to event:', anchor.href);
        window.location.href = anchor.href;
        return;
      }
      // Fallback: click, detect SPA URL change, then force reload.
      const before = location.pathname;
      card.click();
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        const after = location.pathname;
        if (after !== before && after.includes('/en/line/')) {
          console.log('[ARB-1xbet] SPA nav detected:', after);
          window.location.href = location.href;
          return;
        }
      }
      console.log('[ARB-1xbet] fallback reload');
      window.location.reload();
    },

    marketLabel: (market) => market.type,

    // Period (half) markets are on a separate sub-game page. If the leg needs a
    // period (e.g. soccer 1st_half) and we're not already on that sub-game, look
    // up the sub-game's permanentId (exposed by the bridge in PERIOD_ATTR) and
    // navigate to its URL — a full reload, after which doFill re-enters on the
    // sub-game page where the bridge serializes the period's markets.
    beforeFindMarket: async (root, { sleep, waitFor, logger, betData }) => {
      const wantedGameName = PERIOD_GAMENAME[betData.market.period];
      if (!wantedGameName) return; // full match — nothing to do
      let periods;
      try {
        const raw = await waitFor(() => document.documentElement.getAttribute(PERIOD_ATTR), { timeout: 8000 });
        periods = JSON.parse(raw);
      } catch (e) { console.log('[ARB-1xbet] no period info (PERIOD_ATTR) — cannot switch period'); return; }
      if (periods.active === wantedGameName) {
        console.log(`[ARB-1xbet] already on "${wantedGameName}" sub-game`);
        return;
      }
      const pid = periods.subgames && periods.subgames[wantedGameName];
      if (!pid) {
        console.log(`[ARB-1xbet] no "${wantedGameName}" sub-game for this match; available:`, JSON.stringify(periods.subgames));
        return; // market not offered → findMarketSection will time out safely
      }
      // Swap the leading "{permanentId}-" in the last path segment for the sub-game's.
      const parts = location.pathname.split('/');
      parts[parts.length - 1] = parts[parts.length - 1].replace(/^\d+-/, `${pid}-`);
      const url = location.origin + parts.join('/');
      console.log(`[ARB-1xbet] switching to "${wantedGameName}" sub-game: ${url}`);
      window.location.href = url;
      await sleep(100000); // block; the reload restarts doFill on the sub-game page
    },

    findMarketSection: (root, _label, market, betData) => {
      const raw = document.documentElement.getAttribute(GRP_ATTR);
      if (!raw) return null;
      const name = groupName(betData);
      if (name == null) return null;
      // name may be a single group name or a candidate list — match exactly
      // against each (no substring/fuzzy, so we never grab an unrelated group).
      const candidates = Array.isArray(name) ? name : [name];
      // For period markets (e.g. 1st_half) require the group's gameName too, so
      // we never match the full-match "Total" if the sub-game switch didn't land.
      const reqGameName = PERIOD_GAMENAME[market.period] || null;
      console.log(`[ARB-1xbet] findMarketSection: group in ${JSON.stringify(candidates)}${reqGameName ? ` gameName="${reqGameName}"` : ''}`);
      const groups = JSON.parse(raw);
      // Keep ALL matching groups (e.g. both "Total" and "Asian Total") — a given
      // line lives in exactly one of them, so findOddsButton searches across.
      const matching = groups.filter(g =>
        candidates.includes(g.name) && (reqGameName == null || (g.gameName || '') === reqGameName));
      if (!matching.length) {
        console.log('[ARB-1xbet] groups available:', groups.map(g => `${g.name}${g.gameName ? '('+g.gameName+')' : ''}`));
        return null;
      }
      const el = document.createElement('div');
      el._arb1xbetGroups = matching;
      return el;
    },

    findOddsButton: (section, betData, leg) => {
      const groups = section._arb1xbetGroups || [];
      if (!groups.length) return null;
      console.log(`[ARB-1xbet] findOddsButton: type=${betData.market.type} sel=${leg.selection} line=${leg.line} groups=${JSON.stringify(groups.map(g=>g.name))}`);

      let outcome = null;
      for (const g of groups) { outcome = findOutcome(g, betData, leg); if (outcome) break; }
      if (!outcome) {
        console.log('[ARB-1xbet] outcome not found in groups:', groups.map(g => g.name).join(','));
        return null;
      }
      console.log(`[ARB-1xbet] outcome found: id=${outcome.id} coef=${outcome.coef}`);

      const fakeBtn = document.createElement('div');
      fakeBtn.click = () => {
        // Signal the MAIN-world bridge to call couponAddBet for this outcome
        document.documentElement.setAttribute(BET_ATTR, outcome.id);
      };
      return fakeBtn;
    },

    findStakeInput: (root) => root.querySelector('input.ui-number-input__field'),

    searchSettleMs: 500,
    clearStakeFirst: true,
    allowReclick: false,

    placeBetLabel: 'Place Bet',
  });
})();
