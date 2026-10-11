/* Runs in Chrome's isolated world. Never reads form values, cookies or storage. */
(() => {
  const excluded = 'script,style,noscript,iframe,canvas,svg,nav,footer,aside,form,input,textarea,select,button,[contenteditable], [aria-hidden="true"], [hidden]';
  let visibility;
  function readable(node) {
    const parent = node.parentElement;
    if (!parent || parent.closest(excluded)) return false;
    let element = parent;
    while (element) {
      if (visibility.has(element)) return visibility.get(element);
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') { visibility.set(parent, false); return false; }
      element = element.parentElement;
    }
    visibility.set(parent, true);
    return true;
  }
  function selectedText(selection) {
    const pieces = []; let size = 0; let visited = 0;
    for (let i = 0; i < Math.min(selection?.rangeCount || 0, 8) && size < 3000; i++) {
      const range = selection.getRangeAt(i);
      const append = node => {
        if (!readable(node) || !range.intersectsNode(node)) return;
        const from = range.startContainer === node ? range.startOffset : 0;
        const to = range.endContainer === node ? range.endOffset : node.textContent.length;
        const text = node.textContent.slice(from, to).slice(0, 3000 - size).trim();
        if (text) { pieces.push(text); size += text.length + 1; }
      };
      const root = range.commonAncestorContainer;
      if (root.nodeType === 3) { append(root); continue; }
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode()) && visited++ < 20000 && size < 3000) append(node);
    }
    return pieces.join('\n').slice(0, 3000);
  }
  globalThis.studentBuddyReadPage = () => {
    visibility = new WeakMap();
    const root = document.querySelector('main article') || document.querySelector('article') || document.querySelector('main, [role="main"]') || document.body;
    if (!root) return { text: '', selection: '', viewport: '' };
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const parts = []; const visible = []; let count = 0; let visibleCount = 0; let node;
    // Bound work on very large/hostile DOMs as well as output size.
    let visited = 0;
    while ((node = walker.nextNode()) && visited++ < 20000 && count < 120000) {
      if (!readable(node)) continue;
      const text = node.textContent.replace(/\s+/g, ' ').trim();
      if (!text) continue;
      const piece = text.slice(0, 120000 - count); parts.push(piece); count += piece.length + 2;
      if (visibleCount < 6000) {
        const rect = node.parentElement.getBoundingClientRect();
        if (rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth) {
          visible.push(piece.slice(0, 6000 - visibleCount)); visibleCount += piece.length + 2;
        }
      }
    }
    const selection = getSelection();
    return { text: parts.join('\n\n').slice(0, 120000), viewport: visible.join('\n\n').slice(0, 6000),
      selection: selectedText(selection) };
  };
})();
