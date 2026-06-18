const DEFAULT_SERVER = 'http://localhost:8888';
const DEFAULT_TOTAL_STAKE = 10000; // JPY

// The 9 books we support. Keys must match service-worker BOOK_URLS and
// BOOK_CAPABILITIES below. Used to build the per-book currency settings UI.
const BOOKS = ['cloudbet', 'roobet', 'stake', 'shuffle', 'betsio', 'betfury', 'ggbet', '1xbet', '22bet'];

// Every book defaults to JPY (the stake-math base currency). The currency
// setting only changes what number gets TYPED into that book's bet slip.
function defaultBookCurrencies() {
  return Object.fromEntries(BOOKS.map((b) => [b, 'JPY']));
}

// Read settings from chrome.storage.sync; fall back to local-dev defaults.
async function getConfig() {
  const { serverUrl, bearerToken, totalStake, bookCurrencies } =
    await chrome.storage.sync.get(['serverUrl', 'bearerToken', 'totalStake', 'bookCurrencies']);
  return {
    serverUrl:      (serverUrl   || DEFAULT_SERVER).replace(/\/+$/, ''),
    bearerToken:    bearerToken || '',
    totalStake:     Number(totalStake) > 0 ? Number(totalStake) : DEFAULT_TOTAL_STAKE,
    bookCurrencies: { ...defaultBookCurrencies(), ...(bookCurrencies || {}) },
  };
}

function authHeaders(token) {
  return token ? { 'Authorization': `Bearer ${token}` } : {};
}

// Per-book capability matrix: (book → sport → market_type → allowed periods).
// See backend/schema.py for the full set of period values (halves, quarters,
// hockey periods, sets, ot_incl, regular_time). null means full match.
// The cloudbet + roobet scripts both target the "Incl. OT" column, so only
// period 'ot_incl' is verified to work. Expand this matrix as new combos are
// tested end-to-end.
const BOOK_CAPABILITIES = {
  // soccer handicap_2way: adapter uses "Asian Handicap" section (?tab=asianLines)
  cloudbet: {
    basketball: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    ice_hockey: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    soccer:     { '1x2': [null], over_under: [null], handicap_2way: [null] },
    // tennis (?markets-tab=all): match-winner "Winner" (full) + "Winner of set 1"
    // (1st_set); totals "Total Games" (full) + "Total games in set 1" (1st_set).
    // All four verified live 2026-06-17.
    tennis:     { handicap_2way: [null, '1st_set'], over_under: [null, '1st_set'] },
  },
  // soccer handicap_2way: adapter uses "Winner" section
  roobet: {
    basketball: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    ice_hockey: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    soccer:     { '1x2': [null], over_under: [null], handicap_2way: [null] },
    // tennis: winner "Winner"/"First set - winner" + totals "Total games"/"First
    // set - total games". All four verified live 2026-06-17 (Atmane v Medvedev).
    tennis:     { handicap_2way: [null, '1st_set'], over_under: [null, '1st_set'] },
  },
  // stake: soccer handicap → "Asian Handicap" section
  stake: {
    soccer:     { '1x2': [null], over_under: [null], handicap_2way: [null] },
    basketball: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    ice_hockey: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    // tennis: winner "Winner"/"1st Set - Winner"; totals "Total Games"/"1st Set -
    // Total Games" (distinct startsWith prefixes). All four verified live 2026-06-17
    // (de Minaur v Shapovalov, ATP London).
    tennis:     { handicap_2way: [null, '1st_set'], over_under: [null, '1st_set'] },
  },
  // shuffle: soccer handicap → "Handicap" section; soccer 1x2 → "1x2" section
  // (verified live 2026-06-18, Raagsveds IF v Enkopings SK, Svenska Cupen).
  shuffle: {
    basketball: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    ice_hockey: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    soccer:     { '1x2': [null], over_under: [null], handicap_2way: [null] },
    // tennis: winner "Winner"(WIN_MARKETS)/"1st set - winner"(SET_MARKETS); totals
    // "Total games"/"1st set - total games" (both GAMES_MARKETS). Tabs differ per
    // period. All four verified live 2026-06-17 (Bergs v Fritz, ATP Halle).
    tennis:     { handicap_2way: [null, '1st_set'], over_under: [null, '1st_set'] },
  },
  // soccer handicap_2way: adapter uses "Goals Handicap" section
  betsio: {
    basketball: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    ice_hockey: { handicap_2way: ['ot_incl'] },
    soccer:     { '1x2': [null], over_under: [null], handicap_2way: [null] },
    // tennis: winner "Match Winner"/"1 Set Winner" + totals "Total Games"/"1 Set
    // Total Games" (exact-title match avoids "Player N Total Games" collision).
    // All four verified live 2026-06-17 (Bergs v Fritz, ATP Halle).
    tennis:     { handicap_2way: [null, '1st_set'], over_under: [null, '1st_set'] },
  },
  // soccer handicap_2way: adapter uses "Handicap" section (not Asian)
  betfury: {
    soccer:     { '1x2': [null], over_under: [null], handicap_2way: [null] },
    basketball: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    ice_hockey: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    // tennis: winner "Winner"/"First set - winner" + totals "Total games"/"First
    // set - total games". All four verified live 2026-06-17 (Atmane v Medvedev).
    tennis:     { handicap_2way: [null, '1st_set'], over_under: [null, '1st_set'] },
  },
  // soccer handicap_2way: adapter uses "Handicap" section
  // tennis handicap_2way (line null): match-winner, adapter uses "勝者" (Winner) section
  ggbet: {
    basketball: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    ice_hockey: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    soccer:     { '1x2': [null], over_under: [null], handicap_2way: [null] },
    // tennis: match-winner "勝者"/"第1stセット - 勝者" + totals "ゲーム総数"/"第1stセット -
    // ゲーム総数". All four verified live 2026-06-17 (Tiafoe vs Shimabukuro, ATP Halle).
    tennis:     { handicap_2way: [null, '1st_set'], over_under: [null, '1st_set'] },
  },
  '1xbet': {
    // ice_hockey: verified 2026-05-14 (Buffalo Sabres vs Montreal Canadiens, NHL)
    // soccer: group names verified 2026-05-15 (Chelsea vs Tottenham, Premier League)
    // basketball: group names consistent with other sports ("Total","Handicap") — unverified e2e
    // tennis: match-winner "1X2" group; totals "Total" (full) / "Total 1" (1st-set,
    //   reversed "10.5 Over" name format). Verified 2026-06-16/17 (Rublev, Bergs).
    //   1st-set WINNER is absent on 1xbet (no standalone group) → not listed.
    // soccer over_under '1st_half'/'2nd_half': each half is a separate sub-game
    //   (own permanentId URL). The adapter (beforeFindMarket) navigates to it,
    //   then matches the "Total" group requiring gameName==="1st half"/"2nd half".
    //   Implemented 2026-06-17; pending live e2e confirmation. See 1xbet.js +
    //   1xbet-dom-notes.md "1st-half / period markets".
    ice_hockey: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    soccer:     { '1x2': [null], over_under: [null, '1st_half', '2nd_half'], handicap_2way: [null] },
    basketball: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    tennis:     { handicap_2way: [null], over_under: [null, '1st_set'] },
  },
  '22bet': {
    // Same engine as 1xbet — needs e2e verification
    // soccer over_under '1st_half'/'2nd_half': each half is a separate sub-game
    //   (gameData.SubGames[].CI / .PN, confirmed 2026-06-18). beforeFindMarket
    //   navigates to the sub-game's constId URL; on that page Events hold only
    //   the half's markets. Implemented 2026-06-18; pending live e2e confirmation.
    ice_hockey: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    soccer:     { '1x2': [null], over_under: [null, '1st_half', '2nd_half'], handicap_2way: [null] },
    basketball: { handicap_2way: ['ot_incl'], over_under: ['ot_incl'] },
    // tennis (same engine as 1xbet): match-winner via T=1/T=3 scan (22bet.js),
    // 1st-set totals via GS-scoped group scan. Enabled 2026-06-17 for live
    // verification on a working 22bet session.
    //   handicap_2way [null]  = FULL-MATCH winner only. 1st-set WINNER is
    //     intentionally absent: it has no standalone group on this engine (see
    //     1xbet notes), and 22bet.js's winner scan has no set scoping, so a
    //     1st_set signal would silently grab the full-match winner (wrong bet).
    //   over_under ['1st_set'] = 1st-set totals (full-match totals unverified).
    tennis: { handicap_2way: [null], over_under: ['1st_set'] },
  },
};

function supportStatus(leg, parsed) {
  const { sport, market } = parsed;
  const bookCaps = BOOK_CAPABILITIES[leg.book];
  if (!bookCaps)                       return { ok: false, reason: `未対応のブック (${leg.book})` };
  if (!bookCaps[sport])                return { ok: false, reason: `未対応の種目: ${sport}` };
  const allowedPeriods = bookCaps[sport][market.type];
  if (!allowedPeriods)                 return { ok: false, reason: `未対応の市場: ${market.type}` };
  if (!allowedPeriods.includes(market.period))
    return { ok: false, reason: `未対応の期間: ${market.period ?? '全試合'}` };
  return { ok: true, reason: '' };
}

// currentBets: array of {parsed, calculated} from server
let currentBets = [];

// Latest FX rates from the server payload: { USD_JPY, asof }. asof===0 means
// the rate is a stale fallback. Cached in chrome.storage.local alongside
// lastBets so execution can convert even after a popup reopen.
let currentRates = null;

// The user's chosen total stake in JPY. Drives the live per-leg recompute.
let userTotal = DEFAULT_TOTAL_STAKE;

// Per-book typed-currency map, loaded from sync settings.
let bookCurrencies = defaultBookCurrencies();

// Track which bet+leg is executing for each book, for STATUS_UPDATE routing.
// { book: { betIdx, legIdx } }
const executing = {};

// Restore last parsed bets + rates + settings on open, then check backend.
(async () => {
  const cfg = await getConfig();
  userTotal = cfg.totalStake;
  bookCurrencies = cfg.bookCurrencies;

  const { lastBets, lastRates } = await chrome.storage.local.get(['lastBets', 'lastRates']);
  if (lastRates) currentRates = lastRates;
  if (lastBets) {
    currentBets = lastBets;
    renderBets();
  }
  checkBackend();
})();

// Clear badge when popup opens
chrome.action.setBadgeText({ text: '' });

// Auto-render when a Discord signal arrives while popup is open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.lastRates) currentRates = changes.lastRates.newValue || null;
  if (!changes.lastBets) return;
  currentBets = changes.lastBets.newValue || [];
  renderBets();
  const errEl = document.getElementById('parse-error');
  if (errEl) { errEl.textContent = '新着シグナルを受信'; errEl.style.color = '#22c55e'; }
});

async function checkBackend() {
  try {
    const { serverUrl } = await getConfig();
    // /health is unauthenticated so a keep-alive ping (and this status dot) work
    // without leaking the bearer token. Don't add auth header here.
    const res = await fetch(`${serverUrl}/health`, { signal: AbortSignal.timeout(2000) });
    setDot(res.ok);
  } catch {
    setDot(false);
  }
}

function setDot(connected) {
  document.getElementById('status-dot').style.background = connected ? '#22c55e' : '#ef4444';
  document.getElementById('backend-status').textContent = connected ? '' : 'バックエンド未接続';
}

async function doParse() {
  const msg = document.getElementById('msg-input').value.trim();
  if (!msg) return;

  const btn = document.getElementById('parse-btn');
  btn.disabled = true;
  btn.textContent = '解析中...';
  document.getElementById('parse-error').textContent = '';

  try {
    const { serverUrl, bearerToken } = await getConfig();
    const res = await fetch(`${serverUrl}/parse`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(bearerToken) },
      body: JSON.stringify({ message: msg }),
      signal: AbortSignal.timeout(30000),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error);

    currentBets = data.bets;
    currentRates = data.rates || null;
    chrome.storage.local.set({ lastBets: data.bets, lastRates: currentRates });
    renderBets();
    setDot(true);
  } catch (e) {
    const isNetwork = e instanceof TypeError;
    document.getElementById('parse-error').textContent =
      isNetwork ? 'サーバーに接続できません。バックエンドを起動してください。' : `エラー: ${e.message}`;
    if (isNetwork) setDot(false);
  } finally {
    btn.disabled = false;
    btn.textContent = '解析';
  }
}

function renderBets() {
  const container = document.getElementById('bets-container');
  if (!currentBets.length) { container.innerHTML = ''; return; }

  // Subtle warning if any book is set to USD but the FX rate is a stale fallback.
  const anyUsd = BOOKS.some((b) => bookCurrencies[b] === 'USD');
  const staleRate = currentRates && currentRates.asof === 0;
  const rateWarn = (anyUsd && staleRate)
    ? `<div class="rate-warning">⚠ USDレートは古い参考値です (USD/JPY ${esc(currentRates.USD_JPY)})</div>`
    : '';

  container.innerHTML = rateWarn + currentBets.map((bet, betIdx) => renderBetBlock(bet, betIdx)).join('');

  // Attach execute button listeners
  currentBets.forEach(({ parsed, calculated }, betIdx) => {
    const legs = calculated.is_arb ? calculated.legs : parsed.legs;
    legs.forEach((leg, legIdx) => {
      const btn = document.getElementById(`btn-${betIdx}-${legIdx}`);
      if (btn && !btn.disabled) {
        btn.addEventListener('click', () => executeLegs(betIdx, [legIdx]));
      }
    });

    const allBtn = document.getElementById(`btn-all-${betIdx}`);
    if (allBtn && !allBtn.disabled) {
      const supportedIdx = legs
        .map((leg, i) => (supportStatus(leg, parsed).ok ? i : -1))
        .filter(i => i !== -1);
      allBtn.addEventListener('click', () => executeLegs(betIdx, supportedIdx));
    }
  });
}

// Per-leg stakes and total profit scale LINEARLY with the total stake (the
// odds-split ratio and margin_pct are invariant). Given the server's
// `calculated` (computed at calculated.total_stake), scale to the user total.
function scaleFactor(calculated) {
  const base = Number(calculated.total_stake);
  return base > 0 ? userTotal / base : 0;
}

// JPY stake for a single calculated leg at the user's chosen total.
function legStakeJpy(calculated, leg) {
  if (leg.stake == null) return null;
  return leg.stake * scaleFactor(calculated);
}

function renderBetBlock({ parsed, calculated }, betIdx) {
  const showIndex = currentBets.length > 1;
  const factor = scaleFactor(calculated);

  let profitText, profitClass;
  if (calculated.is_arb) {
    const profitJpy = calculated.profit * factor;
    profitText = `${calculated.margin_pct}% 利益 · ¥${Math.round(profitJpy).toLocaleString()}`;
    profitClass = 'profit-ok';
  } else {
    profitText = `アービトラージなし (${calculated.margin_pct}%)`;
    profitClass = 'profit-no';
  }

  const legs = calculated.is_arb ? calculated.legs : parsed.legs;

  const supportedCount = legs.filter(l => supportStatus(l, parsed).ok).length;

  const legsHtml = legs.map((leg, legIdx) => {
    const support = supportStatus(leg, parsed);
    const stakeJpy = legStakeJpy(calculated, leg);
    const stakeHtml = stakeJpy != null
      ? `<span class="stake">¥${Math.round(stakeJpy).toLocaleString()}</span>`
      : '<span class="stake"></span>';
    return `
      <div class="leg-card">
        <div class="leg-book">${esc(leg.book.toUpperCase())}</div>
        <div class="leg-selection">${esc(leg.selection_detail)}</div>
        <div class="leg-row">
          <span class="odds">@ ${leg.odds}</span>
          ${stakeHtml}
          <button class="execute-btn" id="btn-${betIdx}-${legIdx}"${support.ok ? '' : ` disabled title="${esc(support.reason)}"`}>実行</button>
        </div>
        <div class="leg-status" id="status-${betIdx}-${legIdx}">${support.ok ? '' : esc(support.reason)}</div>
      </div>
    `;
  }).join('');

  return `
    <div class="bet-block">
      ${showIndex ? `<div class="bet-index">案件 ${betIdx + 1} / ${currentBets.length}</div>` : ''}
      <div class="event-card">
        <div class="event-teams">${esc(parsed.event.team1)} vs ${esc(parsed.event.team2)}</div>
        <div class="event-meta">${esc(parsed.league)} · ${esc(parsed.market.description)}</div>
        <div class="event-profit ${profitClass}">${profitText}</div>
      </div>
      <details class="raw-msg">
        <summary>元のメッセージ</summary>
        <pre>${esc(parsed.signal_metadata.raw_message)}</pre>
      </details>
      <div class="legs">${legsHtml}</div>
      ${supportedCount >= 2 ? `
        <div class="run-all-row">
          <button class="run-all-btn" id="btn-all-${betIdx}">全脚を順に実行 (${supportedCount})</button>
        </div>` : ''}
    </div>
  `;
}

// Convert a JPY stake into the number to TYPE into a book, per its configured
// currency. Returns { stake, currency } or { error } if conversion is impossible.
function convertStake(book, stakeJpy) {
  const currency = bookCurrencies[book] === 'USD' ? 'USD' : 'JPY';
  if (currency === 'JPY') {
    return { stake: Math.round(stakeJpy), currency };
  }
  // USD: need a usable rate (USD_JPY > 0). Don't silently fill if missing.
  const rate = currentRates && Number(currentRates.USD_JPY);
  if (!rate || rate <= 0) {
    return { error: 'USDレートが取得できません。サーバーに再接続するか解析し直してください。', currency };
  }
  return { stake: Math.round((stakeJpy / rate) * 100) / 100, currency };
}

function executeLegs(betIdx, legIndices) {
  const { parsed, calculated } = currentBets[betIdx];
  const allLegs = calculated.is_arb ? calculated.legs : parsed.legs;

  const candidates = legIndices
    .map(i => ({ legIdx: i, leg: allLegs[i] }))
    .filter(({ leg }) => supportStatus(leg, parsed).ok);

  if (candidates.length === 0) return;

  // Resolve fill-time currency conversion per leg. A leg whose currency is USD
  // but has no usable rate is dropped here with an error shown on its card.
  const toRun = [];
  for (const { legIdx, leg } of candidates) {
    const stakeJpy = legStakeJpy(calculated, leg);
    const conv = convertStake(leg.book, stakeJpy);
    if (conv.error) {
      setStatus(betIdx, legIdx, conv.error, 'error');
      continue;
    }
    toRun.push({
      legIdx,
      leg: { ...leg, stake: conv.stake, stake_jpy: stakeJpy, currency: conv.currency },
    });
  }

  if (toRun.length === 0) return;

  toRun.forEach(({ legIdx, leg }, i) => {
    const btn = document.getElementById(`btn-${betIdx}-${legIdx}`);
    if (btn) { btn.disabled = true; btn.textContent = '実行中...'; }
    setStatus(betIdx, legIdx, i === 0 ? 'ブックを開いています...' : '待機中...', 'running');
    executing[leg.book] = { betIdx, legIdx };
  });

  const allBtn = document.getElementById(`btn-all-${betIdx}`);
  if (allBtn) { allBtn.disabled = true; allBtn.textContent = '実行中...'; }

  const payload = toRun.map(({ leg }) => ({
    book:    leg.book,
    betData: { ...parsed, legs: [{ ...leg }] },
  }));
  chrome.runtime.sendMessage({ type: 'EXECUTE_LEGS', legs: payload });
}

function setStatus(betIdx, legIdx, message, type = '') {
  const el = document.getElementById(`status-${betIdx}-${legIdx}`);
  if (el) { el.textContent = message; el.className = `leg-status ${type}`; }
}

function esc(text) {
  if (text == null) return '';
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type !== 'STATUS_UPDATE') return;
  const loc = executing[msg.book];
  if (!loc) return;
  const { betIdx, legIdx } = loc;
  setStatus(betIdx, legIdx, msg.message, msg.status);
  if (msg.status === 'done' || msg.status === 'error') {
    delete executing[msg.book];
    const btn = document.getElementById(`btn-${betIdx}-${legIdx}`);
    if (btn) {
      btn.disabled = false;
      btn.textContent = msg.status === 'done' ? '✓ 完了' : '再試行';
    }
    const stillRunning = Object.values(executing).some(v => v.betIdx === betIdx);
    if (!stillRunning) {
      const allBtn = document.getElementById(`btn-all-${betIdx}`);
      if (allBtn) { allBtn.disabled = false; allBtn.textContent = '再実行'; }
    }
  }
});

document.getElementById('parse-btn').addEventListener('click', doParse);
document.getElementById('msg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.ctrlKey) doParse();
});

// --- Settings panel ---

// Build the per-book currency dropdown grid. Each cell: book label + select.
function renderCurrencyControls() {
  const container = document.getElementById('cfg-currencies');
  container.innerHTML = BOOKS.map((book) => {
    const cur = bookCurrencies[book] || 'JPY';
    const opt = (v) => `<option value="${v}"${cur === v ? ' selected' : ''}>${v}</option>`;
    return `
      <span class="cfg-cur-book">${esc(book)}</span>
      <select class="cfg-cur" data-book="${esc(book)}">${opt('JPY')}${opt('USD')}</select>
    `;
  }).join('');
}

(async () => {
  const cfg = await getConfig();
  const serverInput = document.getElementById('cfg-server');
  const tokenInput  = document.getElementById('cfg-token');
  const totalInput  = document.getElementById('cfg-total');
  // Show the stored value if it's not the default — keeps "blank = default" semantics.
  if (cfg.serverUrl !== DEFAULT_SERVER) serverInput.value = cfg.serverUrl;
  tokenInput.value = cfg.bearerToken;
  totalInput.value = cfg.totalStake;
  renderCurrencyControls();
})();

// Live recompute: changing the total stake re-renders stakes/profit immediately
// and persists the choice so it survives a popup reopen.
document.getElementById('cfg-total').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  if (v > 0) {
    userTotal = v;
    chrome.storage.sync.set({ totalStake: v });
    renderBets();
  }
});

document.getElementById('cfg-save').addEventListener('click', async () => {
  const serverUrl   = document.getElementById('cfg-server').value.trim();
  const bearerToken = document.getElementById('cfg-token').value.trim();
  const totalVal    = Number(document.getElementById('cfg-total').value);
  const totalStake  = totalVal > 0 ? totalVal : DEFAULT_TOTAL_STAKE;

  const currencies = {};
  document.querySelectorAll('.cfg-cur').forEach((sel) => {
    currencies[sel.dataset.book] = sel.value === 'USD' ? 'USD' : 'JPY';
  });

  bookCurrencies = currencies;
  userTotal = totalStake;

  await chrome.storage.sync.set({ serverUrl, bearerToken, totalStake, bookCurrencies: currencies });
  const savedEl = document.getElementById('cfg-saved');
  savedEl.textContent = '保存しました';
  setTimeout(() => { savedEl.textContent = ''; }, 1500);
  renderBets();
  checkBackend();
});
