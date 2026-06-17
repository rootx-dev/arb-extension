// Stake adapter for the shared runner (extension/lib/runner.js).
//
// Stake's sportsbook is Svelte-rendered, regular DOM (no Shadow DOM).
// The adapter has two specific things worth knowing:
//
//  1. SEARCH via GraphQL. Stake's search input is Svelte-bound and doesn't
//     reliably react to programmatic input events from a freshly-opened
//     content-script tab. Instead, the adapter calls Stake's own
//     `sportFixtureQuery` GraphQL endpoint — same one the page uses —
//     using the user's session cookies, and constructs the event URL
//     from the response.
//
//  2. LOCALE. /ja/sports/... = Japanese, /sports/... = English (no prefix).
//     The adapter reads the locale from the current URL and threads it
//     through URL construction + place-bet label.
//
// Selectors confirmed live (2026-05-13) against Aston Villa v Liverpool
// at /sports/soccer/england/premier-league/46527588-aston-villaocc-liverpool.

(() => {
  const { lastWord } = window.__arb;

  // ─── locale ──────────────────────────────────────────────────────────────
  // /ja/sports/... → '/ja';  /sports/... → ''
  const localePrefix = () => {
    const m = location.pathname.match(/^\/([a-z]{2})\/sports\//);
    return m ? `/${m[1]}` : '';
  };

  // Path depth measured from /sports/ onward, ignoring optional locale.
  // /sports/home → 1;  /ja/sports/home → 1;  event page → 4.
  const sportsDepth = (path) => {
    const parts = path.split('/').filter(Boolean);
    return parts[0] === 'sports' ? parts.length - 1
         : parts[1] === 'sports' ? parts.length - 2
         : -1;
  };

  // Market section title text. Uses startsWith matching because Stake appends
  // " TableAll" to accordion titles (e.g. "Total Games  TableAll").
  // Sport + period detected from URL path / market fields since titles differ.
  // Verified live 2026-06-17 on de Minaur v Shapovalov ATP London.
  function getMarketLabel(market) {
    if (market.type === '1x2') return '1x2';
    const p = location.pathname;
    if (market.type === 'over_under') {
      if (p.includes('/tennis/')) {
        // Full-match total games vs 1st-set total games.
        return market.period === '1st_set' ? '1st Set - Total Games' : 'Total Games';
      }
      if (p.includes('/basketball/')) return 'Total (Incl. Overtime)';
      if (p.includes('/ice-hockey/')) return 'Total (Incl. Overtime and Penalties)';
      if (p.includes('/soccer/'))     return 'Asian Total';
    }
    if (market.type === 'handicap_2way') {
      if (p.includes('/tennis/')) {
        // 1st-set winner vs full-match winner (draw-less moneyline).
        // Both verified live: "Winner" and "1st Set - Winner" are distinct prefixes
        // with no startsWith collision.
        return market.period === '1st_set' ? '1st Set - Winner' : 'Winner';
      }
      if (p.includes('/basketball/')) return 'Handicap (Incl. Overtime)';
      if (p.includes('/ice-hockey/')) return 'Handicap (Incl. Overtime and Penalties)';
      if (p.includes('/soccer/'))     return 'Asian Handicap';
    }
    return null;
  }

  // Tennis winner sections (full-match and 1st-set). The label returned by
  // getMarketLabel is already specific enough for the standard findMarketSection
  // startsWith lookup, but we keep a small candidate fallback in case Stake
  // renames the title between deploys. Log titles on complete miss.
  function findTennisWinnerSection(label) {
    // Try the known label first (exact startsWith).
    const accordions = Array.from(document.querySelectorAll('div.secondary-accordion'));
    const direct = accordions.find(a => a.children[0]?.textContent.trim().startsWith(label));
    if (direct) return direct;
    // Fallback candidate list (full-match winner only — 1st-set has a unique prefix).
    if (label === 'Winner') {
      const CANDIDATES = ['Winner', '1x2', 'Match Result', 'To Win Match', 'Moneyline'];
      for (const cand of CANDIDATES) {
        const hit = accordions.find(a => a.children[0]?.textContent.trim().startsWith(cand));
        if (hit) return hit;
      }
    }
    console.log('[ARB-stake] tennis winner section not found for label="' + label + '"; accordion titles:',
      accordions.map(a => a.children[0]?.textContent.trim()));
    return null;
  }

  // Place Bet button text by locale ('' = English / no prefix).
  const PLACE_BET_LABEL = { '': 'Place Bet', ja: 'ベットの登録' };

  // Bet slip panel toggle text by locale (for `openSlipPanel` fallback).
  const SLIP_TOGGLE_LABEL = { '': 'Bet Slip', ja: 'ベットスリップ' };

  // ─── GraphQL search ──────────────────────────────────────────────────────
  // Cached so the runner's repeated `findEventResult` polls don't refire it.
  const __search = { promise: null, resultEl: null };

  async function searchFixture(event) {
    const w1 = lastWord(event.team1).toLowerCase();
    const w2 = lastWord(event.team2).toLowerCase();
    const body = {
      query: `query StakeArbSearch($q: String!) {
        sportFixtureQuery(query: $q) {
          fixture { ... on SportFixture {
            slug name
            tournament { slug category { slug sport { slug } } }
          } }
        }
      }`,
      variables: { q: w2 },
    };
    const res = await fetch('/_api/graphql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error('GraphQL: ' + json.errors[0].message);
    // Pick the fixture whose slug or name contains BOTH team names — avoids
    // picking a generic "Manchester" match when searching for "Liverpool".
    const fixtures = (json.data?.sportFixtureQuery || [])
      .map((x) => x.fixture)
      .filter((f) => f && f.slug);
    return fixtures.find((f) => {
      const blob = (f.name + ' ' + f.slug).toLowerCase();
      return blob.includes(w1) && blob.includes(w2);
    }) || null;
  }

  function constructEventPath(fix) {
    const { sport } = fix.tournament.category;
    return `${localePrefix()}/sports/${sport.slug}/${fix.tournament.category.slug}/${fix.tournament.slug}/${fix.slug}`;
  }

  // ─── DOM helpers ─────────────────────────────────────────────────────────
  // startsWith because Stake appends " TableAll" / " SelectAll" to titles.
  const findMarketSection = (label) =>
    Array.from(document.querySelectorAll('div.secondary-accordion')).find(
      (a) => a.children[0]?.textContent.trim().startsWith(label),
    ) || null;

  // Stake's Svelte outcome handler sometimes ignores a plain `btn.click()`
  // dispatched from the content-script isolated world. Wrap the button so the
  // runner's `btn.click()` triggers a full mouse/pointer event sequence — what
  // a real user pointer fires. Also logs post-click state for diagnostics.
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
    // Success = the button latches `.selected` OR the slip mounts a stake input.
    // In a freshly-opened service-worker tab Svelte can hydrate slowly, so poll
    // for the signal over ~1.8 s and latch on first sight, rather than a single
    // check at a fixed delay (which fails if hydration lands late). Retry only if
    // NO success the whole window — guarded so we never toggle an already-placed
    // bet back off.
    const success = () =>
      btn.classList.contains('selected') ||
      !!document.querySelector('input[data-testid="input-bet-amount"]');
    btn.click = () => {
      // Give Svelte hydration a beat — the content script can race past it.
      setTimeout(() => {
        dispatch();
        let elapsed = 0, latched = false;
        const tick = setInterval(() => {
          if (success()) { latched = true; clearInterval(tick); return; }
          elapsed += 150;
          if (elapsed >= 1800) {
            clearInterval(tick);
            if (!latched) {
              console.log('[ARB-stake] click lost to hydration — retrying with second event burst');
              dispatch();
            }
          }
        }, 150);
      }, 1500);
    };
    return btn;
  }

  __arb.run({
    book: 'stake',
    stateKey: 'stakeState',

    isLandingPage: (path) => sportsDepth(path) >= 0 && sportsDepth(path) <= 1,
    isEventPage:   (path) => sportsDepth(path) >= 4,

    getRoot: () => document,

    // Hidden stub — the runner's `fillInput` writes to it harmlessly. The
    // real search is the GraphQL call in `findEventResult` below.
    findSearchInput: () => {
      let el = document.querySelector('input[data-arb-stake-stub]');
      if (!el) {
        el = document.createElement('input');
        el.setAttribute('data-arb-stake-stub', 'true');
        el.type = 'text';
        el.style.cssText = 'position:fixed;opacity:0;left:-9999px;pointer-events:none;';
        document.body.appendChild(el);
      }
      return el;
    },

    findEventResult: (_root, event) => {
      if (__search.resultEl) return __search.resultEl;
      if (!__search.promise) {
        console.log(`[ARB-stake] GraphQL search for "${event.team1}" vs "${event.team2}"`);
        __search.promise = searchFixture(event)
          .then((fix) => {
            if (!fix) {
              console.error('[ARB-stake] no fixture match in GraphQL results');
              return;
            }
            const path = constructEventPath(fix);
            console.log(`[ARB-stake] resolved → ${path}`);
            const a = document.createElement('a');
            a.href = path;
            a.style.display = 'none';
            document.body.appendChild(a);
            __search.resultEl = a;
          })
          .catch((e) => console.error('[ARB-stake] GraphQL error:', e));
      }
      return null;
    },

    navigateToEvent: async (link) => {
      window.location.assign(link.pathname);
    },

    // The runner sleeps this long between filling the (stub) input and the
    // first findEventResult poll. Just enough to let the GraphQL fetch fire.
    searchSettleMs: 100,

    marketLabel: (market) => getMarketLabel(market),
    findMarketSection: (_root, label, market) =>
      (market.type === 'handicap_2way' && location.pathname.includes('/tennis/'))
        ? findTennisWinnerSection(label)
        : findMarketSection(label),

    findOddsButton: (section, betData, leg) => {
      console.log(`[ARB-stake] findOddsButton: type=${betData.market.type} period=${betData.market.period} selection=${leg.selection} line=${leg.line}`);
      const buttons = section.querySelectorAll('button.outcome');

      // Tennis winner (full-match and 1st-set): 2 buttons (no draw), player1 then
      // player2. Pick by index. Works for both period=null and period='1st_set'
      // because getMarketLabel already routed them to their distinct accordions.
      if (betData.market.type === 'handicap_2way' && betData.sport === 'tennis') {
        const idx = { '1': 0, '2': 1 }[leg.selection];
        const btn = idx !== undefined ? buttons[idx] : null;
        return btn ? wrapWithFullClick(btn) : null;
      }

      if (betData.market.type === '1x2') {
        // Three buttons in fixed home/draw/away order regardless of locale.
        const idx = { '1': 0, 'X': 1, '2': 2 }[leg.selection];
        const btn = idx !== undefined ? buttons[idx] : null;
        if (!btn) return null;
        return wrapWithFullClick(btn);
      }

      if (betData.market.type === 'over_under') {
        // Buttons are interleaved pairs: Over N, Under N, Over N+1, Under N+1 …
        // aria-label = "Over 5.5" / "Under 5.5" — exact match on side + line.
        const target = `${leg.selection} ${leg.line}`;
        const btn = Array.from(buttons).find(b => b.getAttribute('aria-label') === target);
        if (!btn) {
          console.log(`[ARB-stake] OU pick failed — want aria-label="${target}" got:`,
            Array.from(buttons).map(b => b.getAttribute('aria-label')).join(', '));
          return null;
        }
        return wrapWithFullClick(btn);
      }

      if (betData.market.type === 'handicap_2way') {
        // aria-label = "{Team Name} ({line})" e.g. "Colorado Avalanche (-1.5)".
        // Hockey has the same line value for both teams (puck-line style), so
        // match on BOTH lastWord(teamName) AND (line) to disambiguate.
        const teamName = leg.selection === '1' ? betData.event.team1 : betData.event.team2;
        const w = lastWord(teamName).toLowerCase();
        const lineStr = `(${leg.line})`;
        const btn = Array.from(buttons).find(b => {
          const aria = (b.getAttribute('aria-label') || '').toLowerCase();
          return aria.includes(w) && aria.includes(lineStr.toLowerCase());
        });
        if (!btn) {
          console.log(`[ARB-stake] HC pick failed — team="${teamName}" line=${leg.line} got:`,
            Array.from(buttons).map(b => b.getAttribute('aria-label')).join(', '));
          return null;
        }
        return wrapWithFullClick(btn);
      }

      return null;
    },

    // Stake input has a stable data-testid that doesn't change with currency
    // or locale. Visibility filter rules out the version inside a collapsed
    // slip panel.
    findStakeInput: (root) =>
      Array.from(root.querySelectorAll('input[data-testid="input-bet-amount"]'))
        .find((i) => i.offsetParent !== null) || null,

    // If the slip is collapsed the input above won't be visible. The runner
    // clicks this toggle and re-polls.
    openSlipPanel: (root) => {
      const label = SLIP_TOGGLE_LABEL[localePrefix().slice(1)] || 'Bet Slip';
      return Array.from(root.querySelectorAll('button')).find(
        (b) => b.textContent.trim() === label,
      ) || null;
    },

    placeBetLabel: PLACE_BET_LABEL[localePrefix().slice(1)] || 'Place Bet',
  });
})();
