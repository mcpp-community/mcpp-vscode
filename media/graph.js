/* Bounded SVG canvas: data, selection and camera have separate update paths. */
(() => {
  const vscode = acquireVsCodeApi(), labels = JSON.parse(document.getElementById('graph-labels').textContent);
  const graph = document.getElementById('graph'), status = document.getElementById('graph-state');
  const views = new Map(), snapshots = new Map(), layouts = new Map();
  let data, currentKey, selected, zoom = 1, panX = 0, panY = 0, baseWidth = 0, baseHeight = 0;
  let drag, suppressClick = false, pending, drawing = false, renderId = 0, busy = true, committed, committedBinding;
  const send = (action, extra = {}) => vscode.postMessage({ type: 'action', action, viewKey: currentKey, ...extra });
  const cameraKey = next => next && `${next.viewKey}:${next.focus || next.group || 'overview'}:${next.offset || 0}`;
  const snapshot = () => snapshots.get(currentKey) || { search: [], groups: [] };
  function trim(map, max = 8) { while (map.size > max) map.delete(map.keys().next().value); }
  function applyView() { const svg = graph.querySelector('svg'); if (svg) svg.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`; }
  function saveView() { if (data && baseWidth) { views.delete(cameraKey(data)); views.set(cameraKey(data), { zoom, panX, panY }); trim(views, 40); } }
  function zoomAt(next, x = graph.clientWidth / 2, y = graph.clientHeight / 2) {
    next = Math.max(.02, Math.min(4, next)); const ratio = next / zoom;
    panX = x - (x - panX) * ratio; panY = y - (y - panY) * ratio; zoom = next; applyView(); saveView();
  }
  function fitGraph() {
    if (!baseWidth || !baseHeight) return;
    zoom = Math.max(.001, Math.min(1, (graph.clientWidth - 48) / baseWidth, (graph.clientHeight - 48) / baseHeight));
    panX = (graph.clientWidth - baseWidth * zoom) / 2; panY = (graph.clientHeight - baseHeight * zoom) / 2; applyView(); saveView();
  }
  function locate(id) {
    const node = [...graph.querySelectorAll('.node')].find(node => node.dataset.nodeKey === id);
    if (!node || busy) return;
    if (zoom < .85) zoomAt(.85);
    const viewport = graph.getBoundingClientRect(), box = node.getBoundingClientRect();
    panX += viewport.left + viewport.width / 2 - box.left - box.width / 2;
    panY += viewport.top + viewport.height / 2 - box.top - box.height / 2; applyView(); saveView();
  }
  const menus = [...document.querySelectorAll('.graph-menu')];
  function closeMenus(except) { for (const menu of menus) if (menu !== except) menu.open = false; }
  for (const menu of menus) menu.addEventListener('toggle', () => { if (menu.open) closeMenus(menu); });
  document.addEventListener('click', event => { if (!event.target.closest('.graph-menu')) closeMenus(); });
  document.addEventListener('keydown', event => { if (event.key === 'Escape') { const active = menus.find(menu => menu.open); closeMenus(); active?.querySelector('summary').focus(); } });
  document.getElementById('graph-node-menu').querySelector('summary').addEventListener('click', event => { if (!selected || busy) event.preventDefault(); });
  function selectNode(id, center = false) {
    selected = id;
    graph.querySelectorAll('.node').forEach(node => {
      const active = node.dataset.nodeKey === id;
      node.classList.toggle('is-focused', active); node.setAttribute('aria-pressed', String(active));
      node.classList.toggle('is-graph-focus', node.dataset.nodeKey === data?.focus);
    });
    const item = data?.nodes.find(node => node.id === id);
    document.getElementById('selected-node').textContent = item ? `${labels.selectedPrefix}: ${item.label}` : labels.selected;
    document.getElementById('selected-node').hidden = !!data?.focus && id === data.focus;
    document.getElementById('graph-node-menu').querySelector('summary').setAttribute('aria-disabled', String(!id || busy));
    document.getElementById('focus-node').textContent = `${labels.focus}: ${snapshot().search.find(node => node.id === data?.focus)?.label || labels.group}`;
    for (const button of document.querySelectorAll('.graph-selection button')) button.disabled = !id || busy || (button.dataset.action === 'open' && item?.virtual);
    if (center) locate(id);
  }
  function choose(id) { selectNode(id); send('select', { id }); }
  function setStatus(text, block = false) { status.textContent = text; status.hidden = !text; graph.classList.toggle('is-loading', block); }
  document.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', () => {
    closeMenus();
    const action = button.dataset.action;
    if (action === 'locate') return locate(selected);
    if (action === 'locateFocus') return locate(data?.focus);
    send(action, { id: selected });
  }));
  document.querySelectorAll('[data-mode]').forEach(button => button.addEventListener('click', () => send('mode', { mode: button.dataset.mode })));
  document.getElementById('graph-depth').addEventListener('change', event => { closeMenus(); send('depth', { depth: event.target.value }); });
  document.getElementById('graph-upstream').addEventListener('change', event => { closeMenus(); send('upstreamDepth', { depth: event.target.value }); });
  document.getElementById('graph-entries').addEventListener('change', event => send('group', { group: event.target.value }));
  document.getElementById('entry-previous').addEventListener('click', () => send('page', { next: false }));
  document.getElementById('entry-next').addEventListener('click', () => send('page', { next: true }));
  const search = document.getElementById('graph-search');
  function options() {
    const list = document.getElementById('graph-options'); list.replaceChildren();
    for (const node of snapshot().search.filter(node => node.label.toLowerCase().includes(search.value.toLowerCase())).slice(0, 50)) {
      const option = document.createElement('option'); option.value = node.label; list.append(option);
    }
  }
  let hiddenResult;
  document.getElementById('graph-search-focus').addEventListener('click', () => { if (hiddenResult) send('search', { id: hiddenResult }); });
  function find() {
    const node = snapshot().search.find(node => node.id === search.value || node.label === search.value);
    if (!node) return;
    if (data?.nodes.some(item => item.id === node.id)) { choose(node.id); locate(node.id); }
    else { hiddenResult = node.id; document.getElementById('graph-search-focus').hidden = false; }
  }
  search.addEventListener('input', () => { hiddenResult = undefined; document.getElementById('graph-search-focus').hidden = true; options(); });
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
    graph.classList.remove('is-grabbing'); drag = undefined; setTimeout(() => suppressClick = false, 300);
  }
  graph.addEventListener('pointerup', endDrag); graph.addEventListener('pointercancel', endDrag);
  for (const type of ['click', 'dblclick']) graph.addEventListener(type, event => { if (suppressClick || busy) { event.preventDefault(); event.stopPropagation(); } }, true);
  graph.addEventListener('keydown', event => {
    if (busy) return;
    if (['+', '=', '-'].includes(event.key)) { event.preventDefault(); zoomAt(zoom * (event.key === '-' ? 1 / 1.2 : 1.2)); }
    if (event.key === '0') { event.preventDefault(); fitGraph(); }
    if (event.key.toLowerCase() === 'c') { event.preventDefault(); locate(selected); }
    if (event.key.toLowerCase() === 'f' && selected) { event.preventDefault(); send('focus', { id: selected }); }
  });
  function controls(next) {
    document.getElementById('project-name').textContent = next.name;
    document.getElementById('graph-depth').value = next.depth;
    document.getElementById('graph-upstream').value = next.upstreamDepth || '0';
    document.querySelectorAll('[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === next.mode)));
    document.querySelector('[data-action=overview]').hidden = !next.focus;
    document.querySelector('[data-action=back]').disabled = !next.back;
    document.querySelector('[data-action=locateFocus]').disabled = !next.focus;
    if (next.nodes.some(node => node.id === hiddenResult)) { hiddenResult = undefined; document.getElementById('graph-search-focus').hidden = true; }
    const entries = document.getElementById('graph-entries'); entries.replaceChildren();
    const placeholder = document.createElement('option'); placeholder.textContent = labels.group; placeholder.value = ''; entries.append(placeholder);
    for (const group of snapshot().groups) { const option = document.createElement('option'); option.value = group.id; option.textContent = `${group.label} (${group.nodes.length})`; entries.append(option); }
    entries.value = next.group || ''; entries.hidden = !snapshot().groups.length;
    const group = snapshot().groups.find(group => group.id === next.group);
    for (const id of ['entry-previous', 'entry-page', 'entry-next']) document.getElementById(id).hidden = !group;
    document.getElementById('entry-previous').disabled = !next.offset;
    document.getElementById('entry-next').disabled = !group || (next.offset || 0) + 20 >= group.nodes.length;
    document.getElementById('entry-page').textContent = group ? `${(next.offset || 0) + 1}–${Math.min((next.offset || 0) + 20, group.nodes.length)} / ${group.nodes.length}` : '';
    document.getElementById('graph-source').textContent = next.source;
    const notice = document.getElementById('graph-notice'); notice.textContent = [next.limited ? labels.limited : '', next.truncated ? labels.partial : ''].filter(Boolean).join(' '); notice.hidden = !notice.textContent;
  }
  async function draw() {
    if (drawing || document.hidden) return;
    drawing = true;
    while (pending && !document.hidden) {
      const next = pending; pending = undefined;
      const viewChanged = currentKey !== next.viewKey;
      saveView(); currentKey = next.viewKey; data = next; controls(next);
      if (viewChanged) { search.value = ''; hiddenResult = undefined; document.getElementById('graph-search-focus').hidden = true; options(); }
      const dark = document.body.classList.contains('vscode-dark') || document.body.classList.contains('vscode-high-contrast');
      const signature = `${dark}:${next.source}`, binding = JSON.stringify([next.viewKey, next.nodes.map(node => node.id)]);
      if (committed === signature && committedBinding === binding && graph.querySelector('svg')) {
        busy = false; setStatus(''); if (next.fit) fitGraph(); selectNode(next.selected, next.center); continue;
      }
      if (!next.nodes.length) { graph.replaceChildren(); committed = undefined; setStatus(labels.empty); busy = false; selectNode(undefined); continue; }
      busy = true;
      mermaid.initialize({ startOnLoad: false, htmlLabels: false, securityLevel: 'strict', suppressErrorRendering: true, theme: dark ? 'dark' : 'default', fontFamily: 'system-ui', markdownAutoWrap: false, flowchart: { htmlLabels: false, useMaxWidth: true, wrappingWidth: 1000, nodeSpacing: 30, rankSpacing: 90, padding: 18 }, maxEdges: 310 });
      try {
        const layoutStarted = performance.now(), cached = layouts.has(signature);
        const markup = layouts.get(signature) || (await mermaid.render(`dependency-svg-${++renderId}`, next.source)).svg;
        if (pending || data !== next) continue;
        if (next.debug) console.debug('mcpp graph', { ...next.debug, cacheHit: cached, layoutMs: performance.now() - layoutStarted });
        layouts.delete(signature); layouts.set(signature, markup); trim(layouts);
        graph.innerHTML = markup; committed = signature; committedBinding = binding; const svg = graph.querySelector('svg');
        baseWidth = svg.viewBox.baseVal.width; baseHeight = svg.viewBox.baseVal.height; svg.style.width = baseWidth + 'px'; svg.style.maxWidth = 'none';
        const saved = views.get(cameraKey(next));
        if (!saved || next.fit) fitGraph(); else { ({ zoom, panX, panY } = saved); applyView(); }
        graph.querySelectorAll('.node').forEach(node => {
          const match = /flowchart-(n[0-9]+)-/.exec(node.id); if (!match) return;
          const item = next.nodes[Number(match[1].slice(1))]; if (!item) return;
          node.dataset.nodeKey = item.id; node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button'); node.setAttribute('aria-label', node.textContent);
          node.querySelectorAll('rect').forEach(rect => { rect.setAttribute('rx', '8'); rect.setAttribute('ry', '8'); });
          node.addEventListener('click', () => choose(item.id));
          node.addEventListener('dblclick', () => { choose(item.id); send(item.virtual ? 'focus' : 'open', { id: item.id }); });
          node.addEventListener('keydown', event => {
            if (event.target !== node) return;
            if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(item.id); if (event.key === 'Enter') send(item.virtual ? 'focus' : 'open', { id: item.id }); }
          });
          if (item.hidden) {
            const line = node.querySelector('text')?.lastElementChild;
            if (line) {
              line.classList.add('fold-control'); line.setAttribute('role', 'button'); line.setAttribute('tabindex', '0'); line.setAttribute('aria-label', labels.expand + ': ' + item.hidden);
              const expand = event => { event.preventDefault(); event.stopPropagation(); choose(item.id); send('expand', { id: item.id }); };
              line.addEventListener('click', expand); line.addEventListener('dblclick', event => event.stopPropagation());
              line.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') expand(event); });
            }
          }
        });
        busy = false; setStatus(''); selectNode(next.selected, next.center); saveView();
      } catch { busy = false; committed = undefined; graph.replaceChildren(); setStatus(labels.error); }
    }
    drawing = false;
  }
  async function exportGraph(format) {
    if (busy || !committed) return;
    const original = graph.querySelector('svg'); if (!original) return;
    const fixedData = data, clone = original.cloneNode(true), sourceNodes = [original, ...original.querySelectorAll('*')], targetNodes = [clone, ...clone.querySelectorAll('*')];
    const properties = ['fill','stroke','stroke-width','stroke-dasharray','opacity','font-family','font-size','font-weight','text-anchor','dominant-baseline','marker-end','marker-start','paint-order'];
    sourceNodes.forEach((node, index) => {
      const style = getComputedStyle(node), target = targetNodes[index]; target.removeAttribute('style'); target.removeAttribute('class');
      for (const property of properties) {
        const value = style.getPropertyValue(property).replace(/url\(["']?[^)#]*#([^)'" ]+)["']?\)/g, 'url(#$1)');
        if (value) target.style.setProperty(property, value);
      }
      for (const attribute of [...target.attributes]) if (/^on|^data-|^tabindex$|^role$|^aria-/.test(attribute.name)) target.removeAttribute(attribute.name);
    });
    clone.querySelectorAll('style,script,foreignObject').forEach(node => node.remove());
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg'); clone.setAttribute('width', String(baseWidth)); clone.setAttribute('height', String(baseHeight));
    const background = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    const box = original.viewBox.baseVal; background.setAttribute('x', box.x); background.setAttribute('y', box.y); background.setAttribute('width', box.width); background.setAttribute('height', box.height); background.setAttribute('fill', getComputedStyle(document.body).backgroundColor || '#fff'); clone.insertBefore(background, clone.firstChild);
    const description = document.createElementNS('http://www.w3.org/2000/svg', 'desc'); description.textContent = [fixedData.name, fixedData.limited ? labels.limited : '', fixedData.truncated ? labels.partial : ''].filter(Boolean).join(' · '); clone.prepend(description);
    const svgText = new XMLSerializer().serializeToString(clone);
    const deliver = payload => vscode.postMessage({ type: 'action', action: 'export', viewKey: fixedData.viewKey, format, data: payload });
    if (format === 'svg') return deliver(svgText);
    let url;
    try {
      const ratio = Math.min(2, 8192 / baseWidth, 8192 / baseHeight, Math.sqrt(16000000 / (baseWidth * baseHeight)));
      const canvas = document.createElement('canvas'); canvas.width = Math.max(1, Math.floor(baseWidth * ratio)); canvas.height = Math.max(1, Math.floor(baseHeight * ratio));
      url = URL.createObjectURL(new Blob([svgText], { type: 'image/svg+xml' }));
      const img = new Image(); img.src = url; await img.decode(); canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      const png = canvas.toDataURL('image/png').split(',')[1]; canvas.width = canvas.height = 0;
      deliver(png);
    } catch { setStatus(labels.exportError); } finally { if (url) URL.revokeObjectURL(url); }
  }
  document.querySelectorAll('[data-export]').forEach(button => button.addEventListener('click', () => { closeMenus(); void exportGraph(button.dataset.export); }));
  window.addEventListener('message', event => {
    const message = event.data;
    if (message.type === 'snapshot') { snapshots.delete(message.viewKey); snapshots.set(message.viewKey, message); trim(snapshots); if (message.viewKey === currentKey) options(); }
    if (message.type === 'graph') { pending = message; void draw(); }
    if (message.type === 'loading') {
      saveView(); currentKey = message.viewKey; committed = undefined; baseWidth = 0; data = undefined; pending = undefined; busy = true;
      document.getElementById('project-name').textContent = message.name;
      search.value = ''; selectNode(undefined); setStatus(labels.loading, true);
    }
    if (message.type === 'error') { busy = false; setStatus(message.error, !data); }
    if (message.type === 'copied') { const feedback = document.getElementById('feedback'); feedback.textContent = labels.copied; setTimeout(() => feedback.textContent = '', 1800); }
  });
  new MutationObserver(() => { if (data) { pending = data; void draw(); } }).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void draw(); });
  window.addEventListener('resize', applyView);
  selectNode(undefined); setStatus(labels.loading, true); vscode.postMessage({ type: 'ready' });
})();
