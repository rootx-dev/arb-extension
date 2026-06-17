// GGBet adapter for lib/runner.js
//
// GGBet is a standard React SPA — no shadow DOM, no iframe for the sportsbook.
// Selectors use stable data-test attributes throughout.
//
// Event URL pattern: gg.bet/sports/match/{team1}-vs-{team2}-{DD}-{MM}
// The DD-MM in the slug is NOT always the game date (sometimes the listing date).
// So we navigate via sport listing page + team name matching in the URL slug,
// rather than constructing the event URL directly.
//
// Search flow:
//   1. Service worker opens gg.bet/sports (isLandingPage).
//   2. findSearchInput receives betData (runner.js passes it as 2nd arg) and
//      redirects to gg.bet/sports?sportId=<sport> if not already there, then
//      opens the inline search input via the search button.
//   3. Runner types lastWord(team2) into it (harmless — GGBet's search doesn't
//      filter the listing; we match by slug in findEventResult instead).
//   4. findEventResult scans all a[href*="/sports/match/"] by slug content.
//
// See extension/references/ggbet-dom-notes.md for full DOM analysis.

(() => {
  const { lastWord } = window.__arb;

  // GGBet sportId query params (soccer = "football", ice_hockey uses underscore)
  const SPORT_ID = {
    basketball: 'basketball',
    ice_hockey: 'ice_hockey',
    soccer:     'football',
    tennis:     'tennis',
  };

  // Guard: only trigger one sport-page redirect per content script lifetime.
  // waitFor polls every 300ms — without this, each poll fires another location
  // change before the first navigation completes, causing HTTP 429.
  let _sportNavFired = false;

  __arb.run({
    book:     'ggbet',
    stateKey: 'ggbetState',

    isLandingPage: (path) => path.startsWith('/sports') && !path.startsWith('/sports/match'),
    isEventPage:   (path) => path.startsWith('/sports/match/'),

    // No shadow DOM — root is document itself.
    getRoot: () => document,

    // Navigate to sport-specific listing if needed, then open search input.
    // betData is passed as 2nd arg by runner.js so we know which sport to filter by.
    findSearchInput: (root, betData) => {
      if (betData) {
        const sportId = SPORT_ID[betData.sport];
        if (sportId && !window.location.search.includes(`sportId=${sportId}`)) {
          if (!_sportNavFired) {
            _sportNavFired = true;
            window.location.href = `https://gg.bet/sports?sportId=${sportId}`;
          }
          return null; // wait for page reload
        }
      }
      // On the right listing page — open the inline search input via search button.
      const input = document.querySelector('[data-test="base-input__input-undefined"]');
      if (input) return input;
      const btn = Array.from(document.querySelectorAll('button'))
        .find(b => b.textContent.trim().toLowerCase() === 'search');
      if (btn) btn.click();
      return null; // retry next tick after click opens input
    },

    // Match by team name slug in the event URL (not textContent — too noisy).
    findEventResult: (root, event) => {
      const t1 = lastWord(event.team1).toLowerCase();
      const t2 = lastWord(event.team2).toLowerCase();
      for (const a of document.querySelectorAll('a[href*="/sports/match/"]')) {
        try {
          const slug = new URL(a.href).pathname.split('/').pop().toLowerCase();
          if (slug.includes(t1) && slug.includes(t2)) return a;
        } catch { /* malformed href — skip */ }
      }
      return null;
    },

    navigateToEvent: (link) => { window.location.href = link.href; },

    // Market section header label uses data-test="market-name".
    // Tennis match-winner (handicap_2way, line null — see writing-book-scripts.md
    // "Tennis match-winner arrives as handicap_2way") shows as "勝者" (Winner) on
    // GGBet's JP locale, NOT the lined "Handicap" card. Gate on betData.sport in
    // findMarketSection since marketLabel alone can't tell tennis apart from a
    // lined handicap_2way for another sport using market.type alone.
    marketLabel: (market, betData) => {
      if (betData?.sport === 'tennis') {
        if (market.type === 'handicap_2way') {
          return market.period === '1st_set' ? '1st Set Winner' : 'Winner';
        }
        if (market.type === 'over_under') {
          return market.period === '1st_set' ? '1st Set Total Games' : 'Total Games';
        }
      }
      if (market.type === '1x2')           return '1x2';
      if (market.type === 'over_under')    return market.period === 'ot_incl' ? 'Total (incl. overtime)' : 'Total';
      if (market.type === 'handicap_2way') return market.period === 'ot_incl' ? 'Handicap (incl. overtime)' : 'Handicap';
      return null;
    },

    // Each market card: [data-test="market-name"] → parentElement×3 = card div.
    // betData (4th arg, added to runner.js) gives us sport so we can handle the
    // hockey quirk: GGBet shows bare "Total"/"Handicap" for NHL (OT-inclusive),
    // which is the same label as soccer's null-period markets. Tennis match-winner
    // is also handicap_2way but maps to the "勝者" (Winner) card, not "Handicap".
    //
    // Tennis market-name strings (JP locale — cookie-locked, EN redirect returns JP):
    //   handicap_2way + null    → "勝者"                  (full-match winner)
    //   handicap_2way + 1st_set → "第1stセット - 勝者"     (1st-set winner)
    //   over_under    + null    → "ゲーム総数"              (full-match total games)
    //   over_under    + 1st_set → "第1stセット - ゲーム総数" (1st-set total games)
    //
    // IMPORTANT: "勝者" is a substring of "第1stセット - 勝者", and "ゲーム総数" is a
    // substring of "第1stセット - ゲーム総数". Use === (exact) not includes() to avoid
    // cross-period collision. The full-match winner branch MUST check period === null;
    // otherwise a null-period signal would match the 1st-set card on a contains check.
    findMarketSection: (root, marketLabel, market, betData) => {
      const sport = betData?.sport;
      for (const label of document.querySelectorAll('[data-test="market-name"]')) {
        const t = label.textContent.trim();
        const tl = t.toLowerCase();
        let matches = false;
        if (market.type === '1x2') {
          matches = (t === '1x2');
        } else if (market.type === 'over_under') {
          if (sport === 'tennis') {
            if (market.period === '1st_set') {
              // 1st-set total games — exact match to prevent "ゲーム総数" substring collision
              matches = (t === '第1stセット - ゲーム総数' || tl === '1st set - total games' || tl === 'total games - 1st set' || tl === '1st set total games');
            } else {
              // Full-match total games — exact match only; "第1stセット - ゲーム総数" must NOT match
              matches = (t === 'ゲーム総数' || tl === 'total games' || tl === 'games total');
            }
          } else if (market.period === 'ot_incl' && sport !== 'ice_hockey') {
            matches = (t === 'Total (incl. overtime)');
          } else {
            // Soccer (null period) and ice hockey (ot_incl) both use bare "Total"
            matches = (t === 'Total');
          }
        } else if (market.type === 'handicap_2way') {
          if (sport === 'tennis') {
            if (market.period === '1st_set') {
              // 1st-set winner — exact match to prevent "勝者" substring collision
              matches = (t === '第1stセット - 勝者' || tl === '1st set - winner' || tl === 'winner - 1st set' || tl === '1st set winner');
            } else {
              // Full-match winner (draw-less moneyline, leg.line null) — exact match only
              // NOTE: The Market object has no `line` field — line lives on the leg — so
              // gate on sport + period, not market.line. See writing-book-scripts.md
              // "Tennis match-winner arrives as handicap_2way".
              matches = (t === '勝者' || tl === 'winner');
            }
          } else if (market.period === 'ot_incl' && sport !== 'ice_hockey') {
            matches = (t === 'Handicap (incl. overtime)');
          } else {
            matches = (t === 'Handicap');
          }
        }
        if (matches) return label.parentElement?.parentElement?.parentElement ?? null;
      }
      if (sport === 'tennis') {
        // Diagnostic: tennis market label not found — surface candidates for one-line fix.
        console.log('[ARB-ggbet] tennis market-name candidates:',
          Array.from(document.querySelectorAll('[data-test="market-name"]')).map(e => e.textContent.trim()));
      }
      return null;
    },

    // Outcome title format:
    //   over_under:   "over 22.5" / "under 22.5"  (lowercase, space-separated)
    //                 Same format for tennis total-games and 1st-set total-games.
    //   handicap_2way: "-9.5" (negative) / "+9.5" (positive with explicit +)
    //   1x2:          full team name or "draw"
    //   handicap_2way (tennis, line null — both full match and 1st set): player name
    //     (same card structure, 2 buttons in team1/team2 order).
    //     GGBet JP locale may transliterate player names to katakana, breaking
    //     lastWord text-match. Fallback: positional index (sel '1' → btn[0],
    //     sel '2' → btn[1]) since the winner card is always exactly 2 buttons in
    //     team1/team2 order (confirmed 2026-06-17, Tiafoe vs Shimabukuro, ATP Halle).
    findOddsButton: (section, betData, leg, rowLabel) => {
      const market = betData.market;
      console.log(`[ARB-ggbet] findOddsButton: type=${market.type} period=${market.period} selection=${leg.selection} line=${leg.line} sport=${betData.sport}`);

      // Tennis winner (full match + 1st set): 2-button card, team1/team2 order.
      // Try name-match first; fall back to positional index when JP locale
      // transliterates player names to katakana (e.g. "Frances Tiafoe" → "ティアフォー,フランセス").
      if (market.type === 'handicap_2way' && betData.sport === 'tennis' && leg.line === null) {
        const team = leg.selection === '1' ? betData.event.team1 : betData.event.team2;
        const nameTarget = lastWord(team).toLowerCase();
        const allBtns = Array.from(section.querySelectorAll('[data-action="Select odd"]'));
        // Name match first
        for (const btn of allBtns) {
          const text = btn.querySelector('[data-test="odd-button__title"]')?.textContent.trim().toLowerCase() ?? '';
          if (text.includes(nameTarget)) return btn;
        }
        // Positional fallback: sel '1' → index 0, sel '2' → index 1
        const idx = leg.selection === '1' ? 0 : 1;
        if (allBtns[idx]) {
          console.log(`[ARB-ggbet] tennis winner: name match failed for "${nameTarget}", using positional index ${idx}`);
          return allBtns[idx];
        }
        return null;
      }

      for (const titleEl of section.querySelectorAll('[data-test="odd-button__title"]')) {
        const text = titleEl.textContent.trim().toLowerCase();
        let matches = false;

        if (market.type === 'over_under') {
          // Covers all over_under periods (null = full match, 1st_set, ot_incl).
          // Format: "over 22.5" / "under 22.5" — lowercase, space-separated.
          matches = text === `${leg.selection.toLowerCase()} ${leg.line}`;
        } else if (market.type === 'handicap_2way') {
          // leg.line is a number; GGBet shows "+9.5" for positive lines.
          const n = Number(leg.line);
          const lineStr = n >= 0 ? `+${n}` : `${n}`;
          matches = text === lineStr;
        } else if (market.type === '1x2') {
          if (leg.selection === 'X') {
            matches = text.includes('draw');
          } else {
            const team = leg.selection === '1' ? betData.event.team1 : betData.event.team2;
            matches = text.includes(lastWord(team).toLowerCase());
          }
        }

        if (matches) {
          return titleEl.closest('[data-action="Select odd"]') ?? null;
        }
      }
      return null;
    },

    // Stake input is always in the DOM; only return it after a bet is added
    // (betslip-stub changes from "0Match" to "1Match" on selection).
    findStakeInput: () => {
      const stub = document.querySelector('[data-test="betslip-stub"]');
      if (!stub || stub.textContent.trim().startsWith('0')) return null;
      return document.querySelector('[data-test="base-input__input-betslip-amount-input-field"]');
    },

    findHighlightTarget: () => {
      // Expand the bet slip pill into the full panel so the user can see it.
      const pill = document.querySelector('[data-test="betslip-pill-button"]');
      if (pill) pill.click();
      return document.querySelector('[data-test="betslip-odd"]');
    },

    clearStakeFirst: true,

    // Runner types lastWord(team2) into the search input; GGBet doesn't filter
    // by this but we still need a brief pause before scanning for event cards.
    searchSettleMs: 500,

    // Logged-out state shows "Sign In & Bet"; logged-in is "Place Bet" (unverified).
    placeBetLabel: 'Place Bet',
  });
})();
