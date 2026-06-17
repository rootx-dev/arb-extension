// Cloudbet adapter for the shared runner (extension/lib/runner.js).
//
// Tab routing by sport + market:
//   basketball/hockey (any market)  → ?tab=popular  (Game lines card)
//   soccer 1x2 / over_under        → ?tab=main      (Full Time Result / Total Goals cards)
//   soccer handicap_2way            → ?tab=asianLines; button text = "{TeamAbbrev} {signedLine}{odds}"
//                                    or "{signedLine}{odds}" — match by signed line value across all buttons
//   tennis (any market)             → ?markets-tab=all  (NOTE: tennis uses ?markets-tab=, NOT ?tab=)
//     handicap_2way period null     → "Winner" card (2 buttons, idx 0=player1, 1=player2; no draw)
//     handicap_2way period 1st_set  → "Winner of set 1" card (2 buttons, idx 0=player1, 1=player2)
//     over_under period 1st_set     → "Total games in set 1" card; each line is a row
//        [lineText, Over btn, Under btn]; pick line then Over=0/Under=1
//     over_under period null        → "Total Games" card; same row structure as set-1 card
//
// Soccer OU "Total Goals" card has "Over"/"Under" as visible column labels (NOT
// text-on-tertiary). Pick by index: Over=0, Under=1. Only the featured line is
// shown — if leg.line doesn't match, we log and return null.

(() => {
  const { lastWord } = window.__arb;

  // Detect sport from URL path.
  const sportFromPath = () => {
    const m = location.pathname.match(/\/en\/sports\/([^/]+)/);
    return m ? m[1].replace(/-/g, '_') : null;
  };

  // Smallest element under `root` whose trimmed text satisfies the predicate.
  function findByText(root, predicate) {
    let best = null;
    for (const el of root.querySelectorAll('div, span')) {
      const t = el.textContent?.trim() ?? '';
      if (!t || !predicate(t)) continue;
      if (!best || t.length < best.textContent.trim().length) best = el;
    }
    return best;
  }

  // Prefer a "Game lines"-labelled card; fall back to smallest element with
  // ≥ 2 odd-buttons so a heading rename doesn't break us.
  function findOddsSection() {
    const gameLinesRe = /game\s*lines/i;
    let preferred = null, fallback = null;
    for (const el of document.querySelectorAll('div, section, article')) {
      const n = el.querySelectorAll('button[data-test-id="odd-button"]').length;
      if (n === 0) continue;
      const txt = el.textContent || '';
      if (n >= 2 && (!fallback || txt.length < fallback.textContent.length)) fallback = el;
      if (gameLinesRe.test(txt) && (!preferred || txt.length < preferred.textContent.length)) preferred = el;
    }
    return preferred || fallback;
  }

  // Find the card whose title text matches exactly, walking up until we find a
  // container with at least `minButtons` odd-buttons.
  function findSectionByTitle(titleText, minButtons = 3) {
    for (const el of document.querySelectorAll('span, div')) {
      if (el.children.length !== 0) continue;
      if (el.textContent.trim() !== titleText) continue;
      let card = el;
      for (let i = 0; i < 10 && card; i++) {
        if (card.querySelectorAll('button[data-test-id="odd-button"]').length >= minButtons) return card;
        card = card.parentElement;
      }
    }
    return null;
  }

  function findColumnHeader(root, text) {
    const lower = text.toLowerCase();
    return findByText(root, (t) => t.toLowerCase() === lower) ||
           findByText(root, (t) => t.toLowerCase().includes(lower));
  }

  // Row label uses last-word match to tolerate Cloudbet's abbreviations
  // (e.g. "Buffalo Sabres" renders as "BUF Sabres").
  function findRowLabel(root, label) {
    const last = lastWord(label).toLowerCase();
    return findByText(root, (t) => t.toLowerCase().includes(last));
  }

  function linkMatchesEvent(linkText, event) {
    const t = linkText.toLowerCase();
    return t.includes(lastWord(event.team1).toLowerCase()) &&
           t.includes(lastWord(event.team2).toLowerCase());
  }

  __arb.run({
    book: 'cloudbet',
    stateKey: 'cloudbetState',

    isLandingPage: (path) => /^\/en\/sports\/?$/.test(path),
    isEventPage:   (path) => path.split('/').length > 4,

    getRoot: () => document,

    findSearchInput: (root) => root.querySelector('input.input'),

    findEventResult: (root, event) => {
      for (const link of root.querySelectorAll('a.team')) {
        const text = link.querySelector('.sr-only')?.textContent ?? link.textContent;
        if (linkMatchesEvent(text, event)) return link;
      }
      return null;
    },

    navigateToEvent: async (link) => {
      const { cloudbetState } = await chrome.storage.local.get('cloudbetState');
      const sport = cloudbetState?.betData?.sport;
      const marketType = cloudbetState?.betData?.market?.type;
      const base = link.href.split('?')[0];
      let url;
      if (sport === 'tennis') {
        // Tennis uses a different query param name (?markets-tab=, not ?tab=).
        // 'all' renders all tennis cards: "Winner", "Winner of set 1", "Total Games",
        // "Total games in set 1", etc. One param covers all supported tennis markets.
        url = base + '?markets-tab=all';
      } else if (sport === 'soccer' && marketType === 'handicap_2way') {
        url = base + '?tab=asianLines';
      } else if (sport === 'soccer' && marketType === 'over_under') {
        url = base + '?tab=goals';
      } else if (sport !== 'soccer') {
        url = base + '?tab=popular';
      } else {
        url = base; // soccer 1x2: main tab (default)
      }
      console.log(`[ARB-cloudbet] navigating to: ${url} (sport=${sport} marketType=${marketType})`);
      window.location.href = url;
    },

    marketLabel: (market) => {
      if (sportFromPath() === 'tennis') {
        if (market.type === 'handicap_2way' && market.period === '1st_set') return 'Winner of set 1';
        if (market.type === 'handicap_2way') return 'Winner';
        if (market.type === 'over_under' && market.period === '1st_set')    return 'Total games in set 1';
        if (market.type === 'over_under')    return 'Total Games';
      }
      if (market.type === '1x2') return 'Full Time Result';
      if (market.type === 'over_under' && sportFromPath() === 'soccer') return 'Total Goals';
      if (market.type === 'over_under')    return 'Total (Incl. Overtime and Penalties)';
      if (market.type === 'handicap_2way' && sportFromPath() === 'soccer') return 'Asian Handicap';
      if (market.type === 'handicap_2way') return 'Winner (Incl. Overtime and Penalties)';
      return null;
    },

    findMarketSection: (_root, label, market) => {
      const sport = sportFromPath();
      if (sport === 'tennis' && market.type === 'handicap_2way' && market.period === '1st_set') return findSectionByTitle('Winner of set 1', 2);
      if (sport === 'tennis' && market.type === 'handicap_2way') return findSectionByTitle('Winner', 2);
      if (sport === 'tennis' && market.type === 'over_under' && market.period === '1st_set')    return findSectionByTitle('Total games in set 1', 2);
      if (sport === 'tennis' && market.type === 'over_under')    return findSectionByTitle('Total Games', 2);
      if (market.type === '1x2') return findSectionByTitle(label, 3);
      if (market.type === 'over_under' && sport === 'soccer') return findSectionByTitle('Total Goals', 2);
      return findOddsSection();
    },

    findOddsButton: (section, betData, leg, rowLabel) => {
      console.log(`[ARB-cloudbet] findOddsButton: url=${location.href} sport=${betData.sport} type=${betData.market.type} selection=${leg.selection} line=${leg.line}`);

      // Tennis handicap_2way (match-winner OR 1st-set winner): section is already scoped
      // by findMarketSection to the right card ("Winner" or "Winner of set 1"). Both cards
      // have exactly 2 buttons (player1, player2), no draw. Pick by selection index.
      if (betData.sport === 'tennis' && betData.market.type === 'handicap_2way') {
        const buttons = section.querySelectorAll('button[data-test-id="odd-button"]');
        const idx = { '1': 0, '2': 1 }[leg.selection];
        return (idx !== undefined && buttons[idx]) || null;
      }

      // Tennis over_under (full-match OR 1st-set total games): section is already scoped
      // by findMarketSection to the right card ("Total Games" or "Total games in set 1").
      // Each line is a row [lineText, Over btn, Under btn]. Scope the line search to the
      // card so we don't match per-player totals or other cards elsewhere on the page.
      if (betData.sport === 'tennis' && betData.market.type === 'over_under') {
        const lineEl = Array.from(section.querySelectorAll('div, span'))
          .filter(el => el.children.length === 0 && !el.closest('button[data-test-id="odd-button"]'))
          .find(el => parseFloat(el.textContent?.trim()) === leg.line);
        if (!lineEl) {
          console.log(`[ARB-cloudbet] tennis OU (period=${betData.market.period}): line ${leg.line} not found in card`);
          return null;
        }
        let row = lineEl;
        for (let i = 0; i < 10 && row; i++) {
          const rowBtns = row.querySelectorAll('button[data-test-id="odd-button"]');
          if (rowBtns.length === 2) {
            const idx = leg.selection === 'Over' ? 0 : 1;
            console.log(`[ARB-cloudbet] tennis OU (period=${betData.market.period}): row at depth ${i}, idx=${idx} for ${leg.selection} ${leg.line}`);
            return rowBtns[idx] || null;
          }
          row = row.parentElement;
        }
        console.log(`[ARB-cloudbet] tennis OU (period=${betData.market.period}): found line ${leg.line} but no 2-button row`);
        return null;
      }

      if (betData.market.type === '1x2') {
        const buttons = section.querySelectorAll('button[data-test-id="odd-button"]');
        const idx = { '1': 0, 'X': 1, '2': 2 }[leg.selection];
        return (idx !== undefined && buttons[idx]) || null;
      }

      if (betData.market.type === 'over_under' && betData.sport === 'soccer') {
        // Goals tab shows featured line in "Total Goals" card + alternative lines
        // in other sections. Search the whole page so we find the target line
        // regardless of which section it lands in.
        const allLeafs = Array.from(document.querySelectorAll('div, span'))
          .filter(el => el.children.length === 0 && el.textContent?.trim().length > 0);

        const lineEl = allLeafs.find(el => parseFloat(el.textContent?.trim()) === leg.line);
        if (!lineEl) {
          console.log(`[ARB-cloudbet] soccer OU: line ${leg.line} not found anywhere on page`);
          return null;
        }
        let row = lineEl;
        for (let i = 0; i < 10 && row; i++) {
          const rowBtns = row.querySelectorAll('button[data-test-id="odd-button"]');
          if (rowBtns.length === 2) {
            const idx = leg.selection === 'Over' ? 0 : 1;
            console.log(`[ARB-cloudbet] soccer OU: row found at depth ${i}, picking idx=${idx} for ${leg.selection} ${leg.line}`);
            return rowBtns[idx] || null;
          }
          row = row.parentElement;
        }
        console.log(`[ARB-cloudbet] soccer OU: found line ${leg.line} but could not isolate its row`);
        return null;
      }

      // Soccer Asian Handicap: button text is "{TeamAbbrev} {signedLine}{odds}" or
      // "{signedLine}{odds}" — no separate column header. Line may be in the main
      // "Asian Handicap" card or in "Alternative lines". Search all page buttons.
      if (betData.market.type === 'handicap_2way' && betData.sport === 'soccer') {
        // signed line: selection='1' uses the (already-negative) leg.line; selection='2' is positive
        const signedLine = leg.selection === '1'
          ? String(leg.line)           // e.g. "-1.25" (already negative from parser)
          : '+' + Math.abs(leg.line);  // e.g. "+1.25"
        const allBtns = [...document.querySelectorAll('button[data-test-id="odd-button"]')];
        console.log(`[ARB-cloudbet] soccer HA: looking for "${signedLine}" in ${allBtns.length} buttons`);
        // Integer lines (e.g. "+1") need a digit-after check to avoid matching "+1.25".
        // Decimal lines (e.g. "+1.25") are unambiguous with includes().
        const isInteger = Number.isInteger(parseFloat(signedLine));
        const re = isInteger
          ? new RegExp(signedLine.replace('+', '\\+').replace('-', '\\-') + '\\d')
          : null;
        const btn = allBtns.find(b => isInteger ? re.test(b.textContent) : b.textContent.includes(signedLine));
        if (!btn) console.log('[ARB-cloudbet] soccer HA available:', allBtns.map(b => b.textContent.trim()));
        return btn || null;
      }

      // Basketball/hockey OU: column-spatial. Over/Under labels aren't visible DOM
      // strings in Game lines — Total column stacks Over on top, Under below.
      const columnText = betData.market.type === 'over_under'
        ? 'Total (Incl. Overtime and Penalties)'
        : 'Winner (Incl. Overtime and Penalties)';

      const colEl = findColumnHeader(section, columnText);
      if (!colEl) {
        console.log(`[ARB-cloudbet] column "${columnText}" not found in section`);
        return null;
      }
      const colRect = colEl.getBoundingClientRect();
      const targetX = colRect.left + colRect.width / 2;

      if (betData.market.type === 'over_under') {
        const inColumn = Array.from(section.querySelectorAll('button[data-test-id="odd-button"]'))
          .map((b) => ({ b, r: b.getBoundingClientRect() }))
          .filter((x) => Math.abs((x.r.left + x.r.width / 2) - targetX) < 80)
          .sort((a, b) => a.r.top - b.r.top);
        const idx = leg.selection === 'Over' ? 0 : 1;
        return inColumn[idx]?.b || null;
      }

      // Handicap (basketball/hockey): column + row-by-team-label spatial lookup.
      const rowEl = findRowLabel(section, rowLabel);
      if (!rowEl) return null;
      const rowRect = rowEl.getBoundingClientRect();
      const targetY = rowRect.top + rowRect.height / 2;

      let best = null;
      for (const b of section.querySelectorAll('button[data-test-id="odd-button"]')) {
        const r = b.getBoundingClientRect();
        const dist = Math.hypot((r.left + r.width / 2) - targetX, (r.top + r.height / 2) - targetY);
        if (!best || dist < best.dist) best = { btn: b, dist };
      }
      return best?.btn || null;
    },

    findStakeInput: (root) => root.querySelector('[data-test-id="stake-0"]'),

    openSlipPanel: (root) =>
      Array.from(root.querySelectorAll('button'))
        .find((b) => b.textContent.trim().startsWith('Betslip')) || null,

    allowReclick: true,

    // Currency context settles asynchronously after the slip opens; filling too
    // soon makes Cloudbet treat the number as USD and auto-convert (5319 → ~800k).
    currencySettleMs: 1500,

    clearStakeFirst: true,

    findHighlightTarget: (root) => root.querySelector('[data-test-id="betslip-item"]'),

    placeBetLabel: 'ベットする',
  });
})();
