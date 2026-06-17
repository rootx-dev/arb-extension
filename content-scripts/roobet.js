// Roobet adapter for the shared runner (extension/lib/runner.js).
//
// Roobet's entire sportsbook renders inside a Shadow DOM on a single host
// <div>. Every query goes through the shadow root. Odds buttons are
// "<team><odds>" text; matching the last word of the team name uniquely
// identifies the button inside a market section.

(() => {
  const { sleep, waitFor, lastWord } = window.__arb;

  // Section title (matched case-insensitive exact `===` on the title span). For
  // hockey/basketball both "Total" and "Total (incl. overtime and penalties)"
  // co-exist as separate sections — use the longer string when the signal
  // asks for OT-incl so the match doesn't latch the regulation section first.
  // Tennis has per-period variants ("Winner" / "First set - winner",
  // "Total games" / "First set - total games") — returned as full exact titles.
  function getMarketTitle(market, betData) {
    if (market.type === '1x2') return '1x2';
    if (market.type === 'handicap_2way') {
      if (market.period === 'ot_incl') return 'Winner (incl. overtime and penalties)';
      if (betData?.sport === 'tennis') {
        // Tennis 2-way match winner. period null = full match; '1st_set' = first set.
        return market.period === '1st_set' ? 'First set - winner' : 'Winner';
      }
      // Soccer Asian Handicap = 'Handicap' on BetTarget platform; basketball/hockey
      // regular-time 2-way moneyline = 'Winner'.
      return betData?.sport === 'soccer' ? 'Handicap' : 'Winner';
    }
    if (market.type === 'over_under') {
      if (market.period === 'ot_incl') return 'Total (incl. overtime and penalties)';
      if (betData?.sport === 'tennis') {
        // Tennis game totals. period null = full match; '1st_set' = first set.
        return market.period === '1st_set' ? 'First set - total games' : 'Total games';
      }
      return 'Total';
    }
    return null;
  }

  function getShadowRoot() {
    const host = Array.from(document.querySelectorAll('div')).find((el) => el.shadowRoot);
    return host?.shadowRoot || null;
  }

  // Walk up from a title-matching span until we hit a node with the
  // [title, odds] two-child shape — structural check beats a fixed N-parent walk.
  //
  // Uses exact case-insensitive === on the span text so that "Winner" does not
  // accidentally latch "First set - winner" (a substring collision that would
  // arise with the old includes() match when tennis period variants are present).
  function findMarketSection(sr, titleFragment) {
    if (!sr) return null;
    const needle = titleFragment.toLowerCase();
    for (const span of sr.querySelectorAll('span')) {
      if (span.textContent.trim().toLowerCase() !== needle) continue;
      let node = span.parentElement;
      for (let i = 0; i < 10 && node; i++, node = node.parentElement) {
        if (
          node.children.length === 2 &&
          node.children[0].contains(span) &&
          node.children[1].querySelector('[class*="sc-7elhv3-0"]')
        ) return node;
      }
    }
    return null;
  }

  __arb.run({
    book: 'roobet',
    stateKey: 'roobetState',

    // Landing: /sports or /sports/{sport} → ≤2 path segments.
    isLandingPage: (path) => path.split('/').filter(Boolean).length <= 2,
    // Event: /sports/{sport}/{country}/{league}/{slug} → ≥3 segments.
    isEventPage:   (path) => path.split('/').filter(Boolean).length >= 3,

    getRoot: () => getShadowRoot(),

    findSearchInput: (sr) => sr.querySelector('input[placeholder="Search"]'),

    findEventResult: (sr, event) => {
      const w1 = lastWord(event.team1).toLowerCase();
      const w2 = lastWord(event.team2).toLowerCase();
      return Array.from(sr.querySelectorAll('div[class*="sc-1j7b86u-0"]')).find((el) => {
        const t = el.textContent.toLowerCase();
        return t.includes(w1) && t.includes(w2);
      }) || null;
    },

    // SPA pushState → click result, wait for URL to update, then full reload
    // so the content script re-injects on the event page.
    navigateToEvent: async (card, event) => {
      card.click();
      const w2 = lastWord(event.team2).toLowerCase();
      await waitFor(() => window.location.pathname.includes(w2), { timeout: 8000 });
      window.location.reload();
    },

    searchSettleMs: 1500,

    marketLabel: (market, betData) => getMarketTitle(market, betData),

    // Click ALL tab so every market section is rendered (some hide under category tabs).
    beforeFindMarket: async (sr) => {
      const allTab = Array.from(sr.querySelectorAll('span')).find(
        (el) => el.textContent.trim() === 'ALL',
      );
      if (allTab) { allTab.click(); await sleep(600); }
    },

    findMarketSection: (sr, label) => findMarketSection(sr, label),

    findOddsButton: (section, betData, leg, rowLabel) => {
      const buttons = Array.from(section.querySelectorAll('[class*="sc-7elhv3-0"]'));

      // OU: Roobet's OU section lists every line side-by-side (e.g. over 3.5,
      // under 3.5, over 4.5, under 4.5, …). lastWord-of-"Over" alone hits the
      // first over button regardless of line — match the full
      // "<side> <line>" prefix so the right line is picked.
      // Button text format: "over 5.51.58" / "under 5.52.38".
      if (betData.market.type === 'over_under') {
        const side = leg.selection.toLowerCase(); // "over" / "under"
        const prefix = `${side} ${leg.line}`.toLowerCase();
        return buttons.find((b) => b.textContent.trim().toLowerCase().startsWith(prefix)) || null;
      }

      // Soccer handicap_2way: BetTarget outcome labels are "(line)" with no team
      // name — e.g. "(-1.25)1.84" / "(1.25)2.10". Match by signed line string.
      if (betData.market.type === 'handicap_2way' && betData.sport === 'soccer') {
        const lineStr = `(${leg.line})`;
        return buttons.find((b) => b.textContent.includes(lineStr)) || null;
      }

      // 1x2 / hockey+basketball handicap_2way: row label is a team name; last-word
      // match identifies the right button inside the section.
      const last = lastWord(rowLabel).toLowerCase();
      return buttons.find((b) => b.textContent.toLowerCase().includes(last)) || null;
    },

    findStakeInput: (sr) => sr.querySelector('input[inputmode="decimal"]'),

    placeBetLabel: 'Place Bet',
  });
})();
