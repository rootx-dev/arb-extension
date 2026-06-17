// Sequential execution orchestrator.
//
// Background tabs get aggressively throttled by Chrome (timers clamped to ~1Hz,
// rAF paused), which breaks the Cloudbet bet slip render. So instead of running
// legs in parallel, we run them one at a time, each in a foregrounded tab:
// popup sends EXECUTE_LEGS with all legs at once; we open tab 1 active, wait for
// its content script to signal done/error via STATUS_UPDATE, then open tab 2, etc.
//
// Queue is persisted to chrome.storage.local because MV3 service workers can be
// suspended while waiting for STATUS_UPDATE.

// ── Discord → WebSocket push ───────────────────────────────────────────────────
// Service workers are suspended when idle (MV3 lifetime rules). We reconnect via
// a 1-minute alarm. The backend sends the latest cached bets immediately on each
// new WS connection, so a reconnecting SW always gets current state even if it
// missed the original push.

const DEFAULT_SERVER = 'http://localhost:8888';

// http(s):// → ws(s)://, strip trailing slash, append /ws?token=...
async function _wsUrl() {
  const { serverUrl, bearerToken } = await chrome.storage.sync.get(['serverUrl', 'bearerToken']);
  const base = (serverUrl || DEFAULT_SERVER).replace(/\/+$/, '');
  const ws = base.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
  return bearerToken ? `${ws}/ws?token=${encodeURIComponent(bearerToken)}` : `${ws}/ws`;
}

let _ws = null;

async function _connectWS() {
  if (_ws && (_ws.readyState === WebSocket.CONNECTING || _ws.readyState === WebSocket.OPEN)) return;
  try {
    const url = await _wsUrl();
    _ws = new WebSocket(url);
    _ws.onopen  = () => console.log('[ARB-SW] WS connected');
    _ws.onclose = () => { console.log('[ARB-SW] WS disconnected'); _ws = null; };
    _ws.onerror = () => { _ws = null; };
    _ws.onmessage = async (e) => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      if (!Array.isArray(data.bets)) return;
      // Store rates alongside bets so the popup can convert currencies even
      // after a reopen (it reads lastRates from chrome.storage.local).
      await chrome.storage.local.set({ lastBets: data.bets, lastRates: data.rates || null });
      const count = data.bets.length;
      chrome.action.setBadgeText({ text: count > 0 ? String(count) : '' });
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      console.log(`[ARB-SW] Stored ${count} bet(s) from backend`);
    };
  } catch (err) {
    console.log('[ARB-SW] WS connect failed:', err?.message);
  }
}

// Wake SW every minute to reconnect WS if the SW was suspended while it was down.
chrome.alarms.create('ws-keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ws-keepalive') _connectWS();
});

// Reconnect when the popup saves new server settings.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  if (changes.serverUrl || changes.bearerToken) {
    if (_ws) { try { _ws.close(); } catch {} _ws = null; }
    _connectWS();
  }
});

// Also connect immediately whenever the SW starts (install, update, Chrome restart).
_connectWS();
// ──────────────────────────────────────────────────────────────────────────────

const BOOK_URLS = {
  cloudbet: 'https://www.cloudbet.com/en/sports',
  roobet:   'https://roobet.com/sports',
  stake:    'https://stake.com/sports/home',
  shuffle:  'https://shuffle.com/sports',
  betsio:   'https://www.betsio.com/sports',
  betfury:  'https://betfury.io/sports',
  ggbet:    'https://gg.bet/sports',
  '1xbet':  'https://1xbetjap.com/en/line',
  '22bet':  'https://22bet.com/line',
};

async function getQueue() {
  const { execQueue } = await chrome.storage.local.get('execQueue');
  return execQueue || { pending: [], active: null };
}

async function setQueue(q) {
  await chrome.storage.local.set({ execQueue: q });
}

async function startNext() {
  const q = await getQueue();

  // Skip any queued leg whose book we don't support (defensive — popup filters too).
  while (q.pending.length > 0 && !BOOK_URLS[q.pending[0].book]) {
    q.pending.shift();
  }

  if (q.pending.length === 0) {
    await setQueue({ pending: [], active: null });
    return;
  }

  const leg = q.pending.shift();
  q.active = leg.book;
  await setQueue(q);

  await chrome.storage.local.set({
    [`${leg.book}State`]: { phase: 'search', betData: leg.betData },
  });
  chrome.tabs.create({ url: BOOK_URLS[leg.book], active: true });
}

chrome.runtime.onMessage.addListener((msg, sender) => {
  (async () => {
    if (msg.type === 'CLICK_IN_FRAME') {
      // Content scripts in isolated worlds can't trigger React's synthetic events
      // via .click(). The service worker runs the click in the frame's main world
      // via chrome.scripting.executeScript so React's event delegation fires.
      if (!sender.tab?.id) return;
      chrome.scripting.executeScript({
        target: { tabId: sender.tab.id, allFrames: true },
        world: 'MAIN',
        func: (selector, text) => {
          const el = [...document.querySelectorAll(selector)].find(e => e.textContent.trim() === text);
          if (el) el.click();
        },
        args: [msg.selector, msg.text],
      });
    } else if (msg.type === 'EXECUTE_LEGS') {
      // Each popup click sends a complete batch; reset queue so a previous
      // stuck run (active != null but nothing actually running) can't block us.
      await setQueue({ pending: [...msg.legs], active: null });
      startNext();
    } else if (
      msg.type === 'STATUS_UPDATE' &&
      (msg.status === 'done' || msg.status === 'error')
    ) {
      const q = await getQueue();
      if (q.active === msg.book) {
        q.active = null;
        await setQueue(q);
        startNext();
      }
    }
  })();
});
