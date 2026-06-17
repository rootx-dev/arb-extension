// Shuffle adapter for the shared runner (extension/lib/runner.js).
//
// Shuffle is a Next.js + React sportsbook with regular DOM (no Shadow DOM).
// Two things worth knowing:
//
//   1. SEARCH input is hidden behind a toggle button until first click.
//      findSearchInput clicks the toggle if the input isn't mounted yet, then
//      returns null so the runner's waitFor polls again — by the next poll
//      the input is mounted.
//
//   2. OUTCOME buttons share a stable class prefix
//      (SportsBetSelectionButton_root), but `data-testid="bet-select"` is set
//      on only the FIRST button per market. Use the class, not the testid.
//
// Handicap / total layouts: buttons stack in a single column, first half =
// team1 / Over, second half = team2 / Under. Same line can appear in both
// halves with mirrored sign, so always split by selection before matching.

(() => {
  // ─── helpers ─────────────────────────────────────────────────────────────

  // Shared name-token helper: strips trailing initials so tennis "Griekspoor T."
  // → "Griekspoor" (a bare ".pop()" returns the useless "T." and search-result
  // matching fails). See lib/runner.js.
  const { norm } = window.__arb;

  // /sports/{sport}/... → 'ice-hockey' → 'ice_hockey' (matches Sport enum).
  const sportFromPath = () => {
    const m = location.pathname.match(/^\/sports\/([^/]+)/);
    return m ? m[1].replace(/-/g, '_') : null;
  };

  // Exact market section title per (market.type, period, sport).
  function getMarketTitle(market) {
    const sport = sportFromPath();
    if (market.type === '1x2') return '1x2';
    if (sport === 'tennis') {
      // Tennis section titles verified live 2026-06-17 (English locale, Bergs v
      // Fritz, ATP Halle). The cards live on DIFFERENT tabs per period — see the
      // tennis tab routing in navigateToEvent. Section found via findTennisSection
      // (structural walk + JP-locale aliases).
      if (market.type === 'handicap_2way') return market.period === '1st_set' ? '1st set - winner' : 'Winner';
      if (market.type === 'over_under')    return market.period === '1st_set' ? '1st set - total games' : 'Total games';
    }
    if (market.type === 'handicap_2way') {
      if (market.period === 'ot_incl') {
        if (sport === 'basketball') return 'Handicap (incl. overtime)';
        if (sport === 'ice_hockey') return 'Handicap (incl. overtime and penalties)';
      }
      if (sport === 'soccer') return 'Handicap';
    }
    if (market.type === 'over_under') {
      if (sport === 'soccer') return 'Total';
      if (market.period === 'ot_incl' && sport === 'basketball') return 'Total (incl. overtime)';
      if (market.period === 'ot_incl' && sport === 'ice_hockey') return 'Total (incl. overtime and penalties)';
    }
    return null;
  }

  // `market.type` → ?tab= query param so the right markets are rendered server-side.
  const TAB_FOR_MARKET = {
    '1x2':           'WIN_MARKETS',
    handicap_2way:   'HANDICAP_MARKETS',
    over_under:      'TOTAL_MARKETS',
  };

  // "+1.5" / "-1.5" — handicap button text starts with this prefix.
  const formatHandicap = (line) => (line >= 0 ? '+' : '') + line;

  const SEL_BTN = 'button[class*="SportsBetSelectionButton_root"]';

  // Find the market section whose title text exactly equals `label`.
  // Two container layouts coexist on Shuffle: handicap/total markets sit in a
  // `subCollapseRoot` wrapper, but 1x2 (and tennis) sit in a different one with
  // no such class. So: match the title, then try the subCollapseRoot walk first
  // (precise for markets that use it), and if that fails, fall back to the
  // structural walk findTennisSection uses — climb to the nearest ancestor that
  // actually holds the selection buttons.
  function findSectionByTitle(label) {
    for (const titleEl of document.querySelectorAll('span[class*="MarketCollapseHeader_title"]')) {
      if (titleEl.textContent.trim() !== label) continue;
      let n = titleEl;
      while (n && !(typeof n.className === 'string' && n.className.includes('subCollapseRoot'))) {
        n = n.parentElement;
      }
      if (n) return n;
      // No subCollapseRoot ancestor (e.g. 1x2): structural fallback.
      n = titleEl;
      for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
        if (n.querySelectorAll(SEL_BTN).length >= 2) return n;
      }
    }
    // On miss, log the titles actually present so a wrong assumption is a
    // one-line fix, not a silent market-section timeout.
    console.log(`[ARB-shuffle] section "${label}" not found; titles present:`,
      Array.from(document.querySelectorAll('span[class*="MarketCollapseHeader_title"]')).map(e => e.textContent.trim()));
    return null;
  }

  // Tennis market cards sit in a DIFFERENT container than the soccer/hockey
  // markets (StackedCollapseGroup_item / Collapse_collapseRoot, NOT
  // subCollapseRoot), so walk up STRUCTURALLY to the nearest ancestor holding
  // the selection buttons rather than matching a fixed wrapper class.
  // Titles are locale-translated and the session locale is cookie-forced (see
  // ggbet "Locale forced by session cookie"): the canonical EN titles are
  // verified live (2026-06-17); the JP aliases cover a JP-locked session
  // (match-winner "勝者" verified 2026-06-16; the rest are best-effort — the
  // on-miss diagnostic logs the real titles for a one-line fix).
  const TENNIS_TITLE_ALIASES = {
    'Winner':                 ['Winner', '勝者'],
    '1st set - winner':       ['1st set - winner', '第1stセット - 勝者'],
    'Total games':            ['Total games', 'ゲーム総数'],
    '1st set - total games':  ['1st set - total games', '第1stセット - ゲーム総数'],
  };
  function findTennisSection(title) {
    const wanted = TENNIS_TITLE_ALIASES[title] || [title];
    const BTN = 'button[class*="SportsBetSelectionButton_root"]';
    for (const titleEl of document.querySelectorAll('span[class*="MarketCollapseHeader_title"]')) {
      if (!wanted.includes(titleEl.textContent.trim())) continue;
      let n = titleEl;
      for (let i = 0; i < 8 && n; i++, n = n.parentElement) {
        if (n.querySelectorAll(BTN).length >= 2) return n;
      }
    }
    console.log(`[ARB-shuffle] tennis section "${title}" not found; titles:`,
      Array.from(document.querySelectorAll('span[class*="MarketCollapseHeader_title"]')).map(e => e.textContent.trim()));
    return null;
  }

  // Next.js hydrates the page asynchronously after document_idle, so a plain
  // btn.click() that lands before React attaches the onClick handler is
  // silently dropped (intermittent — depends on network/CPU). Wrap the chosen
  // button so the runner's btn.click() delays for hydration, fires a full
  // pointer/mouse sequence, then polls for a success signal over ~1.5 s and
  // latches as soon as it's seen. A retry only fires if no signal is seen the
  // whole window — important because the runner's fillInput briefly remounts
  // the slip's stake input, and a one-shot self-check at T+1200 could catch
  // that flicker and falsely retry, toggling the (already-selected) bet OFF.
  function wrapWithHydrationRetry(btn) {
    // Persistent slip signal — survives the stake-input remount that fires
    // during runner's fillInput. Match either the slip section or any
    // betslip-* descendant in case Shuffle renames classes.
    const slipPresent = () =>
      !!document.querySelector('section[class*="BetSlipAddingView_root"]') ||
      !!document.querySelector('[class*="BetSlipDropdown_dropdown"] section') ||
      !!document.querySelector('input[placeholder="Enter stake"]');
    const isSelected = () => /SportsBetSelectionButton_selected/.test(btn.className || '');
    const success = () => isSelected() || slipPresent();

    const dispatch = () => {
      btn.scrollIntoView({ block: 'center' });
      const opts = { bubbles: true, cancelable: true, button: 0, view: window };
      btn.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }));
      btn.dispatchEvent(new MouseEvent('mousedown', opts));
      btn.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }));
      btn.dispatchEvent(new MouseEvent('mouseup', opts));
      btn.dispatchEvent(new MouseEvent('click', opts));
    };

    btn.click = () => {
      setTimeout(() => {
        dispatch();
        // Poll every 150ms for up to 1500ms; latch on first positive signal.
        let elapsed = 0;
        let latched = false;
        const tick = setInterval(() => {
          if (success()) { latched = true; clearInterval(tick); return; }
          elapsed += 150;
          if (elapsed >= 1500) {
            clearInterval(tick);
            if (!latched) {
              console.log('[ARB-shuffle] click lost to hydration race — retrying');
              dispatch();
            }
          }
        }, 150);
      }, 1200);
    };
    return btn;
  }

  // ─── adapter ─────────────────────────────────────────────────────────────

  __arb.run({
    book: 'shuffle',
    stateKey: 'shuffleState',

    isLandingPage: (path) => /^\/sports\/?$/.test(path),
    isEventPage:   (path) => /^\/sports\/[^/]+\/[^/]+\/[^/]+\/\d+-/.test(path),

    getRoot: () => document,

    // Click the hidden-search toggle on first poll; return null so the runner
    // polls again once the input is mounted.
    findSearchInput: (root) => {
      const input = root.querySelector('input[class*="Searchinput_input"]');
      if (input) return input;
      const toggle = root.querySelector('button[class*="SearchComponent_searchButton"]');
      if (toggle) toggle.click();
      return null;
    },

    // In a freshly-opened service-worker tab, React may not have attached the
    // search input's onChange handler when the runner types, so the value sets
    // but NO query fires → no result tiles → the runner's findEventResult times
    // out at the search screen even though the match exists (the reported bug).
    // Re-type (clear→set forces a fresh onChange each pass) until result tiles
    // actually render, re-querying the input in case hydration remounts it.
    fillSearchInput: async (input, term, { sleep }) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      for (let attempt = 0; attempt < 6; attempt++) {
        const el = document.querySelector('input[class*="Searchinput_input"]') || input;
        el.focus();
        setter.call(el, '');
        el.dispatchEvent(new Event('input', { bubbles: true }));
        setter.call(el, term);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: term.slice(-1) }));
        await sleep(1200);
        if (document.querySelector('a[class*="SearchResultGameTile_root"]')) {
          console.log(`[ARB-shuffle] search results rendered after ${attempt + 1} type attempt(s)`);
          return;
        }
      }
      console.log('[ARB-shuffle] search results never rendered after 6 type attempts');
    },

    searchSettleMs: 1500,

    findEventResult: (root, event) => {
      // norm() (lib/runner.js) folds diacritics AND collapses repeated letters,
      // so the signal's romanization matches the book's: "Ragsved" vs site
      // "Raagsveds" (å→a vs å→aa), "Enkoping" vs "Enköpings". Match each team on
      // its first OR last significant word (≥3 chars) so a generic suffix like
      // "SK" isn't required and a distinctive token ("Enkoping") suffices. Both
      // teams required → a different Enkoping fixture won't false-match.
      const tokensFor = (name) => {
        let ws = norm(name).split(/\s+/).filter(Boolean);
        const sig = ws.filter((w) => w.length >= 3);
        if (sig.length) ws = sig;
        return [...new Set([ws[0], ws[ws.length - 1]].filter(Boolean))];
      };
      const t1 = tokensFor(event.team1);
      const t2 = tokensFor(event.team2);
      for (const a of root.querySelectorAll('a[class*="SearchResultGameTile_root"]')) {
        const t = norm(a.textContent);
        if (t1.some((x) => t.includes(x)) && t2.some((x) => t.includes(x))) return a;
      }
      return null;
    },

    // Force the right ?tab= so the wanted market is rendered on first paint.
    // Otherwise the TOP_MARKETS teaser may show only a subset of lines.
    navigateToEvent: async (link, _event, { betData } = {}) => {
      let url = link.href;
      // betData isn't passed through the runner's adapter contract — read it
      // from chrome.storage instead so we can pick the tab.
      const { shuffleState } = await chrome.storage.local.get('shuffleState');
      const market = shuffleState?.betData?.market;
      const marketType = market?.type;
      const sport = shuffleState?.betData?.sport;
      // Tennis cards live on different tabs per (type, period), verified live
      // 2026-06-17: full winner → WIN_MARKETS; 1st-set winner → SET_MARKETS;
      // game totals (full + 1st-set) → GAMES_MARKETS.
      let tab;
      if (sport === 'tennis') {
        if (marketType === 'handicap_2way') tab = market.period === '1st_set' ? 'SET_MARKETS' : 'WIN_MARKETS';
        else if (marketType === 'over_under') tab = 'GAMES_MARKETS';
      } else {
        tab = TAB_FOR_MARKET[marketType];
      }
      if (tab) {
        const u = new URL(url);
        u.searchParams.set('tab', tab);
        url = u.toString();
      }
      console.log(`[ARB-shuffle] navigating to: ${url}`);
      window.location.href = url;
    },

    marketLabel: (market) => getMarketTitle(market),
    findMarketSection: (_root, label, market) =>
      (sportFromPath() === 'tennis')
        ? findTennisSection(label)   // label = getMarketTitle(market), period-aware
        : findSectionByTitle(label),

    findOddsButton: (section, betData, leg) => {
      const buttons = Array.from(
        section.querySelectorAll('button[class*="SportsBetSelectionButton_root"]'),
      );
      if (buttons.length === 0) return null;

      // One-line entry diagnostic — confirms the leg shape the runner is
      // calling us with (catches things like an upstream calculator dropping
      // leg.line so we can see immediately rather than time out).
      console.log(`[ARB-shuffle] findOddsButton: type=${betData.market.type} selection=${leg.selection} line=${leg.line} btns=${buttons.length}`);

      let picked = null;

      if (betData.market.type === 'handicap_2way' && betData.sport === 'tennis') {
        // Tennis match-winner: 2 buttons (no draw), player1 then player2.
        const idx = { '1': 0, '2': 1 }[leg.selection];
        picked = idx !== undefined ? buttons[idx] : null;
      } else if (betData.market.type === '1x2') {
        const idx = { '1': 0, 'X': 1, '2': 2 }[leg.selection];
        picked = idx !== undefined ? buttons[idx] : null;
      } else if (betData.market.type === 'handicap_2way') {
        // First half = team1, second half = team2 (verified hockey/basketball).
        const half = Math.floor(buttons.length / 2);
        const slice = leg.selection === '1'
          ? buttons.slice(0, half)
          : buttons.slice(half);
        const prefix = formatHandicap(leg.line);
        picked = slice.find((b) => b.textContent.trim().startsWith(prefix)) || null;
      } else if (betData.market.type === 'over_under') {
        // First half = Over, second half = Under. Button text has no sign.
        const half = Math.floor(buttons.length / 2);
        const slice = leg.selection === 'Over'
          ? buttons.slice(0, half)
          : buttons.slice(half);
        const prefix = String(leg.line);
        picked = slice.find((b) => b.textContent.trim().startsWith(prefix)) || null;
        if (!picked) {
          console.log(`[ARB-shuffle] OU pick failed — selection=${leg.selection} line=${leg.line} prefix=${prefix}`);
          console.log(`[ARB-shuffle] all ${buttons.length} btns:`, buttons.map(b => b.textContent.trim()).join(' | '));
          console.log(`[ARB-shuffle] slice (${slice.length}):`, slice.map(b => b.textContent.trim()).join(' | '));
        }
      }

      return picked ? wrapWithHydrationRetry(picked) : null;
    },

    findStakeInput: (root) =>
      Array.from(root.querySelectorAll('input[placeholder="Enter stake"]'))
        .find((i) => i.offsetParent !== null) || null,

    // React-controlled — slip can retain previous stake; clear-then-fill.
    clearStakeFirst: true,

    // Final fallback if hydration retry above still leaves the slip empty.
    allowReclick: true,

    placeBetLabel: 'Place Bet',
  });
})();
