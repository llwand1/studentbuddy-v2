/* global document, navigator, MutationObserver */
const manager = document.getElementById('reader-manager');
const address = navigator.userAgent.includes('Edg/') ? 'edge://extensions' : 'chrome://extensions';
if (manager) manager.textContent = address;
document.getElementById('reader-copy-manager')?.addEventListener('click', async () => {
  const status = document.getElementById('reader-copy-status');
  try { await navigator.clipboard.writeText(address); if (status) status.textContent = ' 已复制，请粘贴到地址栏后回车。'; }
  catch { if (status) status.textContent = ' 请选中上方地址手动复制到地址栏。'; }
});
const status = document.getElementById('reader-status'), connect = document.getElementById('reader-connect'), install = document.getElementById('reader-install');
function refreshReady() {
  // Also recognize the previous extension's status for smooth upgrades.
  if (connect && (document.documentElement.dataset.readerExtension === 'ready' || status?.textContent?.startsWith('扩展已就绪'))) {
    connect.disabled = false; if (install) install.open = false;
  }
}
if (status) new MutationObserver(refreshReady).observe(status, {childList:true,subtree:true,characterData:true});
refreshReady();
