// Runs in MAIN world on betsio sports pages.
// Receives postMessage from isolated-world betsio.js.
// Injects a <script> into the iframe document so the click runs inside the iframe's
// own JS context. Radix UI tabs require the full pointer event sequence
// (pointerdown + mousedown + focus + pointerup + mouseup + click) — a bare
// .click() alone doesn't trigger the tab state change.
window.__arbBetsioMain = true;
console.log('[ARB-betsio-main] loaded');

window.addEventListener('message', (e) => {
  if (e.source !== window) return;
  if (e.data?.type !== 'arb:betsio-click-tab') return;
  const iframe = document.querySelector('iframe[src*="sportsbook"]');
  const iframeDoc = iframe?.contentDocument;
  if (!iframeDoc) return;
  const text = JSON.stringify(e.data.text);
  const script = iframeDoc.createElement('script');
  script.textContent = `(function(){
    var t=Array.from(document.querySelectorAll('button.sb-TabsTrigger')).find(function(b){return b.textContent.trim()===${text};});
    if(!t){window.__arbClickResult='not found';return;}
    var fire=function(type){t.dispatchEvent(new PointerEvent(type,{bubbles:true,cancelable:true,isPrimary:true}));};
    fire('pointerover');fire('pointerenter');fire('pointerdown');fire('mousedown');
    t.focus();
    fire('pointerup');fire('mouseup');fire('click');
    window.__arbClickResult='done';
  })();`;
  iframeDoc.documentElement.appendChild(script);
  script.remove();
  console.log('[ARB-betsio-main] pointer sequence injected for tab: ' + e.data.text);
});
