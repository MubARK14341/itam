const RESET_PENDING = 'studio-demo:reset-pending';
const RESET_NOTICE = 'studio-demo:reset-notice';
const CHANNEL = 'studio-demo:reset-v1';
let channel: BroadcastChannel | null = null;
let reopening = false;

export function clearDemoOwnedBrowserState() {
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith('itam:portal-create:v1:') || key.startsWith('itam:pending-operation:v1:') || key === 'itam_exposure_preview') sessionStorage.removeItem(key);
  }
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith('itam.private-views.v1:') || key === 'studio-demo:read-invalidation') localStorage.removeItem(key);
  }
}
function reopenResetDemo() {
  if (reopening) return;
  reopening = true;
  sessionStorage.setItem(RESET_PENDING, '1');
  // A new document clears RAM files/URLs and old continuations. Bootstrap repeats marker
  // cleanup after the old document is gone, so an old reply cannot restore a stale marker.
  clearDemoOwnedBrowserState();
  window.location.replace('/login');
}
export function installDemoResetLifecycle() {
  if (sessionStorage.getItem(RESET_PENDING) === '1') {
    clearDemoOwnedBrowserState(); sessionStorage.removeItem(RESET_PENDING);
  }
  if (typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event: MessageEvent<unknown>) => {
      const value = event.data;
      if (value && typeof value === 'object' && 'version' in value && value.version === 1 && 'generation' in value && typeof value.generation === 'number') reopenResetDemo();
    };
  }
  window.addEventListener('storage', (event) => { if (event.key === RESET_NOTICE && event.newValue) reopenResetDemo(); });
  window.addEventListener('pagehide', () => channel?.close(), { once: true });
}
export function finishDemoReset(generation: number) {
  const notice = { version: 1, generation };
  localStorage.setItem(RESET_NOTICE, JSON.stringify(notice));
  channel?.postMessage(notice);
  reopenResetDemo();
}
