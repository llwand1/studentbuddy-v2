// A top-level loopback handoff only. Never collect this page or read other tabs.
if (window.top === window && location.pathname === '/desktop-reader-connect.html') {
  const button = document.getElementById('reader-connect'), status = document.getElementById('reader-status');
  if (button && status) {
    button.disabled = false;
    document.documentElement.dataset.readerExtension = 'ready';
    status.textContent = '扩展已就绪，点击「连接此对话」后选择你要共读的网页。';
    button.addEventListener('click', async event => {
      if (!event.isTrusted || button.disabled) return;
      const code = location.hash.slice(1);
      if (!/^[A-F0-9]{10}$/.test(code)) { status.textContent = '连接已过期或缺少连接码，请从 StudentBuddy 重新跳转。'; return; }
      button.disabled = true;
      try {
        const result = await chrome.runtime.sendMessage({ type: 'handoff', code });
        if (result.error) throw new Error(result.error);
        history.replaceState(null, '', location.pathname);
        status.textContent = '已连接！打开目标网页，点击扩展里的「共读当前页」开始。';
        button.textContent = '已连接此对话';
      } catch (e) { status.textContent = e.message || '连接失败，请重新跳转'; button.disabled = false; }
    });
  }
}
