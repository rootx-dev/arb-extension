// Betfury adapter for lib/runner.js
//
// Betfury renders its sportsbook entirely inside a Shadow DOM via the
// BTRenderer SDK (sptpub.com / BetTarget platform). All selectors target the
// shadow root returned by getRoot(); runner.js's root-passing contract keeps
// every callback shadow-DOM-aware automatically.
//
// Search is done via the BTRenderer's built-in sports search (not the casino
// game search that betfury's own .search-button opens). The sports search icon
// has data-cy="ic-search" in the shadow DOM; clicking its parent div navigates
// to /sports/search and mounts an <input placeholder="Search">.
//
// See extension/references/betfury-dom-notes.md for full DOM analysis.

(() => {
  const { lastWord } = window.__arb;

  // Cache the shadow root; re-validate on each call in case page re-renders.
  let _shadowRoot = null;
  function getShadowRoot() {
    if (_shadowRoot?.querySelector('[data-editor-id="navbar"]')) return _shadowRoot;
    _shadowRoot = null;
    (function walk(node) {
      if (_shadowRoot) return;
      if (node.shadowRoot?.querySelector('[data-editor-id="navbar"]')) {
        _shadowRoot = node.shadowRoot;
        return;
      }
      if (node.shadowRoot) walk(node.shadowRoot);
      for (const c of node.children || []) walk(c);
    })(document);
    return _shadowRoot;
  }

  // The BetTarget SDK mounts asynchronously, well after document_idle. In a
  // freshly-opened service-worker tab the runner can find the outcome plate in
  // the DOM and click it BEFORE the SDK has wired its click handler, so the
  // click is silently dropped (event-page reached, but no bet selected — the
  // exact symptom seen on tennis). Wrap the clickable so the runner's
  // `btn.click()` delays for hydration, fires a full pointer sequence, then
  // polls for the slip to open and retries once if nothing happened. Mirrors
  // shuffle's wrapWithHydrationRetry / stake's wrapWithFullClick.
  function wrapWithHydrationRetry(btn) {
    const root = btn.getRootNode(); // shadow root (or document)
    const slipOpen = () =>
      !!root.querySelector('[data-editor-id="betslipSelection"]') ||
      !!root.querySelector('[data-editor-id="betslipStakeInput"] input');
    const dispatch = () => {
      btn.scrollIntoView({ block: 'center' });
      const o = { bubbles: true, cancelable: true, button: 0, view: window };
      btn.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerId: 1, pointerType: 'mouse' }));
      btn.dispatchEvent(new MouseEvent('mousedown', o));
      btn.dispatchEvent(new PointerEvent('pointerup',   { ...o, pointerId: 1, pointerType: 'mouse' }));
      btn.dispatchEvent(new MouseEvent('mouseup',   o));
      btn.dispatchEvent(new MouseEvent('click',     o));
    };
    btn.click = () => {
      setTimeout(() => {
        dispatch();
        let elapsed = 0, latched = false;
        const tick = setInterval(() => {
          if (slipOpen()) { latched = true; clearInterval(tick); return; }
          elapsed += 150;
          if (elapsed >= 1500) {
            clearInterval(tick);
            if (!latched) { console.log('[ARB-betfury] click lost to hydration — retrying'); dispatch(); }
          }
        }, 150);
      }, 1200);
    };
    return btn;
  }

  __arb.run({
    book:     'betfury',
    stateKey: 'betfuryState',

    // /sports (landing) vs /sports/<sport>/.../<teams>-<matchId> (event)
    isLandingPage: (path) => /^\/sports\/?$/.test(path),
    isEventPage:   (path) => /^\/sports\/.+-\d{15,}$/.test(path),

    getRoot: () => getShadowRoot(),

    // Sports search is inside the shadow DOM.  Click the search navbarIcon
    // (identified by data-cy="ic-search" on its SVG) to open the search page,
    // then return the input on the next waitFor tick.
    findSearchInput: (root) => {
      const input = root?.querySelector('input[placeholder="Search"]');
      if (input) return input;
      const searchIcon = root?.querySelector('[data-cy="ic-search"]')?.parentElement;
      if (searchIcon) searchIcon.click();
      return null;
    },

    findEventResult: (root, event) => {
      const t1 = lastWord(event.team1).toLowerCase();
      const t2 = lastWord(event.team2).toLowerCase();
      for (const card of root.querySelectorAll('[data-editor-id="eventCard"]')) {
        const link = card.querySelector('a[href*="/sports/"]');
        if (!link) continue;
        const text = card.textContent.toLowerCase();
        // Skip eSoccer / cyber / esports — BetTarget lists them alongside real events
        if (text.includes('esoccer') || text.includes('cyber') || text.includes('esport')) continue;
        if (text.includes(t1) && text.includes(t2)) return link;
      }
      return null;
    },

    navigateToEvent: (link) => { window.location.href = link.href; },

    // Maps market type → human-readable label used for logging only.
    marketLabel: (market, betData) => {
      if (betData?.sport === 'tennis') {
        if (market.type === 'handicap_2way') {
          // Tennis 2-way match winner. period null = full match; '1st_set' = first set.
          return market.period === '1st_set' ? 'First set - winner' : 'Winner';
        }
        if (market.type === 'over_under') {
          // Tennis game totals. period null = full match; '1st_set' = first set.
          return market.period === '1st_set' ? 'First set - total games' : 'Total games';
        }
      }
      if (market.type === '1x2')           return '1x2';
      if (market.type === 'over_under')    return market.period === 'ot_incl' ? 'Total (incl. overtime)' : 'Total';
      if (market.type === 'handicap_2way') return market.period === 'ot_incl' ? 'Handicap (incl. overtime)' : 'Handicap';
      return null;
    },

    // Match the market section whose textContent prefix identifies the market.
    // Soccer uses bare "Total"/"Handicap"; basketball OT adds "(incl. overtime)";
    // hockey OT adds "(incl. overtime and penalties)" — prefix without closing ")"
    // matches both sports.
    findMarketSection: (root, marketLabel, market, betData) => {
      const allSections = Array.from(root.querySelectorAll('[data-editor-id="tableMarketWrapper"]'));
      console.log(`[ARB-betfury] findMarketSection: ${allSections.length} sections, looking for type=${market.type} period=${market.period}`);
      if (allSections.length > 0) console.log(`[ARB-betfury] section prefixes:`, allSections.map(s => s.textContent?.trim().slice(0,40)));
      // Tennis: period-aware section matching, verified live 2026-06-17 on
      // Atmane vs Medvedev (ATP Halle). Exact title comparisons on children[0]
      // prevent collision between "Winner" and "First set - winner".
      if (betData?.sport === 'tennis') {
        if (market.type === 'handicap_2way') {
          // Full-match winner: section title === "Winner" (excludes "First set - winner" etc.)
          // 1st-set winner: section title === "First set - winner"
          const target = (market.period === '1st_set' ? 'first set - winner' : 'winner');
          for (const s of allSections) {
            const title = (s.children[0]?.textContent?.trim() || '').toLowerCase();
            if (title === target) return s;
          }
          return null;
        }
        if (market.type === 'over_under') {
          // Full-match total games: section title === "Total games"
          // 1st-set total games: section title === "First set - total games"
          const target = (market.period === '1st_set' ? 'first set - total games' : 'total games');
          for (const s of allSections) {
            const title = (s.children[0]?.textContent?.trim() || '').toLowerCase();
            if (title === target) return s;
          }
          return null;
        }
      }
      for (const s of allSections) {
        const t = s.textContent?.trim() || '';
        if (market.type === '1x2') {
          if (t.startsWith('1x2') && !t.includes('Early Payout') && !t.startsWith('1st') && !t.startsWith('2nd')) return s;
        } else if (market.type === 'over_under') {
          if (market.period === 'ot_incl') {
            // basketball: "Total (incl. overtime)"  hockey: "Total (incl. overtime and penalties)"
            if (t.startsWith('Total (incl. overtime')) return s;
          } else {
            // Soccer: "Total" but not "Total (Asian)"
            if (t.startsWith('Total') && !t.startsWith('Total (')) return s;
          }
        } else if (market.type === 'handicap_2way') {
          if (market.period === 'ot_incl') {
            // basketball: "Handicap (incl. overtime)"  hockey: "Handicap (incl. overtime and penalties)"
            if (t.startsWith('Handicap (incl. overtime')) return s;
          } else {
            // Soccer: "Handicap" but not "Handicap (Asian)"
            if (t.startsWith('Handicap') && !t.startsWith('Handicap (')) return s;
          }
        }
      }
      return null;
    },

    // Outcome plates: each [data-editor-id="tableOutcomePlate"] contains:
    //   [data-editor-id="tableOutcomePlateName"] span  → label text
    //   [id^="outcome-"]                                → clickable odds button (stable id)
    //
    // Label formats by market type:
    //   1x2:          "Manchester City" / "draw" / "Crystal Palace"
    //   over_under:   "over 2.5" / "under 2.5"  (lowercase, includes line)
    //   handicap:     "(-4.5)" / "(4.5)"  (signed line in parens, no team name)
    findOddsButton: (section, betData, leg, rowLabel) => {
      const market = betData.market;
      console.log(`[ARB-betfury] findOddsButton: type=${market.type} selection=${leg.selection} line=${leg.line}`);

      for (const plate of section.querySelectorAll('[data-editor-id="tableOutcomePlate"]')) {
        const nameEl = plate.querySelector('[data-editor-id="tableOutcomePlateName"] span');
        const name   = nameEl?.textContent?.trim().toLowerCase() || '';
        let matches  = false;

        if (market.type === 'over_under') {
          // e.g. leg.selection="Over", leg.line=2.5 → match "over 2.5"
          matches = (name === `${leg.selection.toLowerCase()} ${leg.line}`);
        } else if (market.type === 'handicap_2way' && betData.sport === 'tennis') {
          // Tennis match-winner: no line, outcome labelled by player name (like 1x2).
          const team = leg.selection === '1' ? betData.event.team1 : betData.event.team2;
          matches = name.includes(lastWord(team).toLowerCase());
        } else if (market.type === 'handicap_2way') {
          // leg.line is signed: -4.5 for fav, 4.5 for underdog → "(-4.5)" / "(4.5)"
          matches = (name === `(${leg.line})`);
        } else if (market.type === '1x2') {
          if (leg.selection === 'X') {
            matches = name.includes('draw');
          } else {
            const team = leg.selection === '1' ? betData.event.team1 : betData.event.team2;
            matches = name.includes(lastWord(team).toLowerCase());
          }
        }

        if (matches) {
          // sc-7elhv3-1 is the BetTarget clickable odds button class (same Styled
          // Components hash as Roobet — same platform). bt352 and id="outcome-..."
          // are both unstable between deployments; sc-7elhv3-1 is stable.
          const clickable = plate.querySelector('[class*="sc-7elhv3-1"]');
          return clickable ? wrapWithHydrationRetry(clickable) : null;
        }
      }
      return null;
    },

    // Stake input is inside [data-editor-id="betslipStakeInput"] LABEL.
    findStakeInput: (root) =>
      root?.querySelector('[data-editor-id="betslipStakeInput"] input'),

    // Bet slip opens automatically when an odds button is clicked; no toggle needed.
    // openSlipPanel intentionally omitted.

    findHighlightTarget: (root) =>
      root?.querySelector('[data-editor-id="betslipSelection"]'),

    // Default stake is "5"; must clear before filling our value.
    clearStakeFirst: true,

    // Let search results settle after typing (async React state → URL update → render).
    searchSettleMs: 2000,

    // "Place Bet" label for the completion toast (logged-out state shows "Login";
    // actual logged-in label unverified — update after first live test).
    placeBetLabel: 'Place Bet',
  });
})();
