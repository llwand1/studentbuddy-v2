(() => {
  globalThis.studentBuddyStopReader?.();
  const epoch = globalThis.studentBuddyReaderEpoch;
  if (!epoch) return;
  let seq = 0; let timer; let stopped = false; let lastSent = 0;
  const send = () => {
    if (stopped) return;
    clearTimeout(timer); timer = null;
    lastSent = Date.now();
    const data = { ...globalThis.studentBuddyReadPage(), url: location.href.slice(0, 3000), title: document.title.slice(0, 300), epoch, seq: ++seq };
    chrome.runtime.sendMessage({ type: 'snapshot', data }).then(result => { if (result?.stop) stop(); }).catch(() => stop());
  };
  const changed = () => {
    if (stopped || timer) return;
    timer = setTimeout(() => { timer = null; send(); }, Math.max(700, 3000 - (Date.now() - lastSent)));
  };
  const observer = new MutationObserver(changed);
  observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'aria-hidden'] });
  document.addEventListener('selectionchange', changed);
  addEventListener('scroll', changed, { passive: true });
  const heartbeat = setInterval(send, 15000);
  const restored = event => {
    if (!event.persisted) return;
    if (stopped) chrome.runtime.sendMessage({ type: 'resume' }).catch(() => {});
    removeEventListener('pageshow', restored);
  };
  addEventListener('pageshow', restored);
  const leaving = event => { chrome.runtime.sendMessage({ type: 'leaving', epoch }).catch(() => {}); stop(event.persisted); };
  addEventListener('pagehide', leaving, { once: true });
  function stop(keepRestore = false) {
    if (stopped) return; stopped = true; clearTimeout(timer); clearInterval(heartbeat); observer.disconnect();
    document.removeEventListener('selectionchange', changed); removeEventListener('scroll', changed); removeEventListener('pagehide', leaving);
    if (!keepRestore) removeEventListener('pageshow', restored);
  }
  globalThis.studentBuddyStopReader = stop;
  send();
})();
