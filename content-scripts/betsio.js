// Betsio adapter for the shared runner (extension/lib/runner.js).
//
// Betsio embeds its sportsbook in a same-origin iframe (betsio.com/en/sportsbook).
// getRoot() returns the iframe's contentDocument so all selectors work inside it.
// The outer page URL mirrors the iframe route with /sports/ instead of /sportsbook/:
//   Iframe:  https://www.betsio.com/sportsbook/basketball/<slug>-m-<id>
//   Outer:   https://www.betsio.com/sports/basketball/<slug>-m-<id>
// navigateToEvent swaps /sportsbook/ → /sports/ and does a full reload so the
// content script re-runs and enters doFill on the event page.
//
// Market labels (verified 2026-05-13/14):
//   basketball  handicap_2way  ot_incl   "Points Handicap"
//   basketball  over_under     ot_incl   "Total Points"
//   soccer      1x2            null      "Match Result"
//   soccer      over_under     null      "Total Goals"
//   soccer      handicap_2way  null      "Goals Handicap"
//   ice_hockey  handicap_2way  ot_incl   "Match Winner (Including Overtime)"  ← NHL 2-way moneyline
// No OT total exists for ice hockey on betsio — only regular-time totals/handicaps.
//
// Odds button text format:
//   H/A + handicap:   "{Team Name} ({sign}{line}){odds}"
//   H/A no line:      "{Team Name}{odds}"  (ice hockey moneyline)
//   OU:               "Over {line}{odds}" / "Under {line}{odds}"
//   1x2:              "{Team Name}{odds}" / "Draw{odds}"

(() => {
  const { lastWord } = window.__arb;

  function getIframe() {
    return document.querySelector('iframe[src*="sportsbook"]');
  }

  // Sport slug from the outer URL path (/sports/<sport>/...)
  function sportSlug() {
    const m = location.pathname.match(/\/sports\/([^/]+)/);
    return m ? m[1] : null;
  }

  function getMarketLabel(market) {
    const sport = sportSlug();
    if (market.type === '1x2') return 'Match Result';
    if (market.type === 'over_under') {
      // Tennis game totals. Full-match "Total Games" vs 1st-set "1 Set Total Games".
      if (sport === 'tennis')     return market.period === '1st_set' ? '1 Set Total Games' : 'Total Games';
      if (sport === 'basketball') return 'Total Points';
      if (sport === 'soccer')     return 'Total Goals';
    }
    if (market.type === 'handicap_2way') {
      // Tennis match-winner = draw-less 2-way moneyline (line null). Full-match
      // "Match Winner" vs 1st-set "1 Set Winner". Verified live 2026-06-17.
      if (sport === 'tennis')     return market.period === '1st_set' ? '1 Set Winner' : 'Match Winner';
      if (sport === 'basketball') return 'Points Handicap';
      if (sport === 'soccer')     return 'Goals Handicap';
      if (sport === 'ice-hockey') return 'Match Winner (Including Overtime)';
    }
    return null;
  }

  function findMarketTable(root, label) {
    for (const t of root.querySelectorAll('.sb-MarketTable')) {
      if (t.querySelector('.sb-MarketTable-name')?.textContent?.trim() === label) return t;
    }
    return null;
  }

  // Tennis match-winner table: exact title is unverified on betsio. Try the
  // common 2-way-winner labels; on miss, log the available table names so the
  // real one is a 1-line fix.
  function findTennisWinnerTable(root) {
    const CANDIDATES = ['Match Winner', 'Winner', 'Match Result', 'To Win Match', '1x2', 'Moneyline'];
    const tables = Array.from(root.querySelectorAll('.sb-MarketTable'));
    for (const cand of CANDIDATES) {
      const hit = tables.find(t => t.querySelector('.sb-MarketTable-name')?.textContent?.trim() === cand);
      if (hit) return hit;
    }
    console.log('[ARB-betsio] tennis winner table not found; available tables:',
      tables.map(t => t.querySelector('.sb-MarketTable-name')?.textContent?.trim()));
    return null;
  }

  // The betsio sportsbook (iframe BetTarget SDK) hydrates asynchronously, so in a
  // freshly-opened service-worker tab the runner can find the outcome and click it
  // before the SDK wires its handler → click dropped, event page reached but no
  // bet selected (the reported tennis symptom). Wrap the outcome so the click is
  // delayed, fires a full pointer sequence, then polls for the slip and retries
  // once. Mirrors shuffle/stake/betfury. `el` may be null (no match) → pass through.
  function wrap(el) {
    if (!el) return null;
    const root = el.getRootNode(); // iframe document
    const slipOpen = () =>
      !!root.querySelector('.sb-StakeInput-input') || !!root.querySelector('.sb-BetSlipSingleBet');
    const dispatch = () => {
      el.scrollIntoView({ block: 'center' });
      const o = { bubbles: true, cancelable: true, button: 0, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', { ...o, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mousedown', o));
      el.dispatchEvent(new PointerEvent('pointerup',   { ...o, pointerId: 1, pointerType: 'mouse' }));
      el.dispatchEvent(new MouseEvent('mouseup',   o));
      el.dispatchEvent(new MouseEvent('click',     o));
    };
    el.click = () => {
      setTimeout(() => {
        dispatch();
        let elapsed = 0, latched = false;
        const tick = setInterval(() => {
          if (slipOpen()) { latched = true; clearInterval(tick); return; }
          elapsed += 150;
          if (elapsed >= 1500) {
            clearInterval(tick);
            if (!latched) { console.log('[ARB-betsio] click lost to hydration — retrying'); dispatch(); }
          }
        }, 150);
      }, 1200);
    };
    return el;
  }

  // Sport slug map: betData.sport → betsio URL path segment.
  // Used in findEventResult to skip cross-sport name collisions (e.g. baseball
  // teams called "Knights" showing up when searching for NHL "Golden Knights").
  const SPORT_SLUG = { basketball: 'basketball', soccer: 'soccer', ice_hockey: 'ice-hockey' };

  // Set by findSearchInput (which receives betData as 2nd arg from runner.js).
  let _sportPath = null;

  __arb.run({
    book: 'betsio',
    stateKey: 'betsioState',

    isLandingPage: (path) => /^\/sports\/?$/.test(path),
    isEventPage:   (path) => /\/sports\/[^/]+\/[^/]+-m-\d+/.test(path),

    // Use the iframe document as root; only ready once the SPA layout is mounted.
    getRoot: () => {
      const doc = getIframe()?.contentDocument;
      return doc?.querySelector('.sb-BaseLayout') ? doc : null;
    },

    findSearchInput: (root, betData) => {
      if (betData) _sportPath = SPORT_SLUG[betData.sport] ?? null;
      const existing = root?.querySelector('.sb-SearchBar-input');
      if (existing) return existing;
      // Search bar is closed — click the main-page button to open it.
      document.querySelector('.sportsbook-search-btn')?.click();
      return null; // runner will retry via waitFor
    },

    findEventResult: (root, event) => {
      const t1 = lastWord(event.team1).toLowerCase();
      const t2 = lastWord(event.team2).toLowerCase();
      for (const a of root.querySelectorAll('a[href*="-m-"]')) {
        const href = a.href.toLowerCase();
        // Skip results from the wrong sport (e.g. baseball "Knights" when
        // searching for NHL "Golden Knights").
        if (_sportPath && !href.includes('/' + _sportPath + '/')) continue;
        const text = a.textContent.toLowerCase();
        if (text.includes('cyber') || text.includes('esport')) continue;
        if (text.includes(t1) && text.includes(t2)) return a;
      }
      return null;
    },

    navigateToEvent: (link) => {
      // Swap /sportsbook/ → /sports/ to get the outer-page URL, then full reload.
      window.location.href = link.href.replace('/sportsbook/', '/sports/');
    },

    marketLabel: (market) => getMarketLabel(market),

    // Soccer markets: "Top" tab only shows featured/default outcomes.
    //   handicap_2way → switch to "All" (shows every handicap line)
    //   over_under    → switch to "Total" (shows all OU lines 0.5–6.5)
    // Tab buttons render ~1s after SPA mount, so poll until found.
    // .click() from isolated world doesn't trigger Radix. betsio-main.js
    // runs in MAIN world and injects a full pointer-event sequence into the iframe.
    beforeFindMarket: async (root, { sleep, logger }) => {
      const { betsioState } = await chrome.storage.local.get('betsioState');
      const { market, sport } = betsioState?.betData ?? {};
      // Soccer handicap → "All" tab (Top only shows 2 featured outcomes).
      // Soccer OU → "Total" tab (Top only shows one default line).
      let tabName = null;
      // Tennis match-winner is a default/Top market — don't switch to the "All"
      // (handicap-lines) tab, which is meant for soccer spread lines.
      if (market?.type === 'handicap_2way' && sport !== 'tennis') tabName = 'All';
      else if (market?.type === 'over_under' && sport === 'soccer') tabName = 'Total';
      if (!tabName) return;
      let tabFound = false;
      for (let i = 0; i < 6; i++) {
        await sleep(500);
        const tabs = [...(root?.querySelectorAll('button.sb-TabsTrigger') || [])];
        console.log(`[ARB-betsio] poll ${i + 1}: ${tabs.length} tab buttons`);
        if (!tabs.find(btn => btn.textContent.trim() === tabName)) continue;
        window.postMessage({ type: 'arb:betsio-click-tab', text: tabName }, '*');
        tabFound = true;
        break;
      }
      console.log(`[ARB-betsio] ${tabName} tab click: ${tabFound ? 'dispatched' : 'not found'}`);
      if (tabFound) {
        logger.log(`Switching to ${tabName} tab...`);
        await sleep(1000);
      }
    },

    findMarketSection: (root, label, market, betData) => {
      // Tennis full-match match-winner: title varies a little, so use the
      // candidate-list finder ("Match Winner" etc.). All other tennis markets
      // (1st-set winner "1 Set Winner", totals "Total Games"/"1 Set Total Games")
      // have an exact, stable title from getMarketLabel → exact-equality finder.
      // Exact equality matters: "Total Games" must NOT match "1 Set Total Games"
      // or "Player 1 Total Games".
      if (betData?.sport === 'tennis' && market.type === 'handicap_2way' && market.period !== '1st_set') {
        return findTennisWinnerTable(root);
      }
      return findMarketTable(root, label);
    },

    findOddsButton: (section, betData, leg, rowLabel) => {
      console.log(`[ARB-betsio] findOddsButton: sport=${sportSlug()} type=${betData.market.type} selection=${leg.selection} line=${leg.line}`);

      const outcomes = Array.from(section.querySelectorAll('.sb-MarketTable-outcome'));
      console.log(`[ARB-betsio] ${outcomes.length} outcome buttons found`);

      if (betData.market.type === 'over_under') {
        const prefix = leg.selection === 'Over' ? 'Over' : 'Under';
        return wrap(outcomes.find(o => {
          const t = o.textContent.trim();
          // "Over 212.51.89" — prefix + space + line must appear before odds
          return t.startsWith(prefix) && t.includes(`${prefix} ${leg.line}`);
        }));
      }

      if (betData.market.type === '1x2') {
        if (leg.selection === 'X') {
          return wrap(outcomes.find(o => o.textContent.includes('Draw')));
        }
        const team = leg.selection === '1' ? betData.event.team1 : betData.event.team2;
        const lw = lastWord(team).toLowerCase();
        return wrap(outcomes.find(o => o.textContent.toLowerCase().includes(lw)));
      }

      // Tennis match-winner: draw-less moneyline, outcome labelled by player name
      // (same as 1x2 minus the draw). leg.line is null so the handicap path below
      // (which matches a signed line) would never hit.
      if (betData.market.type === 'handicap_2way' && betData.sport === 'tennis') {
        const team = leg.selection === '1' ? betData.event.team1 : betData.event.team2;
        const lw = lastWord(team).toLowerCase();
        return wrap(outcomes.find(o => o.textContent.toLowerCase().includes(lw)));
      }

      // handicap_2way: button text is "{Team} ({sign}{line}){odds}"
      // Must match BOTH team name and signed line to pick the right row.
      const team = leg.selection === '1' ? betData.event.team1 : betData.event.team2;
      const lw = lastWord(team).toLowerCase();
      const lineStr = leg.line > 0 ? `(+${leg.line})` : `(${leg.line})`;
      console.log(`[ARB-betsio] HA: looking for "${lw}" + "${lineStr}"`);
      return wrap(outcomes.find(o => {
        const t = o.textContent.toLowerCase();
        return t.includes(lw) && t.includes(lineStr);
      }));
    },

    findStakeInput: (root) => root?.querySelector('.sb-StakeInput-input'),

    // FloatingTicket is a toggle that opens the full bet-slip drawer.
    // Only return it when the drawer is not already open (prevents double-toggle).
    openSlipPanel: (root) => {
      if (root?.querySelector('.sb-StakeInput-input')) return null;
      return root?.querySelector('.sb-FloatingTicket') || null;
    },

    findHighlightTarget: (root) => root?.querySelector('.sb-BetSlipSingleBet'),

    allowReclick: true,
    clearStakeFirst: true,
    searchSettleMs: 1500,

    placeBetLabel: 'Place Bet',
  });
})();
