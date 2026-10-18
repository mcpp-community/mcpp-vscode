/* Shared package/module graph canvas. Providers send bounded subgraphs; the canvas owns navigation. */
(() => {
  const vscode = acquireVsCodeApi(), labels = JSON.parse(document.getElementById('graph-labels').textContent);
  const graph = document.getElementById('graph'), status = document.getElementById('graph-state');
  const views = new Map();
  let data, currentKey, selected, zoom = 1, panX = 0, panY = 0, baseWidth = 0, baseHeight = 0;
  let drag, suppressClick = false, pending, drawing = false, renderId = 0, busy = true;
  const send = (action, extra = {}) => vscode.postMessage({ type: 'action', action, viewKey: currentKey, ...extra });
  function applyView() { const svg = graph.querySelector('svg'); if (svg) svg.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`; }
  function saveView() { if (currentKey && baseWidth) views.set(currentKey, { zoom, panX, panY }); }
  function zoomAt(next, x = graph.clientWidth / 2, y = graph.clientHeight / 2) {
    next = Math.max(.02, Math.min(4, next)); const ratio = next / zoom;
    panX = x - (x - panX) * ratio; panY = y - (y - panY) * ratio; zoom = next; applyView(); saveView();
  }
  function fitGraph() {
    if (!baseWidth || !baseHeight) return;
    zoom = Math.max(.001, Math.min(1, (graph.clientWidth - 48) / baseWidth, (graph.clientHeight - 48) / baseHeight));
    panX = (graph.clientWidth - baseWidth * zoom) / 2; panY = (graph.clientHeight - baseHeight * zoom) / 2; applyView(); saveView();
  }
  function selectNode(id, center = false) {
    selected = id;
    graph.querySelectorAll('.node').forEach(node => {
      const active = node.dataset.nodeKey === id;
      node.classList.toggle('is-focused', active); node.setAttribute('aria-pressed', String(active));
      if (active && center) {
        if (zoom < .85) zoomAt(.85);
        const viewport = graph.getBoundingClientRect(), box = node.getBoundingClientRect();
        panX += viewport.left + viewport.width / 2 - box.left - box.width / 2;
        panY += viewport.top + viewport.height / 2 - box.top - box.height / 2; applyView(); saveView();
      }
    });
    document.getElementById('selected-node').textContent = data?.nodes.find(node => node.id === id)?.label || labels.selected;
    for (const button of document.querySelectorAll('.graph-selection button')) button.disabled = !id || busy;
  }
  function activateNode(id) { selectNode(id); send('open', { id }); }
  function setStatus(text, block = false) { status.textContent = text; status.hidden = !text; graph.classList.toggle('is-loading', block); }
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
    if (button.dataset.action === 'copy') return send('copy');
    send(button.dataset.action, { id: selected });
  }));
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => send('mode', { mode: button.dataset.mode })));
  document.getElementById('graph-depth').addEventListener('change', event => send('depth', { depth: event.target.value }));
  const search = document.getElementById('graph-search');
  function find() { const node = data?.search.find(node => node.id === search.value || node.label === search.value); if (node) send('search', { id: node.id }); }
  search.addEventListener('change', find); search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); find(); } });
  document.querySelectorAll('[data-zoom]').forEach(button => button.addEventListener('click', () => button.dataset.zoom === 'fit' ? fitGraph() : zoomAt(zoom * (button.dataset.zoom === '+' ? 1.2 : 1 / 1.2))));
  graph.addEventListener('wheel', event => {
    event.preventDefault(); if (busy) return;
    const rect = graph.getBoundingClientRect(), delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? graph.clientHeight : 1);
    zoomAt(zoom * Math.exp(-delta * .0015), event.clientX - rect.left, event.clientY - rect.top);
  }, { passive: false });
  graph.addEventListener('pointerdown', event => { if (!busy && event.button === 0) drag = { id: event.pointerId, x: event.clientX, y: event.clientY, panX, panY, moved: false }; });
  graph.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    const dx = event.clientX - drag.x, dy = event.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) > 4) { drag.moved = true; graph.setPointerCapture(event.pointerId); graph.classList.add('is-grabbing'); }
    if (drag.moved) { event.preventDefault(); panX = drag.panX + dx; panY = drag.panY + dy; applyView(); saveView(); }
  });
  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) return;
    suppressClick = drag.moved; if (graph.hasPointerCapture(event.pointerId)) graph.releasePointerCapture(event.pointerId);
    graph.classList.remove('is-grabbing'); drag = undefined; setTimeout(() => suppressClick = false, 0);
  }
  graph.addEventListener('pointerup', endDrag); graph.addEventListener('pointercancel', endDrag);
  graph.addEventListener('click', event => { if (suppressClick || busy) { event.preventDefault(); event.stopPropagation(); } }, true);
  graph.addEventListener('keydown', event => {
    if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoomAt(zoom * (event.key === '-' ? 1 / 1.2 : 1.2)); }
    if (event.key === '0') { event.preventDefault(); fitGraph(); }
  });
  async function draw() {
    if (drawing) return;
    drawing = true;
    while (pending) {
      const next = pending; pending = undefined;
      const request = ++renderId, viewChanged = currentKey !== next.viewKey;
      saveView(); currentKey = next.viewKey; data = next; busy = true;
      document.getElementById('project-name').textContent = next.name;
      document.getElementById('graph-depth').value = next.depth;
      document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === next.mode)));
      document.querySelector('[data-action=overview]').hidden = !next.focus;
      const options = document.getElementById('graph-options'); options.replaceChildren();
      for (const node of next.search) { const option = document.createElement('option'); option.value = node.label; option.label = node.label; options.append(option); }
      if (viewChanged) search.value = '';
      document.getElementById('graph-source').textContent = next.source;
      const notice = document.getElementById('graph-notice'); notice.textContent = [next.limited ? labels.limited : '', next.truncated ? labels.partial : ''].filter(Boolean).join(' '); notice.hidden = !notice.textContent;
      if (!next.nodes.length) { graph.replaceChildren(); setStatus(labels.empty); busy = false; selectNode(undefined); continue; }
      const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
      mermaid.initialize({ startOnLoad: false, htmlLabels: false, securityLevel: 'strict', suppressErrorRendering: true, theme: dark ? 'dark' : 'default', fontFamily: 'system-ui', markdownAutoWrap: false, flowchart: { htmlLabels: false, useMaxWidth: true, wrappingWidth: 1000, nodeSpacing: 30, rankSpacing: 90, padding: 18 }, maxEdges: 310 });
      try {
        const result = await mermaid.render(`dependency-svg-${request}`, next.source);
        if (pending || data !== next) continue;
        graph.innerHTML = result.svg; const svg = graph.querySelector('svg');
        baseWidth = svg.viewBox.baseVal.width; baseHeight = svg.viewBox.baseVal.height; svg.style.width = baseWidth + 'px'; svg.style.maxWidth = 'none';
        const saved = views.get(currentKey);
        if (!saved || next.fit) fitGraph(); else { ({ zoom, panX, panY } = saved); applyView(); }
        graph.querySelectorAll('.edgeLabel .label').forEach(label => {
          const text = label.querySelector('text'), background = label.querySelector('rect.background');
          if (text && background) { const box = text.getBBox(); for (const [key, value] of Object.entries({ x: box.x - 4, y: box.y - 3, width: box.width + 8, height: box.height + 6, rx: 3 })) background.setAttribute(key, String(value)); }
        });
        graph.querySelectorAll('.node').forEach(node => {
          const match = /flowchart-(n[0-9]+)-/.exec(node.id); if (!match) return;
          const item = next.nodes[Number(match[1].slice(1))]; if (!item) return;
          node.dataset.nodeKey = item.id; node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button'); node.setAttribute('aria-label', node.textContent);
          node.querySelectorAll('rect').forEach(rect => { rect.setAttribute('rx', '8'); rect.setAttribute('ry', '8'); });
          node.addEventListener('click', () => activateNode(item.id));
          node.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateNode(item.id); } });
          if (item.hidden) {
            const line = node.querySelector('text')?.lastElementChild;
            if (line) {
              line.classList.add('fold-control'); line.setAttribute('role', 'button'); line.setAttribute('tabindex', '0'); line.setAttribute('aria-label', labels.expand + ': ' + item.hidden);
              const expand = event => { event.preventDefault(); event.stopPropagation(); selectNode(item.id); send('expand', { id: item.id }); };
              line.addEventListener('click', expand); line.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') expand(event); });
            }
          }
        });
        busy = false; setStatus(''); selectNode(next.selected, next.center); saveView();
      } catch { busy = false; graph.replaceChildren(); setStatus(labels.error); }
    }
    drawing = false;
  }
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'graph') { pending = message; draw(); }
    if (message.type === 'loading') {
      saveView(); currentKey = message.viewKey; baseWidth = 0; data = undefined; pending = undefined; busy = true;
      document.getElementById('project-name').textContent = message.name;
      document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === message.mode)));
      search.value = ''; selectNode(undefined); setStatus(labels.loading, true);
    }
    if (message.type === 'error') { busy = false; setStatus(message.error, true); }
    if (message.type === 'copied') { const feedback = document.getElementById('feedback'); feedback.textContent = labels.copied; setTimeout(() => feedback.textContent = '', 1800); }
  });
  new MutationObserver(() => { if (data) { pending = data; draw(); } }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('resize', () => applyView());
  selectNode(undefined); setStatus(labels.loading, true); vscode.postMessage({ type: 'ready' });
})();
