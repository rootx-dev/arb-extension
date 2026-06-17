// Shared runner for book content scripts.
//
// Each book provides a BookAdapter via __arb.run(adapter). The runner owns the
// two-phase state machine (search → fill), state persistence across navigation,
// logging/STATUS_UPDATE plumbing, the React-input write trick, the bet-slip
// open recovery sequence, and the completion toast.
//
// See extension/references/writing-book-scripts.md for the adapter contract
// and the rationale behind each shared behavior.

(() => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitFor(fn, { timeout = 10000, interval = 300 } = {}) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeout;
      const check = () => {
        let result;
        try { result = fn(); } catch { result = null; }
        if (result) { resolve(result); return; }
        if (Date.now() > deadline) { reject(new Error('Timeout')); return; }
        setTimeout(check, interval);
      };
      check();
    });
  }

  // A tennis-style initial to skip when finding the distinctive token. Matches a
  // single bare letter ("A") OR a short (1–3 letter) abbreviation ending in a dot
  // ("S.", "Pa.", "E.", "M."). The trailing dot is the abbreviation marker — a
  // genuinely short surname WITHOUT a dot ("Li", "Wu", "An") is NOT skipped, so
  // we never eat a real name. ("Tsitsipas Pa." → skip "Pa." → "Tsitsipas".)
  const isInitial = (t) => /^[A-Za-z]$/.test(t) || /^[A-Za-z]{1,3}\.$/.test(t);

  // Distinctive name token, used for the search query and event-result matching.
  // Team sports: last word ("Buffalo Sabres" → "Sabres"), surviving abbreviations
  // like "BUF Sabres". Tennis: signals write players as "Surname I." (e.g.
  // "Schnyder S.", "Voracek E. M."), so the literal last token is a useless
  // initial. Skip trailing initials so we land on the surname ("Schnyder S." →
  // "Schnyder", "Voracek E. M." → "Voracek"). Books render tennis players with
  // the surname last ("Sara Schnyder" → "Schnyder") or also abbreviated
  // ("Schnyder S." → "Schnyder"), so the surname matches either way.
  const lastWord = (name) => {
    const tokens = name.trim().split(/\s+/);
    let i = tokens.length - 1;
    while (i > 0 && isInitial(tokens[i])) i--;
    return tokens[i];
  };

  // Fold a team name to a canonical form so an ASCII signal name matches the
  // form a book renders, across three independent mismatches we've hit:
  //   1. Diacritics: signal "Ragsved"/"Enkoping" vs site "Rågsved"/"Enköpings".
  //      NFD decomposes the accent, the combining-mark strip drops it. (Books'
  //      search is diacritic-insensitive so typing "Ragsved" surfaces the event,
  //      but a raw substring match is NOT — "rågsved".includes("ragsved") fails.)
  //   2. Romanization of the same letter: the signal writes å→"a" but the book
  //      writes å→"aa" ("Ragsved" vs "Raagsveds"). Collapsing runs of a repeated
  //      letter reconciles them: "raagsveds" → "ragsveds" ⊇ "ragsved".
  // Spaces are preserved on purpose — callers tokenize with norm(name).split(/\s+/).
  // A few accents don't NFD-fold (ø ł ß) — rare; handle case-by-case if they bite.
  const norm = (s) => (s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/([a-z])\1+/g, '$1');

  // Generic club designators (Sportklubb, Football Club, …) that aren't
  // distinctive enough to SEARCH on: "Enkoping SK" → search "Enkoping", not the
  // ubiquitous "SK". Skipped from the end like initials; if every token is
  // generic, fall back to the last token.
  const GENERIC_CLUB_TOKENS = new Set([
    'sk', 'if', 'ik', 'bk', 'fk', 'ff', 'fc', 'sc', 'ac', 'cf', 'sv', 'afc',
    'aif', 'gif', 'ifk', 'aik', 'us', 'ss', 'cd', 'ud', 'sd', 'cp', 'rc', 'as',
    'ca', 'tsv', 'vfb', 'vfl', 'united', 'city', 'fk', 'club',
  ]);
  const searchTerm = (name) => {
    const tokens = name.trim().split(/\s+/);
    const skip = (t) => isInitial(t) ||
      GENERIC_CLUB_TOKENS.has(t.toLowerCase().replace(/\./g, ''));
    let i = tokens.length - 1;
    while (i > 0 && skip(tokens[i])) i--;
    return tokens[i];
  };

  // Row label to look for given a leg's selection. Shared across books.
  function rowLabelFor(betData, leg) {
    if (betData.market.type === 'over_under') return leg.selection; // "Over" / "Under"
    if (leg.selection === '1') return betData.event.team1;
    if (leg.selection === '2') return betData.event.team2;
    if (leg.selection === 'X') return 'Draw';
    return null;
  }

  // Write to a React-controlled input by calling the native value setter and
  // dispatching a bubbling 'input' event so React's onChange fires.
  // clearFirst: two-pass clear-then-fill, needed when the slip may already hold
  // a stake value (a single setter call appends to React state: "848" + "333" → "848333").
  function fillInput(input, value, { clearFirst = false } = {}) {
    input.focus();
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    if (clearFirst) {
      setter.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    setter.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function makeLogger(book) {
    const send = (status, message) =>
      chrome.runtime.sendMessage({ type: 'STATUS_UPDATE', book, status, message }).catch(() => {});
    return {
      log:   (msg) => { console.log(`[ARB] ${msg}`);   send('running', msg); },
      done:  (msg) => { console.log(`[ARB] ${msg}`);   send('done',    msg); },
      error: (msg) => { console.error(`[ARB] ${msg}`); send('error',   msg); },
    };
  }

  // Green toast + optional outline on the slip item.
  function highlightBetSlip({ outlineTarget, placeBetLabel }) {
    if (outlineTarget) {
      outlineTarget.style.outline = '3px solid #00ff88';
      outlineTarget.style.boxShadow = '0 0 20px rgba(0,255,136,0.35)';
    }

    const toast = document.createElement('div');
    toast.style.cssText = [
      'position:fixed', 'top:16px', 'left:50%', 'transform:translateX(-50%)',
      'background:#00ff88', 'color:#000', 'padding:10px 16px',
      'border-radius:8px', 'z-index:999999', 'font-weight:bold',
      'font-size:14px', 'font-family:sans-serif',
      'box-shadow:0 4px 16px rgba(0,0,0,0.4)', 'white-space:nowrap',
      'display:flex', 'align-items:center', 'gap:12px',
    ].join(';');

    const msg = document.createElement('span');
    msg.textContent = `✓ Arb準備完了 — オッズを確認して「${placeBetLabel}」をクリック`;
    toast.appendChild(msg);

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText = [
      'background:none', 'border:none', 'cursor:pointer',
      'font-size:14px', 'font-weight:bold', 'color:#000',
      'padding:0', 'line-height:1', 'opacity:0.6',
    ].join(';');
    closeBtn.addEventListener('click', () => toast.remove());
    toast.appendChild(closeBtn);

    document.body.appendChild(toast);
  }

  // Poll for the stake input. Re-queries the root every tick because the
  // shadow host (Roobet) can be re-mounted between phases.
  async function pollForStake(adapter, ticks, intervalMs) {
    for (let i = 0; i < ticks; i++) {
      await sleep(intervalMs);
      const root = adapter.getRoot();
      if (!root) continue;
      const input = adapter.findStakeInput(root);
      if (input) return input;
    }
    return null;
  }

  async function doSearch(adapter, betData, logger) {
    logger.log('Waiting for root...');
    const root = await waitFor(() => adapter.getRoot(), { timeout: 15000 });

    logger.log('Waiting for search input...');
    await waitFor(() => adapter.findSearchInput(adapter.getRoot() || root, betData));

    // Search-term candidates: team1 (home) first, team2 as fallback. Home team is
    // the more reliable index key on most books, and — critically — the FIRST term
    // gets the reliable "type into an empty box" path, while the fallback may hit a
    // book's in-place re-search quirks (1xbet's Vue-reactive search box ignores a
    // programmatic value REPLACEMENT, so only the first/from-empty search reliably
    // fires there). A real case: signal "Balcatta vs Perth Azzurri" — searching
    // "Azzurri" surfaced a different team ("Azzurri United"); "Balcatta" finds it.
    // findEventResult still requires BOTH team names in the matched card, so a
    // broader term only widens what surfaces — it cannot produce a false match.
    const terms = [...new Set(
      [betData.event.team1, betData.event.team2].map(searchTerm).filter(Boolean)
    )];
    logger.log(`Search-term candidates: ${JSON.stringify(terms)} (from team1="${betData.event.team1}" team2="${betData.event.team2}")`);

    let result = null;
    for (let i = 0; i < terms.length; i++) {
      const term = terms[i];
      const isLast = i === terms.length - 1;
      // Re-query the input each attempt — the search box can re-mount between tries.
      const searchInput = adapter.findSearchInput(adapter.getRoot() || root, betData);
      logger.log(`Searching for: ${term}`);
      if (adapter.fillSearchInput) {
        await adapter.fillSearchInput(searchInput, term, { sleep, waitFor });
      } else {
        // clearFirst on retries so the previous term doesn't get appended.
        fillInput(searchInput, term, { clearFirst: i > 0 });
      }

      if (adapter.searchSettleMs) await sleep(adapter.searchSettleMs);

      logger.log('Waiting for matching search result...');
      try {
        result = await waitFor(() => {
          const r = adapter.getRoot();
          return r ? adapter.findEventResult(r, betData.event, betData) : null;
        }, { timeout: isLast ? 12000 : 6000 });
        break;
      } catch (e) {
        if (isLast) throw e;
        logger.log(`No result for "${term}" — retrying with next term`);
      }
    }

    await chrome.storage.local.set({ [adapter.stateKey]: { phase: 'fill', betData } });
    await adapter.navigateToEvent(result, betData.event, { sleep, waitFor, lastWord, logger });
  }

  async function doFill(adapter, betData, logger) {
    const leg = betData.legs[0];
    const rowLabel = rowLabelFor(betData, leg);
    if (!rowLabel) throw new Error(`Cannot derive row label for selection: ${leg.selection}`);

    const marketLabel = adapter.marketLabel(betData.market, betData);
    if (!marketLabel) throw new Error(`Unsupported market type: ${betData.market.type}`);

    logger.log('Waiting for root...');
    const root = await waitFor(() => adapter.getRoot(), { timeout: 15000 });

    if (adapter.beforeFindMarket) {
      await adapter.beforeFindMarket(root, { sleep, waitFor, logger });
    }

    logger.log(`Waiting for market section: "${marketLabel}"...`);
    const section = await waitFor(() => {
      const r = adapter.getRoot();
      return r ? adapter.findMarketSection(r, marketLabel, betData.market, betData) : null;
    }, { timeout: 15000 });

    logger.log(`Finding odds button for ${rowLabel}...`);
    const btn = await waitFor(
      () => adapter.findOddsButton(section, betData, leg, rowLabel),
      { timeout: 8000 },
    );

    btn.scrollIntoView({ block: 'center' });
    logger.log(`Clicking ${rowLabel} @ ${btn.textContent.trim()}`);
    // Click ONCE — odds buttons are toggles; a second click removes the bet.
    btn.click();

    // Phase A: long poll for stake input (~10s) to absorb background-tab throttling.
    logger.log('Waiting for bet slip...');
    let stakeInput = await pollForStake(adapter, 20, 500);

    // Phase B: slip may be collapsed — try the slip-toggle a few times.
    if (!stakeInput && adapter.openSlipPanel) {
      for (let attempt = 0; attempt < 3 && !stakeInput; attempt++) {
        const toggle = adapter.openSlipPanel(adapter.getRoot());
        if (!toggle) break;
        logger.log(`Opening bet slip panel (attempt ${attempt + 1}/3)...`);
        toggle.click();
        stakeInput = await pollForStake(adapter, 6, 500);
      }
    }

    // Phase C: verified-empty slip → odds click never registered. Re-click once.
    if (!stakeInput && adapter.allowReclick) {
      logger.log('Slip open but empty — re-clicking odds button...');
      btn.scrollIntoView({ block: 'center' });
      btn.click();
      stakeInput = await pollForStake(adapter, 6, 500);
    }

    if (!stakeInput) throw new Error('Bet slip did not open');
    logger.log('Bet slip open');

    if (adapter.currencySettleMs) {
      logger.log('Waiting for currency to settle...');
      await sleep(adapter.currencySettleMs);
      stakeInput = adapter.findStakeInput(adapter.getRoot()) || stakeInput;
    }

    // Currency safety guard. The stake number has already been converted by the
    // popup into the book's configured currency (leg.currency = "JPY"|"USD").
    // If we type a JPY number into a USD field (or vice-versa) we over/under-bet
    // by ~150x. If the adapter can read the on-page currency, verify it matches
    // before filling; otherwise warn that the guard is unenforced for this book.
    const expectedCurrency = leg.currency || 'JPY';
    if (adapter.detectCurrency) {
      let pageCurrency = null;
      try { pageCurrency = adapter.detectCurrency(adapter.getRoot()); } catch { pageCurrency = null; }
      if (pageCurrency && String(pageCurrency).toUpperCase() !== expectedCurrency.toUpperCase()) {
        throw new Error(
          `Currency mismatch: expected ${expectedCurrency} but page shows ${pageCurrency} — fix the book's currency setting`,
        );
      }
      if (!pageCurrency) {
        console.warn(`[ARB-${adapter.book}] detectCurrency returned no value — currency guard unenforced`);
      } else {
        console.log(`[ARB-${adapter.book}] currency guard ok: page=${pageCurrency} expected=${expectedCurrency}`);
      }
    } else {
      console.warn(`[ARB-${adapter.book}] no detectCurrency — currency guard unenforced (expected ${expectedCurrency})`);
    }

    // leg.stake is already in the book's currency; round JPY to whole, leave
    // USD as the converted value (the popup rounded it to 2 decimals).
    const stakeValue = expectedCurrency === 'JPY' ? Math.round(leg.stake) : leg.stake;
    logger.log(`Filling stake: ${stakeValue} ${expectedCurrency}`);
    fillInput(stakeInput, stakeValue, { clearFirst: adapter.clearStakeFirst ?? false });

    await sleep(300);
    await chrome.storage.local.set({ [adapter.stateKey]: null });

    const placeBetLabel = adapter.placeBetLabel || 'Place Bet';
    logger.done(adapter.doneMessage || `ベットスリップ完成 — 確認して「${placeBetLabel}」をクリック`);
    highlightBetSlip({
      outlineTarget: adapter.findHighlightTarget?.(adapter.getRoot()) ?? null,
      placeBetLabel,
    });
  }

  async function run(adapter) {
    const logger = makeLogger(adapter.book);
    try {
      const state = (await chrome.storage.local.get([adapter.stateKey]))[adapter.stateKey];
      console.log(`[ARB-${adapter.book}] run: phase=${state?.phase ?? 'none'} path=${location.pathname} isLanding=${adapter.isLandingPage?.(location.pathname)} isEvent=${adapter.isEventPage?.(location.pathname)}`);
      if (!state) return;

      const { phase, betData } = state;
      const path = window.location.pathname;

      if (phase === 'search' && adapter.isLandingPage(path)) {
        await doSearch(adapter, betData, logger);
      } else if (phase === 'fill' && adapter.isEventPage(path)) {
        await doFill(adapter, betData, logger);
      }
    } catch (err) {
      logger.error(`Error: ${err.message}`);
      await chrome.storage.local.set({ [adapter.stateKey]: null });
    }
  }

  // Expose helpers so adapters can use them (especially in navigateToEvent /
  // findOddsButton helper functions that don't receive ctx).
  window.__arb = { run, sleep, waitFor, fillInput, lastWord, rowLabelFor, norm };
})();
