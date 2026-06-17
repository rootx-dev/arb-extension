// Runs in the MAIN world at document_start — before the betting site's own JS loads.
// Spoofs visibility APIs so React click handlers and renders work in background tabs.
// (Content scripts run in an isolated world; only MAIN world defineProperty affects the page.)
try {
  Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
} catch (_) {}
window.requestAnimationFrame = cb => setTimeout(() => cb(performance.now()), 16);
