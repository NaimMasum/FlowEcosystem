/* ============================================================
   NOTEBOARD — app.js
   Infinite canvas engine, pointer interactions, WebSocket sync.
   ============================================================ */

'use strict';

// ── DOM refs ─────────────────────────────────────────────────
const viewport   = document.getElementById('viewport');
const world      = document.getElementById('world');
const statusEl   = document.getElementById('status-indicator');
const statusDot  = statusEl.querySelector('.status-dot');
const statusText = statusEl.querySelector('.status-text');
const toastEl    = document.getElementById('toast');

// ── Board state ───────────────────────────────────────────────
let elements    = {};          // id → element object
let elementNodes = new Map();  // id → DOM node

// ── Viewport transform ────────────────────────────────────────
let panX = 0, panY = 0, zoom = 1;

// ── Tool ──────────────────────────────────────────────────────
let activeTool = 'select';

// ── Selection ─────────────────────────────────────────────────
let selectedIds = new Set();

// ── Pointer state ─────────────────────────────────────────────
const activePointers = new Map(); // pointerId → {clientX, clientY}

let isDraggingCanvas   = false;
let isDraggingElement  = false;
let isResizing         = false;
let isDragSelecting    = false;
let isSpaceHeld        = false;

let canvasDragStartClientX = 0;
let canvasDragStartClientY = 0;
let canvasDragStartPanX    = 0;
let canvasDragStartPanY    = 0;

let dragWorldStartX = 0; // world coords at drag-start
let dragWorldStartY = 0;
let dragElementSnaps = []; // snapshots of element positions when drag started

// Drag threshold — prevent micro-movements (e.g. from double-click) from moving elements
const DRAG_THRESHOLD   = 5;   // pixels before drag activates
let dragStartClientX   = 0;
let dragStartClientY   = 0;
let dragThresholdMet   = false;
// Track double-clicks so the second click doesn't accidentally start a drag
let lastDblClickTime   = 0;

// Registry of shape text-editor enter functions keyed by element id
// Populated by buildShapeContent; lets the keyboard handler trigger edit mode
const shapeTextEditors = new Map(); // id → enterShapeEdit()

let resizeHandleType = null; // 'nw' | 'ne' | 'se' | 'sw' | 'start' | 'end'

// Selection-box marquee
let marqueeEl    = null;
let marqueeStart = { x: 0, y: 0 }; // client coords

// Pinch-zoom state
let prevPinchDist = null;
let prevPinchMidX = null;
let prevPinchMidY = null;

// ── WebSocket ─────────────────────────────────────────────────
let ws              = null;
let reconnectDelay  = 1000;
const MAX_RECONNECT = 16000;

// ── Shape colour maps ─────────────────────────────────────────
const SHAPE_COLORS = {
  blueprint: { stroke: '#2563eb', fill: 'rgba(37,99,235,0.10)' },
  charcoal:  { stroke: '#334155', fill: 'rgba(51,65,85,0.10)'  },
  yellow:    { stroke: '#ca8a04', fill: 'rgba(250,204,21,0.12)' },
  blue:      { stroke: '#2563eb', fill: 'rgba(37,99,235,0.10)' },
  green:     { stroke: '#16a34a', fill: 'rgba(22,163,74,0.10)' },
  pink:      { stroke: '#db2777', fill: 'rgba(219,39,119,0.10)'},
  purple:    { stroke: '#9333ea', fill: 'rgba(147,51,234,0.10)'},
  orange:    { stroke: '#ea580c', fill: 'rgba(234,88,12,0.10)' },
};

// ─────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────
function init() {
  // Centre the canvas initially (world 0,0 → viewport centre)
  const r = viewport.getBoundingClientRect();
  panX = r.width  / 2;
  panY = r.height / 2;
  applyTransform();

  connectWebSocket();
  setupCanvasPointers();
  setupWheel();
  setupKeyboard();
  setupToolbar();
  setupModals();

  window.addEventListener('resize', applyTransform);
}

// ─────────────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────────────
function connectWebSocket() {
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    setStatus('connected');
    reconnectDelay = 1000;
  };

  ws.onmessage = ({ data }) => {
    try { handleServerMsg(JSON.parse(data)); }
    catch (e) { console.error('WS parse error', e); }
  };

  ws.onclose = () => {
    setStatus('disconnected');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
      connectWebSocket();
    }, reconnectDelay);
  };

  ws.onerror = () => ws.close();
}

function sendOp(type, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type, ...payload }));
  }
}

function setStatus(state) {
  statusEl.className = `status-indicator ${state}`;
  statusText.textContent =
    state === 'connected'    ? 'Connected'     :
    state === 'connecting'   ? 'Connecting…'   : 'Disconnected';
}

// ─────────────────────────────────────────────────────────────
// SERVER MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────
function handleServerMsg(msg) {
  switch (msg.type) {
    case 'init': {
      clearAllNodes();
      elements = msg.elements || {};
      for (const el of Object.values(elements)) {
        fixBBox(el);
        mountElement(el);
      }
      break;
    }
    case 'add': {
      const el = msg.element;
      elements[el.id] = el;
      fixBBox(el);
      mountElement(el, true); // true = animate
      break;
    }
    case 'update': {
      const el = msg.element;
      if (!elements[el.id]) return;
      Object.assign(elements[el.id], el);
      fixBBox(elements[el.id]);
      syncNode(elements[el.id]);
      break;
    }
    case 'delete': {
      dropNode(msg.id);
      delete elements[msg.id];
      selectedIds.delete(msg.id);
      syncSelectionUI();
      break;
    }
    case 'deleteMultiple': {
      (msg.ids || []).forEach(id => {
        dropNode(id);
        delete elements[id];
        selectedIds.delete(id);
      });
      syncSelectionUI();
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// CANVAS TRANSFORM
// ─────────────────────────────────────────────────────────────
function applyTransform() {
  world.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
}

function clientToWorld(cx, cy) {
  const r = viewport.getBoundingClientRect();
  return {
    x: (cx - r.left - panX) / zoom,
    y: (cy - r.top  - panY) / zoom,
  };
}

// ─────────────────────────────────────────────────────────────
// BOUNDING BOX (lines / arrows store x1,y1,x2,y2)
// ─────────────────────────────────────────────────────────────
function fixBBox(el) {
  if (el.type === 'line' || el.type === 'arrow') {
    el.x = Math.min(el.x1, el.x2);
    el.y = Math.min(el.y1, el.y2);
    el.w = Math.max(20, Math.abs(el.x2 - el.x1));
    el.h = Math.max(20, Math.abs(el.y2 - el.y1));
  }
}

// ─────────────────────────────────────────────────────────────
// ELEMENT DOM — CREATE / UPDATE / DELETE
// ─────────────────────────────────────────────────────────────
function mountElement(el, animate = false) {
  // Remove stale node if present
  const old = elementNodes.get(el.id);
  if (old) old.remove();

  const node = buildNode(el, animate);
  world.appendChild(node);
  elementNodes.set(el.id, node);
  syncNodePos(node, el);
}

/** Build the DOM node for an element (does not insert it). */
function buildNode(el, animate) {
  const node = document.createElement('div');
  node.id = el.id;
  node.dataset.eid = el.id;

  if (!animate) node.style.animation = 'none';

  // Pointer handler — select + drag
  node.addEventListener('pointerdown', e => onElementPointerDown(e, el.id));

  if (el.type === 'note') {
    buildNoteContent(node, el);
  } else if (el.type === 'image') {
    buildImageContent(node, el);
  } else if (el.type === 'file') {
    buildFileContent(node, el);
  } else {
    buildShapeContent(node, el);
  }

  syncNodeClass(node, el);
  return node;
}

function buildNoteContent(node, el) {
  // ── Font-size controls ───────────────────────────────
  const header = document.createElement('div');
  header.className = 'note-header';

  const btnSmaller = document.createElement('button');
  btnSmaller.className = 'note-font-btn';
  btnSmaller.textContent = 'A−';
  btnSmaller.title = 'Smaller text';

  const btnLarger = document.createElement('button');
  btnLarger.className = 'note-font-btn';
  btnLarger.textContent = 'A+';
  btnLarger.title = 'Larger text';

  const updateFontSize = () => {
    const stored = elements[el.id];
    if (!stored) return;
    node.style.setProperty('--note-font-size', `${stored.fontSize || 14}px`);
  };

  btnSmaller.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const stored = elements[el.id];
    if (!stored) return;
    stored.fontSize = Math.max(10, (stored.fontSize || 14) - 2);
    updateFontSize();
    sendOp('update', { element: stored });
  });

  btnLarger.addEventListener('pointerdown', e => {
    e.stopPropagation();
    const stored = elements[el.id];
    if (!stored) return;
    stored.fontSize = Math.min(32, (stored.fontSize || 14) + 2);
    updateFontSize();
    sendOp('update', { element: stored });
  });

  header.appendChild(btnSmaller);
  header.appendChild(btnLarger);
  node.appendChild(header);

  // Apply saved font size immediately
  if (el.fontSize) node.style.setProperty('--note-font-size', `${el.fontSize}px`);

  // ── Text body wrapper ────────────────────────────────
  const body = document.createElement('div');
  body.className = 'note-body';
  body.dataset.placeholder = 'Click to write…';

  const ta = document.createElement('textarea');
  ta.className = 'note-text';
  ta.readOnly   = true;
  ta.value      = el.text || '';

  // Update placeholder-visibility class
  const syncPlaceholder = () => {
    body.classList.toggle('has-content', ta.value.trim().length > 0);
  };
  syncPlaceholder();

  // Auto-grow height to fit content
  const autoGrow = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  };

  // ── Single-click to start editing ─────────────────────
  ta.addEventListener('pointerdown', e => {
    if (!ta.readOnly) {
      // Already editing — just let the cursor land normally
      e.stopPropagation();
      return;
    }
    // Single click: stop drag propagation, enter edit mode
    e.stopPropagation();
  });

  ta.addEventListener('click', e => {
    e.stopPropagation();
    if (ta.readOnly) {
      enterEditMode();
    }
  });

  function enterEditMode() {
    ta.readOnly = false;
    ta.focus();
    // Move caret to end
    ta.setSelectionRange(ta.value.length, ta.value.length);
    body.classList.add('editing');
    node.classList.add('editing-mode');
    autoGrow();
  }

  function exitEditMode() {
    ta.readOnly = true;
    body.classList.remove('editing');
    node.classList.remove('editing-mode');
    ta.style.height = ''; // let flex handle it again
    const stored = elements[el.id];
    if (stored && ta.value !== stored.text) {
      stored.text = ta.value;
      sendOp('update', { element: stored });
    }
    syncPlaceholder();
  }

  // Double-tap on mobile
  let lastTap = 0;
  ta.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTap < 320) {
      e.preventDefault();
      if (ta.readOnly) enterEditMode();
    }
    lastTap = now;
  });

  ta.addEventListener('blur', exitEditMode);

  ta.addEventListener('input', () => {
    if (elements[el.id]) elements[el.id].text = ta.value;
    syncPlaceholder();
    autoGrow();
  });

  // Escape key exits editing
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      ta.blur();
    }
  });

  body.appendChild(ta);
  node.appendChild(body);
}

function buildImageContent(node, el) {
  const img = document.createElement('img');
  img.src = el.url || '';
  img.alt = 'board image';
  img.draggable = false;
  node.appendChild(img);
}

function buildFileContent(node, el) {
  node.classList.add('file-element');
  const inner = document.createElement('div');
  inner.className = 'file-inner';
  
  const icon = document.createElement('div');
  icon.className = 'file-icon';
  icon.innerHTML = '📄';
  
  const name = document.createElement('div');
  name.className = 'file-name';
  name.textContent = el.fileName || 'Attachment';
  
  const dl = document.createElement('a');
  dl.className = 'file-download';
  dl.href = el.url ? `${el.url}?v=${Date.now()}` : '#';
  dl.target = '_blank';
  dl.title = 'Open file';
  dl.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
  
  // Prevent pointerdown from grabbing the board element so the native click works
  dl.addEventListener('pointerdown', e => e.stopPropagation());

  inner.appendChild(icon);
  inner.appendChild(name);

  if ((el.fileName || '').toLowerCase().endsWith('.pdf')) {
    const annotateBtn = document.createElement('a');
    annotateBtn.className = 'file-download';
    annotateBtn.title = 'Annotate PDF (Official PDF.js)';
    annotateBtn.innerHTML = '<span style="font-size: 16px;">🖊️</span>';
    annotateBtn.target = '_blank';
    const absoluteUrl = new URL(el.url, window.location.origin).href;
    const cacheBusterUrl = `${absoluteUrl}?v=${Date.now()}`;
    annotateBtn.href = `http://${window.location.hostname}:4040/web/viewer.html?file=${encodeURIComponent(cacheBusterUrl)}`;
    annotateBtn.addEventListener('pointerdown', e => e.stopPropagation());
    inner.appendChild(annotateBtn);
  }

  inner.appendChild(dl);
  node.appendChild(inner);
}

function buildShapeContent(node, el) {
  // ── SVG layer (the actual drawn shape) ───────────────
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  node.appendChild(svg);
  syncNodeSVG(node, el);

  // ── Text overlay ─────────────────────────────────────
  const wrap = document.createElement('div');
  wrap.className = 'shape-text-wrap';

  // Read-only display div (always on top of SVG, pointer-events:none so drag still works)
  const view = document.createElement('div');
  view.className = 'shape-text-view';
  view.textContent = el.text || '';
  if (!(el.text || '').trim()) view.classList.add('empty');

  // Edit textarea (hidden until dblclick)
  const ta = document.createElement('textarea');
  ta.className = 'shape-text-ta';
  ta.value      = el.text || '';
  ta.placeholder = 'Type here…';

  // ── Edit mode helpers ─────────────────────────────────
  function enterShapeEdit() {
    const stored = elements[el.id];
    ta.value = stored?.text || '';
    ta.style.display = 'block';
    view.style.display = 'none';
    wrap.classList.add('editing');
    node.classList.add('shape-editing');
    ta.focus();
    ta.select();
  }

  function exitShapeEdit() {
    ta.style.display = 'none';
    view.style.display = '';
    wrap.classList.remove('editing');
    node.classList.remove('shape-editing');

    const stored = elements[el.id];
    if (!stored) return;
    const newText = ta.value;
    view.textContent = newText;
    view.classList.toggle('empty', !newText.trim());
    if (newText !== stored.text) {
      stored.text = newText;
      sendOp('update', { element: stored });
    }
  }

  // ── Event listeners ────────────────────────────────────
  // Prevent drag starting when clicking inside the edit textarea
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  // Keep local state in sync while typing
  ta.addEventListener('input', () => {
    if (elements[el.id]) elements[el.id].text = ta.value;
  });
  // Exit edit on blur
  ta.addEventListener('blur', exitShapeEdit);
  // Escape exits; block Delete/Backspace from propagating (would delete the element)
  ta.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); ta.blur(); }
    e.stopPropagation();
  });

  // Register this shape's enter fn so the keyboard handler can call it with Spacebar
  shapeTextEditors.set(el.id, enterShapeEdit);

  // Mobile only: double-tap to enter edit (no physical keyboard available)
  let lastTap = 0;
  node.addEventListener('touchend', e => {
    const now = Date.now();
    if (now - lastTap < 320 && !wrap.classList.contains('editing')) {
      e.preventDefault();
      enterShapeEdit();
    }
    lastTap = now;
  });

  wrap.appendChild(view);
  wrap.appendChild(ta);
  node.appendChild(wrap);
}

/** Re-sync everything visual on a node that already exists. */
function syncNode(el) {
  let node = elementNodes.get(el.id);
  if (!node) { mountElement(el); return; }

  syncNodeClass(node, el);
  syncNodePos(node, el);

  if (el.type === 'note') {
    const ta = node.querySelector('textarea');
    if (ta && ta.readOnly) {
      ta.value = el.text || '';
      const body = node.querySelector('.note-body');
      if (body) body.classList.toggle('has-content', (el.text || '').trim().length > 0);
    }
    // Sync font size from remote
    if (el.fontSize) node.style.setProperty('--note-font-size', `${el.fontSize}px`);
  } else if (el.type === 'image') {
    const img = node.querySelector('img');
    if (img) img.src = el.url || '';
  } else {
    syncNodeSVG(node, el);
    // Sync shape text from remote peer update
    const view = node.querySelector('.shape-text-view');
    if (view) {
      view.textContent = el.text || '';
      view.classList.toggle('empty', !(el.text || '').trim());
    }
    const shapeTa = node.querySelector('.shape-text-ta');
    if (shapeTa && shapeTa.style.display !== 'block') {
      shapeTa.value = el.text || '';
    }
  }

  // Refresh handles if selected
  refreshHandles(node, el);
}

function syncNodeClass(node, el) {
  const color = el.color || 'yellow';
  node.className = `board-element ${el.type}-element ${color}`;
  if (selectedIds.has(el.id)) node.classList.add('selected');
}

function syncNodePos(node, el) {
  node.style.left   = `${el.x}px`;
  node.style.top    = `${el.y}px`;
  node.style.width  = `${el.w}px`;
  node.style.height = `${el.h}px`;
  node.style.zIndex = el.zIndex || 10;
}

function syncNodeSVG(node, el) {
  const svg = node.querySelector('svg');
  if (!svg) return;
  svg.innerHTML = '';

  const c = SHAPE_COLORS[el.color] || SHAPE_COLORS.blueprint;

  if (el.type === 'rect') {
    const r = mkSVG('rect');
    r.setAttribute('x', '3'); r.setAttribute('y', '3');
    r.setAttribute('width',  `${Math.max(0, el.w - 6)}`);
    r.setAttribute('height', `${Math.max(0, el.h - 6)}`);
    r.setAttribute('rx', '5');
    r.setAttribute('stroke', c.stroke); r.setAttribute('stroke-width', '2.5');
    r.setAttribute('fill', c.fill);
    svg.appendChild(r);
  }
  else if (el.type === 'ellipse') {
    const e2 = mkSVG('ellipse');
    e2.setAttribute('cx', `${el.w / 2}`);
    e2.setAttribute('cy', `${el.h / 2}`);
    e2.setAttribute('rx', `${Math.max(1, el.w / 2 - 3)}`);
    e2.setAttribute('ry', `${Math.max(1, el.h / 2 - 3)}`);
    e2.setAttribute('stroke', c.stroke); e2.setAttribute('stroke-width', '2.5');
    e2.setAttribute('fill', c.fill);
    svg.appendChild(e2);
  }
  else if (el.type === 'line' || el.type === 'arrow') {
    // Local coords: offset from el.x, el.y
    const lx1 = el.x1 - el.x, ly1 = el.y1 - el.y;
    const lx2 = el.x2 - el.x, ly2 = el.y2 - el.y;

    if (el.type === 'arrow') {
      const mid = `arrow-${el.id}`;
      const defs = mkSVG('defs');
      defs.innerHTML = `<marker id="${mid}" markerWidth="9" markerHeight="7"
        refX="7" refY="3.5" orient="auto" markerUnits="strokeWidth">
        <polygon points="0 0, 9 3.5, 0 7" fill="${c.stroke}"/>
      </marker>`;
      svg.appendChild(defs);
      const line = mkSVG('line');
      setLineAttrs(line, lx1, ly1, lx2, ly2, c.stroke);
      line.setAttribute('marker-end', `url(#${mid})`);
      // Shorten the line slightly so arrowhead doesn't overlap endpoint
      svg.appendChild(line);
    } else {
      const line = mkSVG('line');
      setLineAttrs(line, lx1, ly1, lx2, ly2, c.stroke);
      svg.appendChild(line);
    }
  }
}

function setLineAttrs(line, x1, y1, x2, y2, stroke) {
  line.setAttribute('x1', x1); line.setAttribute('y1', y1);
  line.setAttribute('x2', x2); line.setAttribute('y2', y2);
  line.setAttribute('stroke', stroke);
  line.setAttribute('stroke-width', '2.5');
  line.setAttribute('stroke-linecap', 'round');
}

function mkSVG(tag) {
  return document.createElementNS('http://www.w3.org/2000/svg', tag);
}

function clearAllNodes() {
  elementNodes.forEach(n => n.remove());
  elementNodes.clear();
}

function dropNode(id) {
  const n = elementNodes.get(id);
  if (n) { n.remove(); elementNodes.delete(id); }
  shapeTextEditors.delete(id); // clean up editor registry
}

// ─────────────────────────────────────────────────────────────
// SELECTION HANDLES
// ─────────────────────────────────────────────────────────────
function refreshHandles(node, el) {
  node.querySelectorAll('.resize-handle').forEach(h => h.remove());
  if (!selectedIds.has(el.id)) return;

  if (el.type === 'line' || el.type === 'arrow') {
    addHandle(node, el, 'start', el.x1 - el.x, el.y1 - el.y);
    addHandle(node, el, 'end',   el.x2 - el.x, el.y2 - el.y);
  } else {
    [['nw', '0%', '0%'], ['ne', '100%', '0%'], ['se', '100%', '100%'], ['sw', '0%', '100%']]
      .forEach(([name, left, top]) => {
        const h = addHandle(node, el, name);
        h.style.left = left;
        h.style.top = top;
      });
  }
}

function addHandle(node, el, name, left, top) {
  const h = document.createElement('div');
  h.className = `resize-handle ${name}`;
  if (left !== undefined) { 
    h.style.left = typeof left === 'number' ? `${left}px` : left; 
    h.style.top = typeof top === 'number' ? `${top}px` : top; 
  }
  h.addEventListener('pointerdown', e => onHandlePointerDown(e, el.id, name));
  node.appendChild(h);
  return h;
}

// ─────────────────────────────────────────────────────────────
// SELECT / DESELECT
// ─────────────────────────────────────────────────────────────
function select(id, additive = false) {
  if (!additive) {
    selectedIds.forEach(old => {
      if (old !== id && elements[old]) syncNode(elements[old]);
    });
    selectedIds.clear();
  }
  if (id) {
    selectedIds.add(id);
    if (elements[id]) syncNode(elements[id]);
  }
  syncSelectionUI();
}

function deselect() {
  const prev = new Set(selectedIds);
  selectedIds.clear();
  prev.forEach(id => { if (elements[id]) syncNode(elements[id]); });
  syncSelectionUI();
}

function syncSelectionUI() {
  const has = selectedIds.size > 0;

  // Desktop panel
  const panel = document.getElementById('desktop-selection-actions');
  if (panel) panel.style.display = has ? 'flex' : 'none';

  // Mobile drawer
  const drawer = document.getElementById('mobile-selection-drawer');
  if (drawer) drawer.style.display = has ? 'flex' : 'none';

  // Toggle edit button visibility
  const editBtn = document.getElementById('mobile-edit-btn');
  if (editBtn) {
    if (selectedIds.size === 1) {
      const el = elements[Array.from(selectedIds)[0]];
      editBtn.style.display = (el && el.type !== 'image') ? 'flex' : 'none';
    } else {
      editBtn.style.display = 'none';
    }
  }

  // Sync active color swatch
  if (has) {
    const firstEl = elements[Array.from(selectedIds)[0]];
    if (firstEl) markActiveSwatch(firstEl.color || 'yellow');
  }
}

function markActiveSwatch(color) {
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.classList.toggle('active', sw.dataset.color === color);
  });
}

// ─────────────────────────────────────────────────────────────
// CANVAS POINTER EVENTS
// ─────────────────────────────────────────────────────────────
function setupCanvasPointers() {
  viewport.addEventListener('pointerdown',   onCanvasDown);
  viewport.addEventListener('pointermove',   onCanvasMove);
  viewport.addEventListener('pointerup',     onCanvasUp);
  viewport.addEventListener('pointercancel', onCanvasUp);

  // ── Drag image files directly onto the canvas ──────────
  viewport.addEventListener('dragenter', e => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      viewport.classList.add('drop-target');
    }
  });

  viewport.addEventListener('dragover', e => {
    if ([...e.dataTransfer.types].includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
  });

  viewport.addEventListener('dragleave', e => {
    // Only clear when truly leaving the viewport (not entering a child)
    if (!viewport.contains(e.relatedTarget)) {
      viewport.classList.remove('drop-target');
    }
  });

  viewport.addEventListener('drop', e => {
    e.preventDefault();
    viewport.classList.remove('drop-target');

    const file = e.dataTransfer.files[0];
    if (file) {
      const dropPos = clientToWorld(e.clientX, e.clientY);
      uploadAndPlaceFile(file, dropPos.x, dropPos.y);
      return;
    }

    // Fallback: dropped URL text
    const url = e.dataTransfer.getData('text/plain')?.trim();
    if (url) {
      const dropPos = clientToWorld(e.clientX, e.clientY);
      placeImageAt(url, dropPos.x, dropPos.y);
    }
  });

  // ── Ctrl+V paste file/image anywhere on canvas ──────────────
  document.addEventListener('paste', e => {
    // If the modal is open, its own paste handler takes care of it
    const modal = document.getElementById('image-modal');
    if (modal?.classList.contains('open')) return;
    // Ignore if focus is on an input/textarea
    if (document.activeElement?.tagName === 'TEXTAREA') return;
    if (document.activeElement?.tagName === 'INPUT')    return;

    const items = [...(e.clipboardData?.items || [])];
    const fileItem = items.find(i => i.kind === 'file');
    if (!fileItem) return;

    e.preventDefault();
    const blob = fileItem.getAsFile();
    // Place at canvas centre
    const r  = viewport.getBoundingClientRect();
    const cp = clientToWorld(r.width / 2, r.height / 2);
    uploadAndPlaceFile(blob, cp.x, cp.y);
  });
}

// ── Helper: upload File → Server → place on board ─────────────
function uploadAndPlaceFile(file, cx, cy) {
  if (file.size > 20 * 1024 * 1024) {
    showToast('❌ File too large (max 20 MB)');
    return;
  }
  showToast('⏳ Uploading...');
  const reader = new FileReader();
  reader.onload = async ev => {
    try {
      const res = await fetch('/upload', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name || 'PastedFile', fileData: ev.target.result })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      const isImage = file.type.startsWith('image/');
      if (isImage) {
        placeImageAt(data.url, cx, cy);
      } else {
        placeFileAt(data.url, file.name || 'File', cx, cy);
      }
      showToast('✅ Upload complete');
    } catch (e) {
      console.error(e);
      showToast('❌ Upload failed');
    }
  };
  reader.onerror = () => showToast('❌ Could not read file locally');
  reader.readAsDataURL(file);
}

// ── Helper: probe URL/dataURL dimensions → add element ─────────
function placeImageAt(url, cx, cy, presetW = null, presetH = null) {
  const doPlace = (natW, natH) => {
    const MAX = 520;
    let w = natW || 320;
    let h = natH || 240;
    const ratio = w / h;
    if (w > MAX) { w = MAX; h = w / ratio; }
    if (h > MAX) { h = MAX; w = h * ratio; }

    const id = 'e' + Math.random().toString(36).slice(2, 11);
    const el = {
      id, type: 'image', url,
      ratio, x: cx - w / 2, y: cy - h / 2,
      w, h, zIndex: nextZ(),
    };
    elements[id] = el;
    mountElement(el, true);
    select(id, false);
    sendOp('add', { element: el });
  };

  if (presetW && presetH) {
    doPlace(presetW, presetH);
  } else {
    const img = new Image();
    img.onload = () => doPlace(img.naturalWidth, img.naturalHeight);
    img.onerror = () => showToast('❌ Could not load image');
    img.src = url;
  }
}

function onCanvasDown(e) {
  // Skip if the click originated on a UI panel (toolbar / modal buttons)
  if (e.target.closest('.desktop-toolbar, .mobile-toolbar, .modal, .status-indicator')) return;

  // Skip the second press of a double-click — it would interfere with dblclick handlers
  if (e.detail >= 2) return;

  viewport.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

  // ── Two-finger pinch start ──────────────────────────────
  if (activePointers.size === 2) {
    isDraggingCanvas  = false;
    isDraggingElement = false;
    isDragSelecting   = false;
    const pts = [...activePointers.values()];
    const dx  = pts[1].clientX - pts[0].clientX;
    const dy  = pts[1].clientY - pts[0].clientY;
    prevPinchDist = Math.hypot(dx, dy);
    prevPinchMidX = (pts[0].clientX + pts[1].clientX) / 2;
    prevPinchMidY = (pts[0].clientY + pts[1].clientY) / 2;
    return;
  }

  // ── Element or resize handle click passthrough ──────────
  // These are handled by onElementPointerDown / onHandlePointerDown
  // which call e.stopPropagation(), so we only reach here for canvas clicks.

  // ── Non-select tools → create element ──────────────────
  if (activeTool !== 'select') {
    const wp = clientToWorld(e.clientX, e.clientY);
    createElement(activeTool, wp.x, wp.y);
    setActiveTool('select');
    return;
  }

  // ── Spacebar panning ────────────────────────────────────
  if (isSpaceHeld) {
    isDraggingCanvas = true;
    canvasDragStartClientX = e.clientX;
    canvasDragStartClientY = e.clientY;
    canvasDragStartPanX    = panX;
    canvasDragStartPanY    = panY;
    return;
  }

  // ── Click on empty canvas → deselect ───────────────────
  if (e.target === world || e.target === viewport) {
    deselect();
  }

  // ── Shift-drag → marquee selection ─────────────────────
  if (e.shiftKey && e.button === 0) {
    isDragSelecting = true;
    marqueeStart    = { x: e.clientX, y: e.clientY };
    createMarquee();
    return;
  }

  // ── Normal canvas pan ───────────────────────────────────
  if (e.target === world || e.target === viewport) {
    isDraggingCanvas = true;
    canvasDragStartClientX = e.clientX;
    canvasDragStartClientY = e.clientY;
    canvasDragStartPanX    = panX;
    canvasDragStartPanY    = panY;
  }
}

function onCanvasMove(e) {
  if (!activePointers.has(e.pointerId)) return;
  activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });

  // ── Pinch gesture ───────────────────────────────────────
  if (activePointers.size === 2) {
    const pts  = [...activePointers.values()];
    const dx   = pts[1].clientX - pts[0].clientX;
    const dy   = pts[1].clientY - pts[0].clientY;
    const dist = Math.hypot(dx, dy);
    const midX = (pts[0].clientX + pts[1].clientX) / 2;
    const midY = (pts[0].clientY + pts[1].clientY) / 2;

    if (prevPinchDist) {
      const ratio = dist / prevPinchDist;
      let nz = Math.min(10, Math.max(0.08, zoom * ratio));
      panX = midX - (midX - panX) * (nz / zoom);
      panY = midY - (midY - panY) * (nz / zoom);
      panX += midX - prevPinchMidX;
      panY += midY - prevPinchMidY;
      zoom = nz;
      applyTransform();
    }
    prevPinchDist = dist;
    prevPinchMidX = midX;
    prevPinchMidY = midY;
    return;
  }

  const wp = clientToWorld(e.clientX, e.clientY);

  // ── Element resize ──────────────────────────────────────
  if (isResizing && dragElementSnaps.length === 1) {
    const snap = dragElementSnaps[0];
    const el   = elements[snap.id];
    if (!el) return;

    resizeLockRatio = e.shiftKey; // Shift = lock aspect ratio for images
    const dxW = wp.x - dragWorldStartX;
    const dyW = wp.y - dragWorldStartY;
    applyResize(el, snap, resizeHandleType, dxW, dyW);
    fixBBox(el);
    syncNode(el);
    sendOp('update', { element: el });

    // Update bound arrows for resized shape
    if (el.type !== 'line' && el.type !== 'arrow') {
      Object.values(elements).forEach(link => {
        if ((link.type === 'line' || link.type === 'arrow') && (link.startBind === el.id || link.endBind === el.id)) {
          if (link.startBind === el.id) { link.x1 = el.x + el.w/2; link.y1 = el.y + el.h/2; }
          if (link.endBind === el.id) { link.x2 = el.x + el.w/2; link.y2 = el.y + el.h/2; }
          fixBBox(link);
          syncNode(link);
          sendOp('update', { element: link });
        }
      });
    }

    return;
  }

  // ── Element drag ────────────────────────────────────────
  if (isDraggingElement) {
    // Enforce drag threshold — don't move until pointer travels DRAG_THRESHOLD px
    if (!dragThresholdMet) {
      const clientDx = e.clientX - dragStartClientX;
      const clientDy = e.clientY - dragStartClientY;
      if (Math.hypot(clientDx, clientDy) < DRAG_THRESHOLD) return;
      // Threshold exceeded — apply visual lift now
      dragThresholdMet = true;
      dragElementSnaps.forEach(snap => {
        const node = elementNodes.get(snap.id);
        if (node) { node.classList.add('dragging'); node.style.transform = 'scale(1.025)'; }
      });
    }

    const movedNodes = new Set();
    const dxW = wp.x - dragWorldStartX;
    const dyW = wp.y - dragWorldStartY;
    
    dragElementSnaps.forEach(snap => {
      const el = elements[snap.id];
      if (!el) return;
      if (el.type === 'line' || el.type === 'arrow') {
        el.x1 = snap.x1 + dxW; el.y1 = snap.y1 + dyW;
        el.x2 = snap.x2 + dxW; el.y2 = snap.y2 + dyW;
        // Break bind if we drag the arrow itself
        if (el.startBind) delete el.startBind;
        if (el.endBind) delete el.endBind;
        fixBBox(el);
      } else {
        el.x = snap.x + dxW;
        el.y = snap.y + dyW;
        movedNodes.add(el.id);
      }
      syncNode(el);
      sendOp('update', { element: el });
    });

    if (movedNodes.size > 0) {
      Object.values(elements).forEach(el => {
        if ((el.type === 'line' || el.type === 'arrow') && (el.startBind || el.endBind)) {
          let changed = false;
          if (el.startBind && movedNodes.has(el.startBind)) {
            const t = elements[el.startBind];
            if (t) { el.x1 = t.x + t.w / 2; el.y1 = t.y + t.h / 2; changed = true; }
          }
          if (el.endBind && movedNodes.has(el.endBind)) {
            const t = elements[el.endBind];
            if (t) { el.x2 = t.x + t.w / 2; el.y2 = t.y + t.h / 2; changed = true; }
          }
          if (changed) {
            fixBBox(el);
            syncNode(el);
            sendOp('update', { element: el });
          }
        }
      });
    }

    return;
  }

  // ── Marquee selection ───────────────────────────────────
  if (isDragSelecting && marqueeEl) {
    updateMarquee(e.clientX, e.clientY);
    return;
  }

  // ── Canvas pan ──────────────────────────────────────────
  if (isDraggingCanvas) {
    panX = canvasDragStartPanX + (e.clientX - canvasDragStartClientX);
    panY = canvasDragStartPanY + (e.clientY - canvasDragStartClientY);
    applyTransform();
  }
}

function onCanvasUp(e) {
  // Release pointer capture
  try { viewport.releasePointerCapture(e.pointerId); } catch (_) {}
  activePointers.delete(e.pointerId);

  if (activePointers.size < 2) {
    prevPinchDist = prevPinchMidX = prevPinchMidY = null;
  }

  // Handle arrow/line snapping to shapes
  if (isResizing && dragElementSnaps.length === 1) {
    const el = elements[dragElementSnaps[0].id];
    if (el && (el.type === 'line' || el.type === 'arrow')) {
      const targetNode = document.elementFromPoint(e.clientX, e.clientY)?.closest('.board-element:not(.line-element):not(.arrow-element)');
      let changed = false;
      if (targetNode) {
        const targetId = targetNode.dataset.eid;
        const target = elements[targetId];
        if (target) {
          if (resizeHandleType === 'start') {
            el.startBind = targetId;
            el.x1 = target.x + target.w / 2; el.y1 = target.y + target.h / 2;
          } else if (resizeHandleType === 'end') {
            el.endBind = targetId;
            el.x2 = target.x + target.w / 2; el.y2 = target.y + target.h / 2;
          }
          changed = true;
        }
      } else {
        // clear bind if dropped on empty space
        if (resizeHandleType === 'start' && el.startBind) { delete el.startBind; changed = true; }
        if (resizeHandleType === 'end' && el.endBind) { delete el.endBind; changed = true; }
      }
      if (changed) {
        fixBBox(el);
        syncNode(el);
        sendOp('update', { element: el });
      }
    }
  }

  // Finish element drag — remove dragging class only if drag actually started
  if (isDraggingElement && dragThresholdMet) {
    dragElementSnaps.forEach(snap => {
      const node = elementNodes.get(snap.id);
      if (node) {
        node.classList.remove('dragging');
        node.style.transform = '';
      }
    });
  }

  // Finish marquee
  if (isDragSelecting) finishMarquee(e.clientX, e.clientY);

  isDraggingCanvas   = false;
  isDraggingElement  = false;
  dragThresholdMet   = false;
  isResizing         = false;
  resizeHandleType   = null;
  resizeLockRatio    = false;
  isDragSelecting    = false;
  dragElementSnaps   = [];
  hideResizeBadge();
}

// ─────────────────────────────────────────────────────────────
// ELEMENT POINTER DOWN
// ─────────────────────────────────────────────────────────────
function onElementPointerDown(e, id) {
  // Let textarea handle its own events when in edit mode
  if (e.target.tagName === 'TEXTAREA' && !e.target.readOnly) return;

  e.stopPropagation();

  // If a non-select tool is active, canvas pointerdown will handle placement
  if (activeTool !== 'select') return;

  // Second press of a double-click — skip drag setup entirely so dblclick handlers run cleanly
  if (e.detail >= 2) return;

  const additive = e.shiftKey || e.ctrlKey || e.metaKey;

  if (selectedIds.has(id) && additive) {
    // Toggle off
    selectedIds.delete(id);
    if (elements[id]) syncNode(elements[id]);
    syncSelectionUI();
    return;
  }

  select(id, additive);

  // Start element drag — but movement is deferred until DRAG_THRESHOLD is exceeded
  isDraggingElement  = true;
  dragThresholdMet   = false;
  dragStartClientX   = e.clientX;
  dragStartClientY   = e.clientY;
  const wp = clientToWorld(e.clientX, e.clientY);
  dragWorldStartX = wp.x;
  dragWorldStartY = wp.y;

  dragElementSnaps = [...selectedIds].map(sid => {
    const el = elements[sid];
    return { id: sid, x: el.x, y: el.y, x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2 };
  });

  // Capture so we receive move/up even if pointer leaves element
  viewport.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
}

// ─────────────────────────────────────────────────────────────
// RESIZE HANDLE POINTER DOWN
// ─────────────────────────────────────────────────────────────
function onHandlePointerDown(e, id, handleName) {
  e.stopPropagation();
  e.preventDefault();

  isResizing       = true;
  resizeHandleType = handleName;
  dragThresholdMet = true; // resize handles respond immediately — no deadzone

  select(id, false);

  const wp = clientToWorld(e.clientX, e.clientY);
  dragWorldStartX = wp.x;
  dragWorldStartY = wp.y;

  const el = elements[id];
  dragElementSnaps = [{
    id,
    x: el.x, y: el.y, w: el.w, h: el.h,
    x1: el.x1, y1: el.y1, x2: el.x2, y2: el.y2,
    ratio: el.ratio || (el.w / el.h),
  }];

  viewport.setPointerCapture(e.pointerId);
  activePointers.set(e.pointerId, { clientX: e.clientX, clientY: e.clientY });
}

// ─────────────────────────────────────────────────────────────
// RESIZE MATH
// ─────────────────────────────────────────────────────────────
function applyResize(el, snap, handle, dxW, dyW) {
  const MIN = 40;

  if (el.type === 'line' || el.type === 'arrow') {
    if (handle === 'start') { el.x1 = snap.x1 + dxW; el.y1 = snap.y1 + dyW; }
    else                    { el.x2 = snap.x2 + dxW; el.y2 = snap.y2 + dyW; }
    return;
  }

  let nw = snap.w, nh = snap.h, nx = snap.x, ny = snap.y;

  // For images: free resize by default; Shift = lock aspect ratio.
  // For other elements: always free.
  const lockRatio = el.type === 'image' && resizeLockRatio;

  const clampAR = (rw, rh) => {
    if (!lockRatio || !snap.ratio) return [rw, rh];
    // Constrain to original aspect ratio; use the axis that moved more
    if (Math.abs(dxW) >= Math.abs(dyW)) rh = rw / snap.ratio;
    else                                 rw = rh * snap.ratio;
    return [rw, rh];
  };

  if (handle === 'se') {
    [nw, nh] = clampAR(Math.max(MIN, snap.w + dxW), Math.max(MIN, snap.h + dyW));
  } else if (handle === 'nw') {
    [nw, nh] = clampAR(Math.max(MIN, snap.w - dxW), Math.max(MIN, snap.h - dyW));
    nx = snap.x + snap.w - nw;
    ny = snap.y + snap.h - nh;
  } else if (handle === 'ne') {
    [nw, nh] = clampAR(Math.max(MIN, snap.w + dxW), Math.max(MIN, snap.h - dyW));
    ny = snap.y + snap.h - nh;
  } else if (handle === 'sw') {
    [nw, nh] = clampAR(Math.max(MIN, snap.w - dxW), Math.max(MIN, snap.h + dyW));
    nx = snap.x + snap.w - nw;
  }

  el.x = nx; el.y = ny; el.w = nw; el.h = nh;

  // Update live resize badge
  showResizeBadge(el, Math.round(nw), Math.round(nh));
}

// ─────────────────────────────────────────────────────────────
// RESIZE BADGE (live W × H readout during resize)
// ─────────────────────────────────────────────────────────────
let resizeBadge      = null;
let resizeLockRatio  = false; // toggled by Shift key during resize

function showResizeBadge(el, w, h) {
  if (!resizeBadge) {
    resizeBadge = document.createElement('div');
    resizeBadge.className = 'resize-badge';
    viewport.appendChild(resizeBadge);
  }
  const lockIcon = resizeLockRatio ? '🔒 ' : '';
  resizeBadge.textContent = `${lockIcon}${w} × ${h}`;

  // Position badge near the se corner of the element in client space
  const bx = el.x * zoom + panX + el.w * zoom + 8;
  const by = el.y * zoom + panY + el.h * zoom + 8;
  resizeBadge.style.left = `${bx}px`;
  resizeBadge.style.top  = `${by}px`;
}

function hideResizeBadge() {
  if (resizeBadge) { resizeBadge.remove(); resizeBadge = null; }
}


// ─────────────────────────────────────────────────────────────
// MOUSE WHEEL ZOOM
// ─────────────────────────────────────────────────────────────
function setupWheel() {
  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.09 : 1 / 1.09;
    const nz = Math.min(10, Math.max(0.08, zoom * factor));
    panX = e.clientX - (e.clientX - panX) * (nz / zoom);
    panY = e.clientY - (e.clientY - panY) * (nz / zoom);
    zoom = nz;
    applyTransform();
  }, { passive: false });
}

// ─────────────────────────────────────────────────────────────
// MARQUEE SELECTION
// ─────────────────────────────────────────────────────────────
function createMarquee() {
  if (marqueeEl) marqueeEl.remove();
  marqueeEl = document.createElement('div');
  marqueeEl.className = 'selection-marquee';
  viewport.appendChild(marqueeEl);
}

function updateMarquee(cx, cy) {
  if (!marqueeEl) return;
  const x = Math.min(marqueeStart.x, cx);
  const y = Math.min(marqueeStart.y, cy);
  const w = Math.abs(cx - marqueeStart.x);
  const h = Math.abs(cy - marqueeStart.y);
  Object.assign(marqueeEl.style, {
    left: `${x}px`, top: `${y}px`,
    width: `${w}px`, height: `${h}px`,
  });
}

function finishMarquee(cx, cy) {
  if (marqueeEl) { marqueeEl.remove(); marqueeEl = null; }

  const x1c = Math.min(marqueeStart.x, cx);
  const y1c = Math.min(marqueeStart.y, cy);
  const x2c = Math.max(marqueeStart.x, cx);
  const y2c = Math.max(marqueeStart.y, cy);

  const tl = clientToWorld(x1c, y1c);
  const br = clientToWorld(x2c, y2c);

  // Clear and re-select intersecting elements
  selectedIds.clear();
  Object.values(elements).forEach(el => {
    if (el.x < br.x && el.x + el.w > tl.x &&
        el.y < br.y && el.y + el.h > tl.y) {
      selectedIds.add(el.id);
    }
  });
  Object.values(elements).forEach(el => syncNode(el));
  syncSelectionUI();
}

// ─────────────────────────────────────────────────────────────
// ELEMENT CREATION
// ─────────────────────────────────────────────────────────────
function nextZ() {
  const vals = Object.values(elements);
  return vals.length ? Math.max(...vals.map(e => e.zIndex || 0)) + 1 : 1;
}

function createElement(type, wx, wy) {
  if (type === 'image') { showImageModal(); return; }

  const id = 'e' + Math.random().toString(36).slice(2, 11);
  const el = { id, type, color: type === 'note' ? 'yellow' : 'blueprint', zIndex: nextZ() };

  if (type === 'note') {
    Object.assign(el, { x: wx - 110, y: wy - 110, w: 220, h: 220, text: '' });
  } else if (type === 'rect' || type === 'ellipse') {
    Object.assign(el, { x: wx - 80, y: wy - 60, w: 160, h: 120 });
  } else if (type === 'line' || type === 'arrow') {
    Object.assign(el, { x1: wx - 80, y1: wy - 60, x2: wx + 80, y2: wy + 60 });
    fixBBox(el);
  }

  // Optimistic local
  elements[id] = el;
  mountElement(el, true);
  select(id, false);
  sendOp('add', { element: el });

  // Auto-focus new notes into edit mode
  if (type === 'note') {
    requestAnimationFrame(() => {
      const node = elementNodes.get(id);
      if (node) {
        const ta = node.querySelector('.note-body textarea');
        if (ta) ta.click(); // triggers enterEditMode via click listener
      }
    });
  }
}

// ─────────────────────────────────────────────────────────────
// EDIT SELECTED TEXT
// ─────────────────────────────────────────────────────────────
function editSelected() {
  if (selectedIds.size !== 1) return;
  const [selId] = selectedIds;
  const el = elements[selId];
  if (el && el.type === 'note') {
    const node = elementNodes.get(selId);
    const ta = node?.querySelector('.note-body textarea');
    if (ta) {
      ta.focus();
      ta.selectionStart = ta.selectionEnd = ta.value.length;
    }
  } else if (el && ['rect', 'ellipse', 'line', 'arrow'].includes(el.type)) {
    shapeTextEditors.get(selId)?.();
  }
}

// ─────────────────────────────────────────────────────────────
// DELETE SELECTED
// ─────────────────────────────────────────────────────────────
function deleteSelected() {
  if (!selectedIds.size) return;
  const ids = [...selectedIds];
  ids.forEach(id => {
    dropNode(id);
    delete elements[id];
    sendOp('delete', { id });
  });
  selectedIds.clear();
  syncSelectionUI();
  showToast(`Deleted ${ids.length} item${ids.length > 1 ? 's' : ''}`);
}

// ─────────────────────────────────────────────────────────────
// ACTIVE TOOL
// ─────────────────────────────────────────────────────────────
const toolDefs = [
  { id: 'tool-select',  mId: 'm-tool-select',  name: 'select'  },
  { id: 'tool-note',    mId: 'm-tool-note',    name: 'note'    },
  { id: 'tool-rect',    mId: 'm-tool-rect',    name: 'rect'    },
  { id: 'tool-ellipse', mId: 'm-tool-ellipse', name: 'ellipse' },
  { id: 'tool-line',    mId: 'm-tool-line',    name: 'line'    },
  { id: 'tool-arrow',   mId: 'm-tool-arrow',   name: 'arrow'   },
  { id: 'tool-image',   mId: 'm-tool-image',   name: 'image'   },
];

function setActiveTool(name) {
  activeTool = name;
  viewport.style.cursor = name === 'select' ? 'default' : 'crosshair';

  toolDefs.forEach(t => {
    const d = document.getElementById(t.id);
    const m = document.getElementById(t.mId);
    const on = t.name === name;
    if (d) d.classList.toggle('active', on);
    if (m) m.classList.toggle('active', on);
  });
}

// ─────────────────────────────────────────────────────────────
// TOOLBAR SETUP
// ─────────────────────────────────────────────────────────────
function setupToolbar() {
  toolDefs.forEach(t => {
    [t.id, t.mId].forEach(btnId => {
      const btn = document.getElementById(btnId);
      if (!btn) return;
      btn.addEventListener('click', () => {
        if (t.name === 'image') {
          showImageModal();
        } else if (t.name === 'select') {
          setActiveTool('select');
        } else {
          // Create element at viewport centre
          const r   = viewport.getBoundingClientRect();
          const wp  = clientToWorld(r.width / 2, r.height / 2);
          createElement(t.name, wp.x, wp.y);
          setActiveTool('select');
        }
      });
    });
  });

  // Color swatches — both desktop and mobile palettes
  document.querySelectorAll('.color-swatch').forEach(sw => {
    sw.addEventListener('click', () => {
      const color = sw.dataset.color;
      if (!color || !selectedIds.size) return;
      selectedIds.forEach(id => {
        if (!elements[id]) return;
        elements[id].color = color;
        syncNode(elements[id]);
        sendOp('update', { element: elements[id] });
      });
      markActiveSwatch(color);
    });
  });

  // Edit text button
  const editBtn = document.getElementById('mobile-edit-btn');
  if (editBtn) editBtn.addEventListener('click', editSelected);

  // Delete buttons
  ['desktop-delete-btn', 'mobile-delete-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', deleteSelected);
  });

  // Mobile drawer close
  const closeBtn = document.getElementById('mobile-close-drawer');
  if (closeBtn) closeBtn.addEventListener('click', deselect);
}

// ─────────────────────────────────────────────────────────────
// MODALS — Image insertion with URL, upload, drag-drop, paste
// ─────────────────────────────────────────────────────────────

// State for the pending image to insert
let pendingImageUrl  = null; // resolved URL/dataURL ready to place
let pendingImageW    = 0;
let pendingImageH    = 0;
let pendingFileType  = null;
let pendingFileName  = null;
let previewDebounce  = null;

function setupModals() {
  const modal      = document.getElementById('image-modal');
  const backdrop   = document.getElementById('modal-backdrop');
  const cancelBtn  = document.getElementById('image-cancel-btn');
  const cancelBtn2 = document.getElementById('image-cancel-btn2');
  const submitBtn  = document.getElementById('image-submit-btn');
  const urlInput   = document.getElementById('image-url-input');
  const dropZone   = document.getElementById('drop-zone');
  const filePicker = document.getElementById('file-picker');
  const tabs       = document.querySelectorAll('.img-tab');

  // ── Close helpers ──────────────────────────────────────
  const closeModal = () => {
    modal.classList.remove('open');
    clearPreview();
    pendingImageUrl = null;
    pendingImageW = 0;
    pendingImageH = 0;
    if (urlInput) urlInput.value = '';
    submitBtn.disabled = true;
  };

  cancelBtn?.addEventListener('click',  closeModal);
  cancelBtn2?.addEventListener('click', closeModal);
  backdrop?.addEventListener('click',   closeModal);

  // ── Tab switching ──────────────────────────────────────
  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      document.querySelectorAll('.img-tab-panel').forEach(p => p.classList.add('hidden'));
      const panel = document.getElementById(`tab-${tab.dataset.tab}`);
      if (panel) panel.classList.remove('hidden');
    });
  });

  // ── URL tab: debounced live preview ────────────────────
  urlInput?.addEventListener('input', () => {
    clearTimeout(previewDebounce);
    const url = urlInput.value.trim();
    setUrlStatus('');
    clearPreview();
    pendingImageUrl = null;
    submitBtn.disabled = true;

    if (!url) return;

    // Show loading after short pause
    previewDebounce = setTimeout(() => {
      setUrlStatus('⏳');
      setPreviewLoading();
      probeImageUrl(url);
    }, 600);
  });

  urlInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !submitBtn.disabled) commitImage();
    if (e.key === 'Escape') closeModal();
  });

  // ── Submit ─────────────────────────────────────────────
  submitBtn?.addEventListener('click', commitImage);

  function commitImage() {
    if (!pendingImageUrl) return;
    const url = pendingImageUrl;
    const w = pendingImageW;
    const h = pendingImageH;
    const fType = pendingFileType;
    const fName = pendingFileName;
    closeModal();
    if (fType === 'image') {
      placeImage(url, w, h);
    } else {
      placeFile(url, fName);
    }
  }

  // ── File picker / drop zone ────────────────────────────
  filePicker?.addEventListener('change', () => {
    const file = filePicker.files[0];
    if (file) uploadFileToServer(file);
    filePicker.value = '';
  });

  dropZone?.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone?.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });
  dropZone?.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) {
      uploadFileToServer(file);
    } else {
      // Maybe they dropped a URL string
      const url = e.dataTransfer.getData('text/plain')?.trim();
      if (url) {
        urlInput.value = url;
        // Switch to URL tab
        document.querySelector('.img-tab[data-tab="url"]')?.click();
        probeImageUrl(url);
      }
    }
  });

  // ── Global Ctrl+V paste ────────────────────────────────
  document.addEventListener('paste', e => {
    if (!modal.classList.contains('open')) return;

    const items = [...(e.clipboardData?.items || [])];

    // Prefer pasted file
    const fileItem = items.find(i => i.kind === 'file');
    if (fileItem) {
      e.preventDefault();
      const blob = fileItem.getAsFile();
      uploadFileToServer(blob);
      return;
    }

    // Otherwise try pasted URL text
    const textItem = items.find(i => i.type === 'text/plain');
    if (textItem) {
      textItem.getAsString(text => {
        const url = text.trim();
        if (!url) return;
        // Switch to URL tab and fill input
        document.querySelector('.img-tab[data-tab="url"]')?.click();
        if (urlInput) {
          urlInput.value = url;
          setPreviewLoading();
          probeImageUrl(url);
        }
      });
    }
  });
}

// ── URL probing ────────────────────────────────────────────────
function probeImageUrl(url) {
  const img = new Image();
  img.onload = () => {
    setUrlStatus('✅');
    pendingImageUrl = url;
    pendingFileType = 'image';
    pendingImageW = img.naturalWidth;
    pendingImageH = img.naturalHeight;
    document.getElementById('image-submit-btn').disabled = false;
    setPreviewImage(url, img.naturalWidth, img.naturalHeight);
  };
  img.onerror = () => {
    setUrlStatus('❌');
    pendingImageUrl = null;
    document.getElementById('image-submit-btn').disabled = true;
    setPreviewError('Could not load this URL — make sure it\'s a direct image link.');
  };
  // Do not use a cache-buster query param, as it breaks signed URLs (like S3/Discord)
  img.src = url;
}

// ── File → Server Upload ────────────────────────────────────────────
async function uploadFileToServer(file) {
  if (!file) return;
  if (file.size > 20 * 1024 * 1024) {
    setPreviewError('File is too large (max 20 MB).');
    return;
  }
  setPreviewLoading();
  try {
    const reader = new FileReader();
    reader.onload = async ev => {
      const dataUrl = ev.target.result;
      try {
        const res = await fetch('/upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, fileData: dataUrl })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        
        const isImage = file.type.startsWith('image/');
        pendingImageUrl = data.url;
        pendingFileType = isImage ? 'image' : 'file';
        pendingFileName = file.name;
        document.getElementById('image-submit-btn').disabled = false;

        if (isImage) {
          const img = new Image();
          img.onload = () => {
            pendingImageW = img.naturalWidth;
            pendingImageH = img.naturalHeight;
            setPreviewImage(dataUrl, img.naturalWidth, img.naturalHeight); // Use local for speed
          };
          img.src = dataUrl;
        } else {
          pendingImageW = 240;
          pendingImageH = 80;
          setPreviewFile(file.name);
        }
      } catch (e) {
        console.error(e);
        setPreviewError('Failed to upload file.');
      }
    };
    reader.onerror = () => setPreviewError('Could not read the file locally.');
    reader.readAsDataURL(file);
  } catch (err) {
    console.error(err);
    setPreviewError('Upload error.');
  }
}

// ── Preview helpers ────────────────────────────────────────────
function clearPreview() {
  const zone  = document.getElementById('img-preview-zone');
  const inner = document.getElementById('img-preview-inner');
  if (!zone || !inner) return;
  zone.classList.remove('has-preview');
  inner.innerHTML = '<span class="preview-empty">Preview will appear here</span>';
}

function setPreviewLoading() {
  const zone  = document.getElementById('img-preview-zone');
  const inner = document.getElementById('img-preview-inner');
  if (!zone || !inner) return;
  zone.classList.remove('has-preview');
  inner.innerHTML = '<div class="preview-loading"><div class="spinner"></div> Loading…</div>';
}

function setPreviewImage(src, w, h) {
  const zone  = document.getElementById('img-preview-zone');
  const inner = document.getElementById('img-preview-inner');
  if (!zone || !inner) return;
  zone.classList.add('has-preview');
  inner.innerHTML = `
    <div style="text-align:center">
      <img src="${src}" alt="preview">
      <div class="preview-meta">${w} × ${h} px</div>
    </div>`;
}

function setPreviewFile(fileName) {
  const zone  = document.getElementById('img-preview-zone');
  const inner = document.getElementById('img-preview-inner');
  if (!zone || !inner) return;
  zone.classList.add('has-preview');
  inner.innerHTML = `
    <div class="preview-file-icon">
      <div style="font-size: 32px; margin-bottom: 8px;">📄</div>
      <div style="font-weight: 600; color: var(--text); word-break: break-all;">${fileName}</div>
    </div>`;
}

function setPreviewError(msg) {
  const zone  = document.getElementById('img-preview-zone');
  const inner = document.getElementById('img-preview-inner');
  if (!zone || !inner) return;
  zone.classList.remove('has-preview');
  inner.innerHTML = `<div class="preview-error">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    ${msg}
  </div>`;
}

function setUrlStatus(icon) {
  const el = document.getElementById('url-status');
  if (el) el.textContent = icon;
}

function showImageModal() {
  const modal = document.getElementById('image-modal');
  if (!modal) return;

  // Reset to URL tab
  document.querySelector('.img-tab[data-tab="url"]')?.click();
  clearPreview();
  pendingImageUrl = null;

  const input = document.getElementById('image-url-input');
  if (input) input.value = '';
  setUrlStatus('');

  const submitBtn = document.getElementById('image-submit-btn');
  if (submitBtn) submitBtn.disabled = true;

  modal.classList.add('open');
  requestAnimationFrame(() => input?.focus());
}

function placeImage(url, w = null, h = null) {
  const r  = viewport.getBoundingClientRect();
  const wp = clientToWorld(r.width / 2, r.height / 2);
  placeImageAt(url, wp.x, wp.y, w, h);
}

// Keep loadImage as a thin alias for backward compat with test script
function loadImage(url) { placeImage(url); }

function placeFileAt(url, fileName, cx, cy, presetW = null, presetH = null) {
  const w = presetW || 240;
  const h = presetH || 70;

  const id = 'e' + Math.random().toString(36).slice(2, 11);
  const el = {
    id, type: 'file', url, fileName,
    x: cx - w / 2, y: cy - h / 2,
    w, h, zIndex: nextZ(), color: 'blueprint'
  };
  elements[id] = el;
  mountElement(el, true);
  select(id, false);
  sendOp('add', { element: el });
}

function placeFile(url, fileName, w = null, h = null) {
  const r  = viewport.getBoundingClientRect();
  const wp = clientToWorld(r.width / 2, r.height / 2);
  placeFileAt(url, fileName, wp.x, wp.y, w, h);
}


// ─────────────────────────────────────────────────────────────
// KEYBOARD SHORTCUTS
// ─────────────────────────────────────────────────────────────
function setupKeyboard() {
  const ignore = e =>
    e.target.tagName === 'TEXTAREA' ||
    e.target.tagName === 'INPUT';

  window.addEventListener('keydown', e => {
    if (e.key === ' ' && !ignore(e)) {
      // ── Spacebar on a selected shape → enter text edit ──
      if (selectedIds.size === 1) {
        const [selId] = selectedIds;
        const el = elements[selId];
        if (el && ['rect', 'ellipse', 'line', 'arrow'].includes(el.type)) {
          const enterEdit = shapeTextEditors.get(selId);
          if (enterEdit) {
            e.preventDefault();
            enterEdit();
            return; // don't activate pan
          }
        }
      }

      // ── Default: spacebar = pan cursor ──────────────────
      e.preventDefault();
      isSpaceHeld = true;
      if (!isDraggingElement && !isResizing)
        viewport.style.cursor = 'grab';
      return;
    }

    if (ignore(e)) return;

    switch (e.key.toLowerCase()) {
      case 'v':       setActiveTool('select'); break;
      case 'n':       spawnAtCenter('note');    break;
      case 'r':       spawnAtCenter('rect');    break;
      case 'o':       spawnAtCenter('ellipse'); break;
      case 'l':       spawnAtCenter('line');    break;
      case 'a':       spawnAtCenter('arrow');   break;
      case 'i':       showImageModal();          break;
      case 'escape':  deselect();                break;
      case 'delete':
      case 'backspace': deleteSelected();        break;
      case 'f2': {
        // F2 = enter text edit for selected shape (like Rename in most apps)
        if (selectedIds.size === 1) {
          const [selId] = selectedIds;
          const el = elements[selId];
          if (el && ['rect', 'ellipse', 'line', 'arrow'].includes(el.type)) {
            shapeTextEditors.get(selId)?.();
          }
        }
        break;
      }
    }
  });

  window.addEventListener('keyup', e => {
    if (e.key === ' ') {
      isSpaceHeld = false;
      viewport.style.cursor = activeTool === 'select' ? 'default' : 'crosshair';
    }
  });
}

function spawnAtCenter(type) {
  const r  = viewport.getBoundingClientRect();
  const wp = clientToWorld(r.width / 2, r.height / 2);
  createElement(type, wp.x, wp.y);
  setActiveTool('select');
}

// ─────────────────────────────────────────────────────────────
// TOAST
// ─────────────────────────────────────────────────────────────
let toastTimer = null;
function showToast(msg, ms = 2200) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
