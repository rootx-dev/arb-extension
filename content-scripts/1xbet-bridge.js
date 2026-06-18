// MAIN-world bridge for 1xbet and 22bet adapters.
// Isolated-world content scripts cannot access el.__vue_app__ (JS expando
// on V8 wrapper, not shared). This script runs in MAIN world, reads store
// data, and exposes it via DOM attributes (live on the C++ DOM node → shared
// across worlds).
//
// Attributes on document.documentElement (BOOK = '1xbet' or '22bet'):
//   data-arb-BOOK-groups  — serialized market data (written by bridge)
//   data-arb-BOOK-bet     — outcome key to add (written by adapter, cleared by bridge)
//   data-arb-BOOK-done    — set to "1" after bet added (written by bridge)
//
// Architecture:
//   1xbet: Vue 3 + Pinia. Bet via pinia coupon store's couponAddBet().
//   22bet English (22bet.com/line): Vue 2 + Vuex. Bet via store_global Vuex action.
//               Data in store_global.state.game.line[constId].Events (array of
//               column-arrays, each column = array of outcomes with T/P/C/G fields).
//               Bet key format: "G|T|P|marketType|selection"

(() => {
  const book    = location.hostname.includes('22bet') ? '22bet' : '1xbet';
  const GRP_ATTR    = `data-arb-${book}-groups`;
  const BET_ATTR    = `data-arb-${book}-bet`;
  const DONE_ATTR   = `data-arb-${book}-done`;
  const PERIOD_ATTR = `data-arb-${book}-periods`;
  const LOG         = `[ARB-${book}-bridge]`;

  if (book === '22bet') {
    init22bet();
  } else {
    init1xbet();
  }

  // ── 22bet: Vuex + window.store_global ─────────────────────────────────────

  function init22bet() {
    function getConstId() {
      // URL: /line/{sport}/{leagueSlug}/{constId}-{teamSlugs}
      const last = location.pathname.split('/').pop();
      const m = last.match(/^(\d+)-/);
      return m ? parseInt(m[1]) : null;
    }

    function pollStore() {
      if (!window.store_global) { setTimeout(pollStore, 300); return; }
      pollGameData();
    }

    function pollGameData() {
      const constId = getConstId();
      if (!constId) { setTimeout(pollGameData, 300); return; }

      const gameData = window.store_global?.state?.game?.line?.[constId];
      if (!gameData?.Events?.length) { setTimeout(pollGameData, 300); return; }

      const events = gameData.Events.map(group => ({
        G:  group.G,
        GS: group.GS,
        E:  group.E.map(col => col.map(o => ({
          T: o.T, P: o.P, C: o.C, G: o.G, GS: o.GS,
          ACT: o.ACT || 0, B: o.B || '',
          CV: o.CV || String(o.C), PV: o.PV || null, Pl: o.Pl || null,
        }))),
      }));

      const game = {
        Id: gameData.Id,
        ConstId: constId,
        LigaId: gameData.LigaId,
        Num: gameData.Num,
        SportId: gameData.SportId,
        SportName: gameData.SportName,
        SportNameEng: gameData.SportNameEng,
        Champ: gameData.Champ,
        ChampEng: gameData.ChampEng,
        Opp1: gameData.Opp1,
        Opp2: gameData.Opp2,
        Opp1Eng: gameData.Opp1Eng,
        Opp2Eng: gameData.Opp2Eng,
        Opp1Id: gameData.Opp1Id,
        Opp2Id: gameData.Opp2Id,
        Opp1Image: gameData.Opp1Image,
        Opp2Image: gameData.Opp2Image,
      };

      document.documentElement.setAttribute(GRP_ATTR, JSON.stringify({ events, game }));
      console.log(LOG, 'game data ready, event groups:', events.length);

      // Period (half) sub-games: gameData.SubGames[] each has CI (constId) + PN
      // ("1st half"/"2nd half"). Expose a period→constId map so the adapter can
      // navigate to the half's own URL (same model as 1xbet sub-events).
      try {
        const subgames = {};
        for (const s of (gameData.SubGames || [])) {
          if (s && s.PN && s.CI) subgames[String(s.PN).trim().toLowerCase()] = s.CI;
        }
        const pn = String(gameData.PeriodName || '').trim().toLowerCase();
        const active = (pn === '1st half' || pn === '2nd half') ? pn : '';
        document.documentElement.setAttribute(PERIOD_ATTR, JSON.stringify({ active, subgames }));
        console.log(LOG, 'periods:', JSON.stringify({ active, subgames }));
      } catch (e) { /* non-fatal */ }

      new MutationObserver(() => {
        const val = document.documentElement.getAttribute(BET_ATTR);
        if (!val) return;
        document.documentElement.removeAttribute(BET_ATTR);

        // key format: "G|T|P|marketType|selection"
        const [Gs, Ts, Ps, marketType, selection] = val.split('|');
        const G = parseInt(Gs), T = parseInt(Ts), P = parseFloat(Ps);

        const latest = window.store_global?.state?.game?.line?.[constId];
        if (!latest) { console.warn(LOG, 'game data gone'); return; }

        let outcome = null;
        outer: for (const group of latest.Events) {
          if (group.G !== G) continue;
          for (const col of group.E) {
            for (const o of col) {
              // Coerce both sides: tennis match-winner (and other moneyline)
              // outcomes may carry P as null/undefined rather than 0. The
              // adapter sends P=0 for these (see 22bet.js findOddsButton),
              // so without coercion here Math.abs(undefined - 0) is NaN and
              // never matches, even though G/T correctly identify the bet.
              const oP = o.P == null ? 0 : o.P;
              if (o.T === T && Math.abs(oP - P) < 0.001) { outcome = o; break outer; }
            }
          }
        }
        if (!outcome) { console.warn(LOG, 'outcome not found', { G, T, P }); return; }

        const opp1 = latest.Opp1Eng || latest.Opp1;
        const opp2 = latest.Opp2Eng || latest.Opp2;
        let nameGroup, nameBet;
        if (marketType === '1x2') {
          nameGroup = '1x2';
          nameBet = selection === '1' ? opp1 : selection === 'X' ? 'Draw' : opp2;
        } else if (marketType === 'over_under') {
          nameGroup = 'Total';
          nameBet = `${selection} ${P}`;
        } else {
          nameGroup = 'Handicap';
          const sign = P >= 0 ? '+' : '';
          nameBet = selection === '1'
            ? `${opp1} (${sign}${P})`
            : `${opp2} (${P >= 0 ? '-' : '+'}${Math.abs(P)})`;
        }

        const bet = {
          ACT: outcome.ACT || 0,
          B: outcome.B || '',
          C: outcome.C,
          CV: outcome.CV || String(outcome.C),
          G: outcome.G,
          P: outcome.P,
          PV: outcome.PV || null,
          Pl: outcome.Pl || null,
          T: outcome.T,
          CE: '',
          sport_name: latest.SportName,
          sportNameEng: latest.SportNameEng,
          gameNum: latest.Num,
          gameChamp: latest.Champ,
          id_sport: latest.SportId,
          opp1: latest.Opp1,
          opp2: latest.Opp2,
          opp1NameEng: latest.Opp1Eng,
          opp2NameEng: latest.Opp2Eng,
          Opp1Id: latest.Opp1Id,
          Opp2Id: latest.Opp2Id,
          Opp1Image: latest.Opp1Image,
          Opp2Image: latest.Opp2Image,
          GameId: latest.Id,
          constId,
          LigaId: latest.LigaId,
          opp: `${latest.Opp1} - ${latest.Opp2}`,
          sportNameText: `${latest.Num}. ${latest.SportNameEng} ${latest.ChampEng}`,
          nameGroup,
          nameBet,
          Direction: 3,
          InstrumentId: 0,
          Seconds: 0,
          Price: 0,
          disableCouponLink: false,
          prefixUrl: '',
          param_view: null,
          champNameEng: latest.ChampEng,
          param: outcome.P || 0,
          type: outcome.T,
        };

        console.log(LOG, 'dispatching ACTION_ADD_BET', nameGroup, nameBet);
        window.store_global.dispatch('coupon/ACTION_ADD_BET', { bet, is_skip_one_click: false })
          .then(() => {
            document.documentElement.setAttribute(DONE_ATTR, '1');
          })
          .catch(err => {
            console.warn(LOG, 'ACTION_ADD_BET error (not logged in?)', err?.message || err);
            document.documentElement.setAttribute(DONE_ATTR, '1');
          });
      }).observe(document.documentElement, { attributes: true, attributeFilter: [BET_ATTR] });
    }

    // Watch for search trigger set by isolated-world adapter.
    // fillInput's native-setter + 'input' event doesn't update Vue 2 reactive
    // state when called from the isolated world; doing it here (MAIN world)
    // allows direct vm[key] assignment to bypass the issue.
    const SEARCH_TRIGGER = 'data-arb-22bet-search';
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.attributeName !== SEARCH_TRIGGER) continue;
        const term = document.documentElement.getAttribute(SEARCH_TRIGGER);
        if (!term) continue;
        document.documentElement.removeAttribute(SEARCH_TRIGGER);

        const input = document.querySelector('input.searchInput');
        if (!input) { console.warn(LOG, 'search input not found'); continue; }

        // Try direct Vue 2 reactive data assignment via component instance
        const vm = input.__vue__;
        if (vm) {
          const stringKeys = Object.keys(vm.$data).filter(k => typeof vm.$data[k] === 'string');
          console.log(LOG, 'vm string data keys:', stringKeys);
          const searchKey = stringKeys.find(k =>
            ['search', 'query', 'term', 'input', 'value', 'text', 'keyword'].some(kw => k.toLowerCase().includes(kw))
          ) || stringKeys[0];
          if (searchKey) {
            console.log(LOG, `vm.${searchKey} = "${term}"`);
            vm[searchKey] = term;
          }
        }

        // Belt-and-suspenders: also set native DOM value + dispatch events
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, term);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));

        setTimeout(() => {
          const btn = document.querySelector('button.inputCon__button');
          if (btn) btn.click();
          console.log(LOG, `search triggered for: "${term}"`);
        }, 150);
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: [SEARCH_TRIGGER] });

    // Watch for stake-fill trigger. The STAKE (JPY) input (.sum-st input)
    // is Vue 2 reactive — a native-setter write from the isolated world doesn't
    // update the model (same issue as the search input), so the bet uses the
    // default stake. Set the Vue 2 reactive data here in MAIN world + dispatch
    // events. Value format: the stake number as a string.
    const STAKE_TRIGGER = 'data-arb-22bet-stake';
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.attributeName !== STAKE_TRIGGER) continue;
        const amount = document.documentElement.getAttribute(STAKE_TRIGGER);
        if (!amount) continue;
        document.documentElement.removeAttribute(STAKE_TRIGGER);

        // The real STAKE (JPY) field is in the `.sum-st` container — NOT
        // `js_one_summa` (that's the one-click quick-bet amount at the top).
        const input = [...document.querySelectorAll('.sum-st input')].find(i => i.offsetParent !== null)
          || document.querySelector('.sum-st input');
        if (!input) { console.warn(LOG, 'stake input (.sum-st input) not found'); continue; }

        const vm = input.__vue__;
        if (vm) {
          const numKeys = Object.keys(vm.$data).filter(k => typeof vm.$data[k] === 'string' || typeof vm.$data[k] === 'number');
          const stakeKey = numKeys.find(k =>
            ['summa', 'amount', 'stake', 'sum', 'value', 'bet'].some(kw => k.toLowerCase().includes(kw))
          );
          if (stakeKey) { console.log(LOG, `vm.${stakeKey} = "${amount}"`); vm[stakeKey] = amount; }
        }
        const nativeSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, amount);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        console.log(LOG, `stake filled: ${amount}`);
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: [STAKE_TRIGGER] });

    pollStore();
  }

  // ── 1xbet: Vue 3 + Pinia ──────────────────────────────────────────────────

  function init1xbet() {
    function getVueApp() {
      let el = document.querySelector('.game-panel');
      if (!el) return null;
      for (let i = 0; i < 20 && el; i++) {
        if (el.__vue_app__) return el.__vue_app__;
        el = el.parentElement;
      }
      return null;
    }

    function getPinia() {
      return getVueApp()?.config?.globalProperties?.$pinia;
    }

    // Period (half) markets are SEPARATE sub-games on 1xbet, reached by navigating
    // to the sub-game's own permanentId URL (the "Regular time" dropdown does a
    // route change). Expose the active period + the period→permanentId map so the
    // adapter can navigate to e.g. the 1st-half sub-event. gamePeriodName is "" for
    // the main game, "1st half" / "2nd half" for the sub-games.
    function writePeriods(state) {
      try {
        const byId = state.gamesById || {};
        const cur = byId[state.currentGameId] || {};
        const subgames = {};
        for (const id of Object.keys(byId)) {
          const gm = byId[id];
          const pn = (gm.gamePeriodName || '').trim().toLowerCase();
          if (pn && gm.permanentId) subgames[pn] = gm.permanentId;
        }
        const periods = { active: (cur.gamePeriodName || '').trim().toLowerCase(), subgames };
        document.documentElement.setAttribute(PERIOD_ATTR, JSON.stringify(periods));
        console.log(LOG, 'periods:', JSON.stringify(periods));
      } catch (e) { /* non-fatal */ }
    }

    function pollGroups() {
      const state = getPinia()?._s?.get('game')?.$state;
      const groups = state?.marketGroups;
      if (groups?.length) {
        const serialized = groups.map(g => ({
          name: g.name,
          gameName: g.gameName || '',
          gameId: g.gameId,
          marketColumns: g.marketColumns.map(col =>
            col.map(o => ({ id: o.id, name: o.name, param: o.param, typeId: o.typeId, coef: o.coef }))
          ),
        }));
        document.documentElement.setAttribute(GRP_ATTR, JSON.stringify(serialized));
        writePeriods(state);
        console.log(LOG, 'groups ready:', groups.length, 'at', location.pathname, serialized.map(g => g.name));
        const arbGroup = serialized.find(g => g.name === '1X2') || serialized.find(g => g.name === 'Total') || serialized[0];
        if (arbGroup) console.log(LOG, 'sample group', arbGroup.name, '→', arbGroup.marketColumns.flat().slice(0, 4).map(o => ({name:o.name, typeId:o.typeId, param:o.param})));
      } else {
        setTimeout(pollGroups, 300);
      }
    }

    function init() {
      if (!document.querySelector('.game-panel')) {
        setTimeout(init, 300);
        return;
      }
      pollGroups();

      new MutationObserver(() => {
        const outcomeId = document.documentElement.getAttribute(BET_ATTR);
        if (!outcomeId) return;
        document.documentElement.removeAttribute(BET_ATTR);

        const pinia  = getPinia();
        const game   = pinia?._s?.get('game');
        const coupon = pinia?._s?.get('coupon');
        if (!game || !coupon) { console.warn(LOG, 'stores not found'); return; }

        let outcome = null;
        outer: for (const g of game.$state.marketGroups) {
          for (const col of g.marketColumns) {
            for (const o of col) {
              if (o.id === outcomeId) { outcome = o; break outer; }
            }
          }
        }
        console.log(LOG, 'addBet:', outcomeId, '→ found:', !!outcome);
        if (!outcome) return;

        coupon.couponAddBet({ market: outcome }).then(() => {
          try { coupon.couponSetTab(1); } catch (_) {}
          document.documentElement.setAttribute(DONE_ATTR, '1');
        });
      }).observe(document.documentElement, { attributes: true, attributeFilter: [BET_ATTR] });
    }

    init();
  }
})();
