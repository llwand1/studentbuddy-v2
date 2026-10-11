const KEY = 'studentbuddy.reader';
let latest = null; let pumping = false;
const state = async () => (await chrome.storage.session.get(KEY))[KEY] || {};
const save = async value => chrome.storage.session.set({ [KEY]: value });
function endpoint(value) {
  if (!/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(value)) throw new Error('请填入 StudentBuddy 显示的本机地址');
  const port = Number(new URL(value).port);
  if (port < 1 || port > 65535) throw new Error('本机端口无效');
  return value;
}
async function bridge(config, path, method, data) {
  const res = await fetch(endpoint(config.endpoint) + '/api/desktop/bridge' + path, {
    method, headers: { 'Content-Type': 'application/json', ...(config.token ? { Authorization: 'Bearer ' + config.token } : {}) },
    body: data === undefined ? undefined : JSON.stringify(data), signal: AbortSignal.timeout(6000), cache: 'no-store', credentials: 'omit',
  });
  const value = await res.json();
  if (!res.ok) { const error = new Error(value.error || `连接失败（${res.status}）`); error.status = res.status; throw error; }
  return value;
}
async function stopCapture(config) {
  latest = null;
  await save({ ...config, tabId: null, epoch: null, error: '' });
  if (config.tabId) {
    await chrome.scripting.executeScript({ target: { tabId: config.tabId }, func: () => globalThis.studentBuddyStopReader?.() }).catch(() => {});
  }
  if (config.token && config.epoch) await bridge(config, '/page', 'DELETE', { epoch: config.epoch }).catch(() => {});
}
async function inject(config) {
  await chrome.scripting.executeScript({ target: { tabId: config.tabId }, func: epoch => { globalThis.studentBuddyReaderEpoch = epoch; }, args: [config.epoch] });
  await chrome.scripting.executeScript({ target: { tabId: config.tabId }, files: ['extract.js', 'content.js'] });
}
async function pump() {
  if (pumping) return; pumping = true;
  try {
    while (latest) {
      const item = latest; latest = null;
      const config = await state();
      if (!config.token || config.tabId !== item.tabId || config.epoch !== item.data.epoch) continue;
      try {
        await bridge(config, '/page', 'POST', item.data);
        const current = await state();
        if (current.epoch === config.epoch) await save({ ...current, error: '', title: item.data.title, updatedAt: Date.now() });
        await chrome.action.setBadgeText({ text: '读' });
        await chrome.action.setBadgeBackgroundColor({ color: '#566f56' });
      } catch (e) {
        const current = await state();
        if (current.epoch === config.epoch) {
          if (e.status === 401 || e.status === 404) {
            await stopCapture(current);
            await save({ endpoint: current.endpoint, error: '本机连接已结束，请重新配对' });
          } else await save({ ...current, error: e.message });
        }
        await chrome.action.setBadgeText({ text: '!' });
      }
    }
  } finally { pumping = false; }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id) return false;
  const run = async () => {
    const config = await state();
    if (sender.tab) {
      if (message.type === 'resume' && sender.tab.id === config.tabId && sender.frameId === 0 && config.token &&
          new URL(sender.url).origin === new URL(config.url).origin) {
        const next = { ...config, epoch: crypto.randomUUID(), error: '' };
        await save(next); await inject(next); return { ok: true };
      }
      if (sender.frameId !== 0 || sender.tab.id !== config.tabId || !config.token ||
          message.data?.epoch !== config.epoch && message.epoch !== config.epoch) return { stop: true };
      if (message.type === 'snapshot') {
        if (!message.data || new URL(message.data.url).origin !== new URL(config.url).origin || new URL(sender.url).origin !== new URL(config.url).origin) return { stop: true };
        latest = { tabId: sender.tab.id, data: message.data }; void pump(); return { ok: true };
      }
      if (message.type === 'leaving') { latest = null; await bridge(config, '/page', 'DELETE', { epoch: config.epoch }).catch(() => {}); return { ok: true }; }
      return { stop: true };
    }
    if (sender.url !== chrome.runtime.getURL('popup.html')) throw new Error('只允许扩展入口执行连接操作');
    if (message.type === 'status') return { connected: !!config.token, title: config.title, tabId: config.tabId, error: config.error, endpoint: config.endpoint };
    if (message.type === 'pair') {
      await stopCapture(config);
      const next = { endpoint: endpoint(message.endpoint) };
      const result = await bridge(next, '/pair', 'POST', { code: message.code });
      await save({ ...next, token: result.token, tabId: null }); return { ok: true };
    }
    if (message.type === 'start') {
      if (!config.token) throw new Error('请先用 StudentBuddy 的配对码连接');
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id || !/^https?:\/\//.test(tab.url || '') || new URL(tab.url).hostname === '127.0.0.1') throw new Error('请选择普通网页，浏览器设置页和本机应用不能共读');
      await stopCapture(config);
      const next = { ...config, tabId: tab.id, url: tab.url, title: tab.title, epoch: crypto.randomUUID(), error: '' };
      await save(next); await inject(next); return { ok: true };
    }
    if (message.type === 'stop') {
      await stopCapture(config); await bridge(config, '/connection', 'DELETE').catch(() => {});
      await chrome.storage.session.remove(KEY); await chrome.action.setBadgeText({ text: '' }); return { ok: true };
    }
    throw new Error('操作无效');
  };
  run().then(reply, e => reply({ error: e.message || '连接失败，请重试' })); return true;
});
chrome.tabs.onRemoved.addListener(async tabId => {
  const config = await state(); if (config.tabId === tabId) { await stopCapture(config); await chrome.action.setBadgeText({ text: '' }); }
});
chrome.tabs.onUpdated.addListener(async (tabId, info) => {
  const config = await state(); if (config.tabId !== tabId) return;
  if (info.status === 'loading') {
    latest = null;
    await save({ ...config, epoch: crypto.randomUUID(), error: '网页跳转中' });
    await bridge(config, '/page', 'DELETE', { epoch: config.epoch }).catch(() => {});
  }
  if (info.status === 'complete') {
    const current = await state();
    if (current.tabId !== tabId || !current.token) return;
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab?.url || new URL(tab.url).origin !== new URL(config.url).origin) {
      await stopCapture(current); await chrome.action.setBadgeText({ text: '' }); return;
    }
    const next = { ...current, url: tab.url, epoch: crypto.randomUUID(), error: '' };
    await save(next); await inject(next).catch(async () => { await stopCapture(next); });
  }
});
