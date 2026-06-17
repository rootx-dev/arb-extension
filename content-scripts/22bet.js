// 22bet adapter for the shared runner (extension/lib/runner.js).
//
// 22bet English (22bet.com/line) is a Vue 2 + Vuex app with a canvas market grid.
// It is architecturally different from 1xbet (Vue 3 + Pinia). Key differences:
//   - URL: /line/{sport}/{leagueSlug}/{constId}-{teamSlugs}  (no /en/ prefix)
//   - Search input class: input.searchInput  (not ui-search-default__input)
//   - Search trigger: click BUTTON.inputCon__button (Enter dispatch does NOT work)
//   - Search results: a.w-express-game__opponents (real <a> links, full page nav)
//   - Market data: window.store_global (Vuex) → state.game.line[constId].Events
//   - Events structure: Events[i].E = array of columns; each col = array of outcomes
//     with fields T (type/selectionId), P (param/line), C (coef), G (groupId)
//   - Bet add: store_global.dispatch('coupon/ACTION_ADD_BET', {bet:{...}, is_skip_one_click:false})
//   - Bet key format written to BET_ATTR: "G|T|P|marketType|selection"
//
// Market outcome matching (no hard-coded G values — scan all groups):
//   1x2:         find outcome where T∈{1,2,3}: 1=team1, 2=draw, 3=team2
//   over_under:  col 0 = Over, col 1 = Under; match P === line
//   handicap_2way: col 0 = team1, col 1 = team2; match P === signed line
//   handicap_2way (tennis, line=null): draw-less match-winner, scan T∈{1,3}
//     (1=player1, 3=player2), same scheme as 1xbet's "1X2" group fallback.
//   over_under (tennis, period=1st_set): scope the group scan to GS labels
//     that look like "total games in set 1" (see isFirstSetTotalGroup) —
//     tennis has many total-games groups (full match, sets, per-set games)
//     that share line values, so an unscoped scan risks the wrong market.
//
// Verified: 2026-05-?? (see 22bet-dom-notes.md)
// Tennis branches added 2026-06-16 — UNVERIFIED against live data (22bet.com
// was unreachable this session, blocked by browser-tool safety restriction).
// Logic mirrors 1xbet's verified tennis handling but the actual T/P/GS values
// on 22bet have not been confirmed live. See 22bet-dom-notes.md "Tennis" section.

(() => {
  const { sleep, lastWord } = window.__arb;

  const GRP_ATTR = 'data-arb-22bet-groups';
  const BET_ATTR = 'data-arb-22bet-bet';

  // ── Outcome lookup across all Events groups ────────────────────────────────

  // Tolerant match for the "total games in set 1" group label. Mirrors the
  // GS-label scoping needed because tennis has many total-games groups
  // (full match, total sets, set 1/2/3 totals) that share line values —
  // an unscoped P-only scan would silently match the wrong group.
  // UNVERIFIED against live GS strings (22bet.com was unreachable for this
  // session — see 22bet-dom-notes.md "Tennis" section). Update this matcher
  // once the real GS label is confirmed live.
  function isFirstSetTotalGroup(gs) {
    if (!gs) return false;
    const s = gs.toLowerCase();
    const mentionsSet1 = s.includes('set 1') || s.includes('1 set') || s.includes('1st set');
    const mentionsTotal = s.includes('total') || s.includes('game');
    return mentionsSet1 && mentionsTotal;
  }

  function findOutcome(events, betData, leg) {
    const { type } = betData.market;
    const { selection } = leg;
    const { sport, market } = betData;
    const line = leg.line != null ? parseFloat(leg.line) : null;

    if (type === '1x2') {
      const targetT = selection === '1' ? 1 : selection === 'X' ? 2 : 3;
      for (const group of events) {
        for (const col of group.E) {
          for (const o of col) {
            if (o.T === targetT) return o;
          }
        }
      }
    }

    if (type === 'over_under') {
      // Column 0 = Over, column 1 = Under (standard column ordering)
      const colIdx = selection === 'Over' ? 0 : 1;
      const scopeToFirstSet = sport === 'tennis' && market.period === '1st_set';
      for (const group of events) {
        if (group.E.length < 2) continue;
        if (scopeToFirstSet && !isFirstSetTotalGroup(group.GS)) continue;
        const col = group.E[colIdx];
        if (!col) continue;
        for (const o of col) {
          if (Math.abs(o.P - line) < 0.001) return o;
        }
      }
    }

    if (type === 'handicap_2way') {
      // Draw-less match-winner (tennis, MMA, 1v1 esports) arrives as
      // handicap_2way with line=null. Mirrors 1xbet's "1X2"-group fallback:
      // scan for T=1 (player1) / T=3 (player2), no draw (T=2), no P match
      // needed since P is 0/irrelevant for moneyline outcomes.
      if (sport === 'tennis' && line === null) {
        const targetT = selection === '1' ? 1 : 3;
        for (const group of events) {
          for (const col of group.E) {
            for (const o of col) {
              if (o.T === targetT) return o;
            }
          }
        }
        return null;
      }

      // Column 0 = team1, column 1 = team2; team2's P is negated
      const colIdx = selection === '1' ? 0 : 1;
      const targetP = selection === '1' ? line : (line != null ? -line : null);
      if (targetP == null) return null;
      for (const group of events) {
        if (group.E.length < 2) continue;
        const col = group.E[colIdx];
        if (!col) continue;
        for (const o of col) {
          if (Math.abs(o.P - targetP) < 0.001) return o;
        }
      }
    }

    return null;
  }

  // ── Adapter ────────────────────────────────────────────────────────────────

  __arb.run({
    book: '22bet',
    stateKey: '22betState',

    // English 22bet uses /line/... with no locale prefix
    isLandingPage: (path) => /^\/line(\/[^/]+\/?)?$/.test(path),
    isEventPage:   (path) => /^\/line\/[^/]+\/[^/]+\/\d+-.+/.test(path),

    getRoot: () => document,

    findSearchInput: (root) => root.querySelector('input.searchInput'),

    // Signal the MAIN-world bridge to fill the Vue 2 reactive input and click
    // the search button. fillInput from isolated world doesn't update Vue 2
    // reactive state, so the bridge handles it instead.
    fillSearchInput: async (input, term) => {
      document.documentElement.setAttribute('data-arb-22bet-search', term);
      console.log('[ARB-22bet] search triggered via bridge for:', term);
    },

    findEventResult: (root, event) => {
      // Search results appear in a modal popup with plain-text game items,
      // not a.w-express-game__opponents. Match any element whose text contains
      // both team names (last word for robustness), preferring the most specific
      // (shortest text) element.
      const t1last  = lastWord(event.team1).toLowerCase();
      const t2last  = lastWord(event.team2).toLowerCase();
      const t1first = event.team1.toLowerCase().split(' ')[0];
      const t2first = event.team2.toLowerCase().split(' ')[0];

      const matches = [...root.querySelectorAll('a, li, div[class], span[class]')]
        .filter(el => {
          const text = el.textContent.toLowerCase();
          if (text.length < 5 || text.length > 300) return false;
          const hasT1 = text.includes(t1last) || text.includes(t1first);
          const hasT2 = text.includes(t2last) || text.includes(t2first);
          return hasT1 && hasT2;
        })
        .sort((a, b) => {
          // Prefer <a> links (reliably navigable), then shorter text (more specific)
          if (a.tagName === 'A' && b.tagName !== 'A') return -1;
          if (a.tagName !== 'A' && b.tagName === 'A') return 1;
          return a.textContent.length - b.textContent.length;
        });

      if (matches.length > 0) {
        const el = matches[0];
        console.log('[ARB-22bet] findEventResult match:', el.tagName, [...el.classList].join('.'), el.textContent.trim().slice(0, 60));
        return el;
      }

      console.log('[ARB-22bet] findEventResult: no match yet');
      return null;
    },

    // 22bet uses Vue Router — clicking an <a> triggers SPA navigation (URL
    // changes, no page reload). Detect the URL change and force a full reload
    // so the content script re-runs on the event page in fill phase.
    navigateToEvent: async (card) => {
      const before = location.pathname;
      console.log('[ARB-22bet] navigateToEvent: href=', card.href, 'before=', before);
      card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      for (let i = 0; i < 30; i++) {
        await sleep(200);
        const after = location.pathname;
        console.log('[ARB-22bet] polling path:', after);
        if (after !== before && /^\/line\/[^/]+\/[^/]+\/\d+-.+/.test(after)) {
          console.log('[ARB-22bet] SPA nav detected, forcing reload:', after);
          window.location.href = after;
          return;
        }
      }
      // If URL didn't change, try following href directly
      if (card.href) {
        console.log('[ARB-22bet] no URL change, navigating to href:', card.href);
        window.location.href = card.href;
      } else {
        window.location.reload();
      }
    },

    marketLabel: (market) => market.type,

    findMarketSection: (root, _label, market, betData) => {
      const raw = document.documentElement.getAttribute(GRP_ATTR);
      if (!raw) return null;
      const data = JSON.parse(raw);
      const leg = betData.legs.find(l => l.book === '22bet');
      if (!leg) return null;
      const outcome = findOutcome(data.events, betData, leg);
      if (!outcome) {
        console.log('[ARB-22bet] outcome not found in events, type:', betData.market.type, 'sel:', leg.selection, 'line:', leg.line);
        return null;
      }
      const el = document.createElement('div');
      el._arb22betData = data;
      return el;
    },

    findOddsButton: (section, betData, leg) => {
      const { events } = section._arb22betData;
      console.log(`[ARB-22bet] findOddsButton: sport=${betData.sport} type=${betData.market.type} period=${betData.market.period} sel=${leg.selection} line=${leg.line}`);
      const outcome = findOutcome(events, betData, leg);
      if (!outcome) return null;
      console.log(`[ARB-22bet] outcome: G=${outcome.G} T=${outcome.T} P=${outcome.P} C=${outcome.C}`);

      const fakeBtn = document.createElement('div');
      fakeBtn.click = () => {
        // "G|T|P|marketType|selection" — bridge decodes this to build the full payload.
        // Coerce P to 0 when null/undefined (e.g. tennis match-winner moneyline
        // outcomes carry no line) — the bridge does parseFloat(Ps) then
        // Math.abs(o.P - P), and parseFloat("undefined") is NaN, which never
        // matches. 0 is also the expected live P for these outcomes (TBC).
        const pField = outcome.P == null ? 0 : outcome.P;
        const key = `${outcome.G}|${outcome.T}|${pField}|${betData.market.type}|${leg.selection}`;
        document.documentElement.setAttribute(BET_ATTR, key);
      };
      return fakeBtn;
    },

    // Stake input — selector needs in-session verification when logged in
    findStakeInput: (root) =>
      root.querySelector('input.js_one_summa, input.coupon__input, input[class*="coupon-summa"]'),

    searchSettleMs: 500,
    clearStakeFirst: true,
    allowReclick: false,

    placeBetLabel: 'Place A Bet',
  });
})();
