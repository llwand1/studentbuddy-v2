const $ = id => document.getElementById(id);
async function action(type, data = {}) {
  const buttons = document.querySelectorAll('button'); buttons.forEach(b => { b.disabled = true; });
  try {
    const result = await chrome.runtime.sendMessage({ type, ...data });
    if (result.error) throw new Error(result.error);
    if (type === 'status') {
      if (result.endpoint) $('endpoint').value = result.endpoint;
      $('status').textContent = result.error || (result.tabId ? `正在共读：${result.title || '当前页'}` : result.connected ? '已配对，请选择共读网页' : '尚未连接');
    } else {
      $('status').textContent = type === 'start' ? '已选择当前网页，正在同步…' : type === 'stop' ? '已停止，临时资料已清除' : '配对成功，可以共读当前网页';
      if (type === 'pair') $('code').value = '';
    }
  } catch (e) { $('status').textContent = e.message || '操作失败，请重试'; }
  finally { buttons.forEach(b => { b.disabled = false; }); }
}
$('pair').addEventListener('click', () => action('pair', { endpoint: $('endpoint').value.trim(), code: $('code').value.trim() }));
$('start').addEventListener('click', () => action('start'));
$('stop').addEventListener('click', () => action('stop'));
void action('status');
