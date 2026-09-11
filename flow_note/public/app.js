/* ============================================================
   NOTEBOARD — app.js
   Infinite canvas engine, pointer interactions, WebSocket sync.
   ============================================================ */

'use strict';

// ── DOM refs ─────────────────────────────────────────────────
const viewport   = document.getElementById('viewport');
const world      = document.getElementById('world');
const statusEl   = document.getElementById('status-indicator');
const statusDot  = statusEl ? statusEl.querySelector('.status-dot') : null;
const statusText = statusEl ? statusEl.querySelector('.status-text') : null;
const toastEl    = document.getElementById('toast');

// Preview / Minimap refs
const previewWindow       = document.getElementById('preview-window');
const previewZoomVal      = document.getElementById('preview-zoom-val');
const previewZoomIn       = document.getElementById('preview-zoom-in');
const previewZoomOut      = document.getElementById('preview-zoom-out');
const previewCanvasWrap   = document.getElementById('preview-canvas-wrap');
const previewCanvas       = document.getElementById('preview-canvas');
const previewViewportRect = document.getElementById('preview-viewport-rect');

if (statusEl) {
  statusEl.addEventListener('click', () => {
    if (window.AndroidBridge && typeof window.AndroidBridge.showServerDialog === 'function') {
      window.AndroidBridge.showServerDialog();
    }
  });
}

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
let isDrawingFreehand = false;
let drawFreehandId = null;
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
let marqueeEl               = null;
let marqueeStart            = { x: 0, y: 0 }; // client coords
let marqueeAdditive         = false;
let initialMarqueeSelection = new Set();
let clickedAlreadySelected  = null;
let clickedAdditive         = false;

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
  try {
    let cached = localStorage.getItem('flow_note_state');
    if ((!cached || cached === '{}') && window.AndroidBridge && typeof window.AndroidBridge.getBoardState === 'function') {
      const bridgeCached = window.AndroidBridge.getBoardState();
      if (bridgeCached && bridgeCached !== '{}') {
        cached = bridgeCached;
      }
    }
    if (cached) {
      elements = JSON.parse(cached);
      for (const el of Object.values(elements)) {
        fixBBox(el);
        mountElement(el);
      }
    }
  } catch(e){}

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
  setupPreviewMinimap();

  window.addEventListener('offline', () => {
    if (ws) ws.close();
  });

  window.addEventListener('resize', applyTransform);
}

// ─────────────────────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────────────────────

// ================= OFFLINE QUEUE HELPERS =================
function saveLocalState() {
  try { localStorage.setItem('flow_note_state', JSON.stringify(elements)); } catch (e) {}
  try {
    if (window.AndroidBridge && typeof window.AndroidBridge.saveBoardState === 'function') {
      window.AndroidBridge.saveBoardState(JSON.stringify(elements));
    }
  } catch (e) {}
}

function enqueueOp(type, payload) {
  try {
    const queue = JSON.parse(localStorage.getItem('flow_note_queue') || '[]');
    queue.push({ type, payload });
    localStorage.setItem('flow_note_queue', JSON.stringify(queue));
  } catch (e) {}
}

function flushOfflineQueue() {
  try {
    const queue = JSON.parse(localStorage.getItem('flow_note_queue') || '[]');
    if (queue.length > 0) {
      queue.forEach(op => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: op.type, ...op.payload }));
        }
      });
      // Do not remove item here to prevent race condition with incoming 'init' message
    }
  } catch (e) {}
}

let pingTimer = null;

function resolveServerHost() {
  if (location.host && !location.host.startsWith('localhost') && !location.host.startsWith('127.0.0.1')) {
    try { localStorage.setItem('flow_server_host', location.host); } catch (e) {}
    return location.host;
  }
  try {
    if (window.AndroidBridge && typeof window.AndroidBridge.getServerIp === 'function') {
      const bridgeIp = window.AndroidBridge.getServerIp();
      if (bridgeIp) return `${bridgeIp}:3939`;
    }
  } catch (e) {}
  try {
    const savedHost = localStorage.getItem('flow_server_host');
    if (savedHost) return savedHost;
  } catch (e) {}
  return location.host || 'localhost:3939';
}

function connectWebSocket() {
  const isFile = location.protocol === 'file:';
  const targetHost = resolveServerHost();
  if (isFile && (!targetHost || targetHost.startsWith('localhost') || targetHost.startsWith('127.0.0.1'))) {
    setStatus('offline');
    return;
  }
  setStatus('connecting');
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  try {
    ws = new WebSocket(`${proto}//${targetHost}`);

    ws.onopen = () => {
      setStatus('connected');
      reconnectDelay = 1000;
      flushOfflineQueue();
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 15000);
    };

    ws.onmessage = ({ data }) => {
      try {
        const parsed = JSON.parse(data);
        if (parsed.type === 'pong') return;
        handleServerMsg(parsed);
      } catch (e) { console.error('WS parse error', e); }
    };

    ws.onclose = () => {
      if (pingTimer) clearInterval(pingTimer);
      setStatus(isFile ? 'offline' : 'disconnected');
      setTimeout(() => {
        reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
        connectWebSocket();
      }, reconnectDelay);
    };

    ws.onerror = () => {
      if (ws) {
        try { ws.close(); } catch (e) {}
      }
    };
  } catch (err) {
    if (pingTimer) clearInterval(pingTimer);
    setStatus(isFile ? 'offline' : 'disconnected');
    setTimeout(() => {
      reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT);
      connectWebSocket();
    }, reconnectDelay);
  }
}

function sendOp(type, payload) {
    if (ws && ws.readyState === WebSocket.OPEN && navigator.onLine) {
      ws.send(JSON.stringify({ type, ...payload }));
    } else {
      enqueueOp(type, payload);
    }
    saveLocalState();
  }

function setStatus(state) {
  statusEl.className = `status-indicator ${state}`;
  statusText.textContent =
    state === 'connected'    ? 'Connected'     :
    state === 'connecting'   ? 'Connecting…'   :
    state === 'offline'      ? 'Offline Mode'  : 'Disconnected';
}

// ─────────────────────────────────────────────────────────────
// SERVER MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────
function handleServerMsg(msg) {
  switch (msg.type) {
    case 'init': {
      const incoming = msg.elements || {};
      try {
        const queue = JSON.parse(localStorage.getItem('flow_note_queue') || '[]');
        queue.forEach(op => {
          if (op.type === 'add' || op.type === 'update') {
            if (op.payload.element) incoming[op.payload.element.id] = op.payload.element;
          } else if (op.type === 'delete') {
            if (op.payload.id) delete incoming[op.payload.id];
          } else if (op.type === 'deleteMultiple') {
            if (op.payload.ids) op.payload.ids.forEach(id => delete incoming[id]);
          }
        });
        localStorage.removeItem('flow_note_queue');
      } catch (e) {}

      // Keep active editing element intact so user doesn't lose typing state or focus
      const activeEl = document.activeElement;
      const editingNode = activeEl ? activeEl.closest('.board-element') : null;
      const editingId = editingNode ? editingNode.id : null;

      // Remove deleted elements
      for (const id of Array.from(elementNodes.keys())) {
        if (!incoming[id] && id !== editingId) {
          dropNode(id);
        }
      }

      elements = incoming;

      // Reconcile elements smoothly without wiping canvas
      for (const el of Object.values(elements)) {
        fixBBox(el);
        if (elementNodes.has(el.id)) {
          if (el.id === editingId) {
            syncNodePos(elementNodes.get(el.id), el);
          } else {
            syncNode(el);
          }
        } else {
          mountElement(el);
        }
      }
      saveLocalState();
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
        saveLocalState();
        break;
      }
    case 'delete': {
      dropNode(msg.id);
      delete elements[msg.id];
      selectedIds.delete(msg.id);
      syncSelectionUI();
      saveLocalState();
      break;
    }
    case 'deleteMultiple': {
      (msg.ids || []).forEach(id => {
        dropNode(id);
        delete elements[id];
        selectedIds.delete(id);
      });
      syncSelectionUI();
      saveLocalState();
      break;
    }
  }
}

// ─────────────────────────────────────────────────────────────
// CANVAS TRANSFORM
// ─────────────────────────────────────────────────────────────
let lastAppliedZoom = zoom;
function applyTransform() {
  world.style.transform = `translate(${panX}px,${panY}px) scale(${zoom})`;
  const zoomChanged = Math.abs(zoom - lastAppliedZoom) > 0.0001;
  lastAppliedZoom = zoom;

  if (zoomChanged) {
    showPreviewWindow();
  } else if (previewWindow && previewWindow.classList.contains('visible')) {
    updateMinimap();
  }
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
  } else if (el.type === 'draw' && el.points && el.points.length > 0) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    el.points.forEach(p => {
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    });
    el.x = minX - 4;
    el.y = minY - 4;
    el.w = Math.max(20, maxX - minX + 8);
    el.h = Math.max(20, maxY - minY + 8);
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
  } else if (el.type === 'link') {
    buildLinkContent(node, el);
  } else if (el.type === 'timer') {
    buildTimerContent(node, el);
  } else if (el.type === 'voice') {
    buildVoiceContent(node, el);
  } else if (el.type === 'draw') {
    buildDrawContent(node, el);
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

  let noteTypingTimer = null;

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
    if (noteTypingTimer) {
      clearTimeout(noteTypingTimer);
      noteTypingTimer = null;
    }
    ta.readOnly = true;
    body.classList.remove('editing');
    node.classList.remove('editing-mode');
    ta.style.height = ''; // let flex handle it again
    const stored = elements[el.id];
    if (stored) {
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
    syncPlaceholder();
    autoGrow();
    const stored = elements[el.id];
    if (stored) {
      stored.text = ta.value;
      if (noteTypingTimer) clearTimeout(noteTypingTimer);
      noteTypingTimer = setTimeout(() => {
        sendOp('update', { element: stored });
      }, 100);
    }
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

function getPdfViewerUrl(fileUrl) {
  let serverIp = '';
  if (window.AndroidBridge && window.AndroidBridge.getServerIp) {
    try { serverIp = window.AndroidBridge.getServerIp(); } catch (e) {}
  }
  
  const isLocalOrFile = location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1' || !location.hostname;
  
  let pdfHost = 'localhost:4040';
  if (!isLocalOrFile && location.hostname) {
    pdfHost = `${location.hostname}:4040`;
  } else if (serverIp) {
    pdfHost = `${serverIp}:4040`;
  }
  
  let noteHost = 'localhost:3939';
  if (!isLocalOrFile && location.host) {
    noteHost = location.host;
  } else if (serverIp) {
    noteHost = `${serverIp}:3939`;
  }
  
  let fullUrl = fileUrl || '';
  if (!fullUrl.startsWith('http://') && !fullUrl.startsWith('https://') && !fullUrl.startsWith('data:')) {
    if (!fullUrl.startsWith('/')) fullUrl = '/' + fullUrl;
    fullUrl = `http://${noteHost}${fullUrl}`;
  }
  
  const sep = fullUrl.includes('?') ? '&' : '?';
  const targetUrl = fullUrl.startsWith('http') ? `${fullUrl}${sep}v=${Date.now()}` : fullUrl;
  return `http://${pdfHost}/web/viewer.html?file=${encodeURIComponent(targetUrl)}`;
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
  
  const isPdf = (el.fileName || el.url || '').toLowerCase().endsWith('.pdf');

  const openAction = (e) => {
    if (e) {
      e.stopPropagation();
      e.preventDefault();
    }
    if (isPdf) {
      if (window.AndroidBridge && window.AndroidBridge.openPdf) {
        window.AndroidBridge.openPdf(el.url, el.fileName || 'Document.pdf');
      } else {
        window.open(getPdfViewerUrl(el.url), '_blank');
      }
    } else if (el.url) {
      if (window.AndroidBridge && window.AndroidBridge.openFile) {
        window.AndroidBridge.openFile(el.url, el.fileName || 'Attachment');
      } else {
        window.open(el.url, '_blank');
      }
    }
  };

  icon.style.cursor = 'pointer';
  icon.addEventListener('click', openAction);
  name.style.cursor = 'pointer';
  name.addEventListener('click', openAction);

  const dl = document.createElement('a');
  dl.className = 'file-download';
  dl.href = el.url ? (el.url.startsWith('http') ? `${el.url}?v=${Date.now()}` : el.url) : '#';
  dl.target = '_blank';
  dl.title = 'Open file';
  dl.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" stroke-width="2" fill="none"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>';
  dl.addEventListener('pointerdown', e => e.stopPropagation());
  dl.addEventListener('click', e => {
    if (window.AndroidBridge && (window.AndroidBridge.openPdf || window.AndroidBridge.openFile)) {
      openAction(e);
    }
  });

  inner.appendChild(icon);
  inner.appendChild(name);

  if (isPdf) {
    const annotateBtn = document.createElement('a');
    annotateBtn.className = 'file-download';
    annotateBtn.title = 'Annotate PDF (Official PDF.js)';
    annotateBtn.innerHTML = '<span style="font-size: 16px;">🖊️</span>';
    annotateBtn.target = '_blank';
    annotateBtn.href = getPdfViewerUrl(el.url);
    annotateBtn.addEventListener('pointerdown', e => e.stopPropagation());
    annotateBtn.addEventListener('click', e => {
      if (window.AndroidBridge && window.AndroidBridge.openPdf) {
        openAction(e);
      }
    });
    inner.appendChild(annotateBtn);
  }

  inner.appendChild(dl);
  node.appendChild(inner);

  node.addEventListener('dblclick', e => {
    openAction(e);
  });
}

function buildLinkContent(node, el) {
  node.classList.add('link-element');
  const inner = document.createElement('div');
  inner.className = 'link-card-inner';

  if (el.image) {
    const banner = document.createElement('div');
    banner.className = 'link-card-banner';
    banner.style.backgroundImage = `url("${el.image}")`;
    inner.appendChild(banner);
  }

  const body = document.createElement('div');
  body.className = 'link-card-body';

  const header = document.createElement('div');
  header.className = 'link-card-header';

  if (el.favicon) {
    const fav = document.createElement('img');
    fav.className = 'link-card-favicon';
    fav.src = el.favicon;
    fav.alt = '';
    fav.onerror = () => { fav.style.display = 'none'; };
    header.appendChild(fav);
  }

  const domain = document.createElement('span');
  domain.className = 'link-card-domain';
  try {
    domain.textContent = el.domain || new URL(el.url).hostname.replace(/^www\./, '');
  } catch (_) {
    domain.textContent = el.domain || '';
  }
  header.appendChild(domain);
  body.appendChild(header);

  const title = document.createElement('h3');
  title.className = 'link-card-title';
  title.textContent = el.title || el.url || 'Link';
  body.appendChild(title);

  if (el.description) {
    const desc = document.createElement('p');
    desc.className = 'link-card-desc';
    desc.textContent = el.description;
    body.appendChild(desc);
  }

  const footer = document.createElement('div');
  footer.className = 'link-card-footer';

  const linkBtn = document.createElement('a');
  linkBtn.className = 'link-card-open';
  linkBtn.href = el.url || '#';
  linkBtn.target = '_blank';
  linkBtn.rel = 'noopener noreferrer';
  linkBtn.title = 'Open link';
  linkBtn.innerHTML = `<span>Visit</span> <svg viewBox="0 0 24 24" width="12" height="12" stroke="currentColor" stroke-width="2.5" fill="none"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>`;
  linkBtn.addEventListener('pointerdown', e => e.stopPropagation());

  footer.appendChild(linkBtn);
  body.appendChild(footer);
  inner.appendChild(body);
  node.appendChild(inner);

  node.addEventListener('dblclick', e => {
    if (el.url) window.open(el.url, '_blank');
  });
}

// ─────────────────────────────────────────────────────────────
// TIME TRACKER CARD
// ─────────────────────────────────────────────────────────────
const activeTimerIntervals = new Map(); // id -> intervalId

function getTimerCurrentMs(el) {
  let ms = el.accumulatedMs || 0;
  if (el.running && el.startedAt) {
    ms += (Date.now() - el.startedAt);
  }
  if (el.mode === 'pomodoro') {
    const total = el.pomodoroDurationMs || 25 * 60 * 1000;
    return Math.max(0, total - ms);
  }
  return ms;
}

function formatTimerTime(ms, includeHours = false) {
  const totalSec = Math.floor(Math.max(0, ms) / 1000);
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  if (hrs > 0 || includeHours) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function ensureTimerTick(el) {
  if (el.running) {
    if (!activeTimerIntervals.has(el.id)) {
      const interval = setInterval(() => {
        const node = elementNodes.get(el.id);
        if (!node) {
          stopTimerTick(el.id);
          return;
        }
        const digits = node.querySelector('.timer-digits');
        if (digits) {
          const ms = getTimerCurrentMs(el);
          digits.textContent = formatTimerTime(ms, ms >= 3600000);
          if (el.mode === 'pomodoro' && ms <= 0 && el.running) {
            el.running = false;
            el.startedAt = null;
            el.accumulatedMs = 0;
            stopTimerTick(el.id);
            if (!Array.isArray(el.records)) el.records = [];
            const pomodoroRec = {
              id: 'rec_' + Math.random().toString(36).slice(2, 9),
              title: el.title || 'Pomodoro Session',
              mode: 'pomodoro',
              durationMs: el.pomodoroDurationMs || 25 * 60 * 1000,
              completedAt: Date.now(),
              lapsCount: (el.laps || []).length,
              laps: (el.laps || []).slice()
            };
            el.records.unshift(pomodoroRec);
            el.laps = [];
            syncTimerNode(node, el);
            sendOp('update', { element: el });
            saveSessionToDatabase(pomodoroRec, el);
            showToast('🍅 Pomodoro complete & recorded!');
          }
        }
      }, 200);
      activeTimerIntervals.set(el.id, interval);
    }
  } else {
    stopTimerTick(el.id);
  }
}

function stopTimerTick(id) {
  if (activeTimerIntervals.has(id)) {
    clearInterval(activeTimerIntervals.get(id));
    activeTimerIntervals.delete(id);
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatRecordDate(ts) {
  const d = new Date(ts);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const m = months[d.getMonth()];
  const date = d.getDate();
  let hrs = d.getHours();
  const mins = String(d.getMinutes()).padStart(2, '0');
  const ampm = hrs >= 12 ? 'PM' : 'AM';
  hrs = hrs % 12 || 12;
  return `${m} ${date}, ${hrs}:${mins} ${ampm}`;
}

function pinRecordToNote(el, rec) {
  const noteId = 'e' + Math.random().toString(36).slice(2, 11);
  const durationStr = formatTimerTime(rec.durationMs, rec.durationMs >= 3600000);
  const dateStr = formatRecordDate(rec.completedAt);
  const modeLabel = rec.mode === 'pomodoro' ? '🍅 Pomodoro' : '⏱️ Stopwatch';

  let lines = [
    `⏱️ ${rec.title || 'Timer Record'}`,
    `────────────────────`,
    `Mode: ${modeLabel}`,
    `Duration: ${durationStr}`,
    `Recorded: ${dateStr}`
  ];

  if (Array.isArray(rec.laps) && rec.laps.length > 0) {
    lines.push(`\nLaps (${rec.laps.length}):`);
    rec.laps.forEach((lap, i) => {
      lines.push(`• Lap ${rec.laps.length - i}: ${formatTimerTime(lap.timeMs, lap.timeMs >= 3600000)}`);
    });
  }

  const noteEl = {
    id: noteId,
    type: 'note',
    color: el.color || 'yellow',
    zIndex: nextZ(),
    x: el.x + el.w + 24,
    y: el.y,
    w: 220,
    h: 220,
    text: lines.join('\n')
  };

  elements[noteId] = noteEl;
  mountElement(noteEl, true);
  select(noteId, false);
  sendOp('add', { element: noteEl });
  showToast('📌 Record pinned to note!');
}

function saveSessionToDatabase(rec, el) {
  if (!rec) return;
  const payload = {
    id: rec.id || ('tr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)),
    timerId: el ? el.id : null,
    title: rec.title || (el && el.title) || 'Focus Session',
    mode: rec.mode || (el && el.mode) || 'stopwatch',
    durationMs: rec.durationMs || 0,
    laps: Array.isArray(rec.laps) ? rec.laps : [],
    closedAt: rec.completedAt || Date.now(),
    color: (el && el.color) || 'blueprint'
  };
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'recordSession', record: payload }));
  } else {
    fetch('/api/timer-records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(e => console.warn('Failed to post timer record:', e));
  }
}

function closeAndArchiveTimer(id) {
  const el = elements[id];
  if (!el) return;
  stopTimerTick(id);
  delete elements[id];
  unmountElement(id);
  selectedIds.delete(id);
  updateSelectionUI();
  sendOp('delete', { id });
  showToast('⏱️ Timer closed & archived to central database');
}

function buildTimerContent(node, el) {
  node.classList.add('timer-element');
  const inner = document.createElement('div');
  inner.className = 'timer-card-inner';

  // 1. Header: Icon + Title Input + Header Actions (Mode toggle + Records toggle + Close)
  const header = document.createElement('div');
  header.className = 'timer-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'timer-title-wrap';

  const icon = document.createElement('div');
  icon.className = 'timer-icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><polyline points="12 9 12 13 15 15"/><path d="M12 2v3"/><path d="M10 2h4"/></svg>`;

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'timer-title-input';
  titleInput.value = el.title || 'Focus Session';
  titleInput.placeholder = 'Timer Title...';
  titleInput.title = 'Click to rename task';
  titleInput.addEventListener('pointerdown', e => e.stopPropagation());
  titleInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') titleInput.blur();
  });
  titleInput.addEventListener('change', () => {
    const val = titleInput.value.trim() || 'Timer';
    el.title = val;
    sendOp('update', { element: el });
  });

  titleWrap.appendChild(icon);
  titleWrap.appendChild(titleInput);

  const headerActions = document.createElement('div');
  headerActions.className = 'timer-header-actions';

  const modeBtn = document.createElement('button');
  modeBtn.className = 'timer-mode-btn';
  modeBtn.title = 'Click to toggle between Stopwatch and Pomodoro';
  modeBtn.addEventListener('pointerdown', e => e.stopPropagation());
  modeBtn.addEventListener('click', e => {
    e.stopPropagation();
    el.mode = (el.mode === 'pomodoro' ? 'stopwatch' : 'pomodoro');
    el.running = false;
    el.startedAt = null;
    el.accumulatedMs = 0;
    stopTimerTick(el.id);
    syncTimerNode(node, el);
    sendOp('update', { element: el });
  });

  const recordsToggleBtn = document.createElement('button');
  recordsToggleBtn.className = 'timer-view-btn';
  recordsToggleBtn.title = 'View recorded sessions';
  recordsToggleBtn.innerHTML = `<span>History</span> <span class="records-count">0</span>`;
  recordsToggleBtn.addEventListener('pointerdown', e => e.stopPropagation());
  recordsToggleBtn.addEventListener('click', e => {
    e.stopPropagation();
    node.dataset.view = (node.dataset.view === 'records' ? 'timer' : 'records');
    syncTimerNode(node, el);
  });

  const closeCardBtn = document.createElement('button');
  closeCardBtn.className = 'timer-close-btn';
  closeCardBtn.title = 'Close & archive timer to database';
  closeCardBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  closeCardBtn.addEventListener('pointerdown', e => e.stopPropagation());
  closeCardBtn.addEventListener('click', e => {
    e.stopPropagation();
    closeAndArchiveTimer(el.id);
  });

  headerActions.appendChild(modeBtn);
  headerActions.appendChild(recordsToggleBtn);
  headerActions.appendChild(closeCardBtn);

  header.appendChild(titleWrap);
  header.appendChild(headerActions);

  // 2. MAIN TIMER VIEW
  const mainView = document.createElement('div');
  mainView.className = 'timer-main-view';

  const displayWrap = document.createElement('div');
  displayWrap.className = 'timer-display-wrap';

  const digits = document.createElement('div');
  digits.className = 'timer-digits';

  const statusBadge = document.createElement('div');
  statusBadge.className = 'timer-status-badge';
  statusBadge.innerHTML = `<span class="timer-status-dot"></span><span class="timer-status-text">Ready</span>`;

  displayWrap.appendChild(digits);
  displayWrap.appendChild(statusBadge);

  // Controls: Play/Pause, Lap, Record, Reset
  const controls = document.createElement('div');
  controls.className = 'timer-controls';

  const playBtn = document.createElement('button');
  playBtn.className = 'timer-btn primary timer-play-btn';
  playBtn.addEventListener('pointerdown', e => e.stopPropagation());
  playBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (!el.running) {
      // Starting / Resuming
      if (el.mode === 'pomodoro') {
        const remaining = getTimerCurrentMs(el);
        if (remaining <= 0) {
          el.accumulatedMs = 0;
        }
      }
      el.running = true;
      el.startedAt = Date.now();
      ensureTimerTick(el);
      syncTimerNode(node, el);
      sendOp('update', { element: el });
    } else {
      // Pausing
      el.accumulatedMs = (el.accumulatedMs || 0) + (Date.now() - el.startedAt);
      el.running = false;
      el.startedAt = null;
      stopTimerTick(el.id);
      syncTimerNode(node, el);
      sendOp('update', { element: el });
    }
  });

  const lapBtn = document.createElement('button');
  lapBtn.className = 'timer-btn timer-lap-btn';
  lapBtn.title = 'Record split / lap';
  lapBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg><span>Lap</span>`;
  lapBtn.addEventListener('pointerdown', e => e.stopPropagation());
  lapBtn.addEventListener('click', e => {
    e.stopPropagation();
    const currentMs = getTimerCurrentMs(el);
    if (currentMs > 0 || el.running) {
      if (!Array.isArray(el.laps)) el.laps = [];
      el.laps.unshift({
        timeMs: currentMs,
        timestamp: Date.now()
      });
      if (el.laps.length > 8) el.laps.pop();
      syncTimerNode(node, el);
      sendOp('update', { element: el });
    }
  });

  const recordBtn = document.createElement('button');
  recordBtn.className = 'timer-btn timer-record-btn';
  recordBtn.title = 'Save current session to history';
  recordBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3.5" fill="#ef4444" stroke="#ef4444"/></svg><span>Record</span>`;
  recordBtn.addEventListener('pointerdown', e => e.stopPropagation());
  recordBtn.addEventListener('click', e => {
    e.stopPropagation();
    const currentMs = getTimerCurrentMs(el);
    if (currentMs <= 0 && !el.running && (!el.accumulatedMs || el.accumulatedMs <= 0)) {
      showToast('Start the timer first to record');
      return;
    }
    if (el.running) {
      el.accumulatedMs = (el.accumulatedMs || 0) + (Date.now() - el.startedAt);
      el.running = false;
      el.startedAt = null;
      stopTimerTick(el.id);
    }
    const sessionDuration = el.accumulatedMs || currentMs;
    const sessionRec = {
      id: 'rec_' + Math.random().toString(36).slice(2, 9),
      title: el.title || (el.mode === 'pomodoro' ? 'Pomodoro Session' : 'Focus Session'),
      mode: el.mode,
      durationMs: sessionDuration,
      completedAt: Date.now(),
      lapsCount: (el.laps || []).length,
      laps: (el.laps || []).slice()
    };
    if (!Array.isArray(el.records)) el.records = [];
    el.records.unshift(sessionRec);
    el.accumulatedMs = 0;
    el.laps = [];
    node.dataset.view = 'records';
    syncTimerNode(node, el);
    sendOp('update', { element: el });
    saveSessionToDatabase(sessionRec, el);
    showToast('⏱️ Session recorded & saved to database!');
  });

  const resetBtn = document.createElement('button');
  resetBtn.className = 'timer-btn timer-reset-btn';
  resetBtn.title = 'Reset timer';
  resetBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg><span>Reset</span>`;
  resetBtn.addEventListener('pointerdown', e => e.stopPropagation());
  resetBtn.addEventListener('click', e => {
    e.stopPropagation();
    el.running = false;
    el.startedAt = null;
    el.accumulatedMs = 0;
    el.laps = [];
    stopTimerTick(el.id);
    syncTimerNode(node, el);
    sendOp('update', { element: el });
  });

  controls.appendChild(playBtn);
  controls.appendChild(lapBtn);
  controls.appendChild(recordBtn);
  controls.appendChild(resetBtn);

  // Laps container
  const lapsContainer = document.createElement('div');
  lapsContainer.className = 'timer-laps-container';

  mainView.appendChild(displayWrap);
  mainView.appendChild(controls);
  mainView.appendChild(lapsContainer);

  // 3. RECORDS VIEW
  const recordsView = document.createElement('div');
  recordsView.className = 'timer-records-view';
  recordsView.style.display = 'none';

  const recordsHeader = document.createElement('div');
  recordsHeader.className = 'timer-records-header';

  const backBtn = document.createElement('button');
  backBtn.className = 'timer-rec-nav-btn';
  backBtn.title = 'Back to timer';
  backBtn.innerHTML = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><polyline points="12 19 5 12 12 5"/></svg><span>Timer</span>`;
  backBtn.addEventListener('pointerdown', e => e.stopPropagation());
  backBtn.addEventListener('click', e => {
    e.stopPropagation();
    node.dataset.view = 'timer';
    syncTimerNode(node, el);
  });

  const recordsTitle = document.createElement('div');
  recordsTitle.className = 'timer-records-title';
  recordsTitle.textContent = 'Session History';

  const clearRecordsBtn = document.createElement('button');
  clearRecordsBtn.className = 'timer-rec-nav-btn danger';
  clearRecordsBtn.title = 'Clear all recorded sessions';
  clearRecordsBtn.textContent = 'Clear';
  clearRecordsBtn.addEventListener('pointerdown', e => e.stopPropagation());
  clearRecordsBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (!el.records || el.records.length === 0) return;
    el.records = [];
    syncTimerNode(node, el);
    sendOp('update', { element: el });
    showToast('Records cleared');
  });

  recordsHeader.appendChild(backBtn);
  recordsHeader.appendChild(recordsTitle);
  recordsHeader.appendChild(clearRecordsBtn);

  const recordsList = document.createElement('div');
  recordsList.className = 'timer-records-list';

  recordsView.appendChild(recordsHeader);
  recordsView.appendChild(recordsList);

  inner.appendChild(header);
  inner.appendChild(mainView);
  inner.appendChild(recordsView);
  node.appendChild(inner);

  // Initial populate
  node.dataset.view = 'timer';
  syncTimerNode(node, el);
  ensureTimerTick(el);
}

function syncTimerNode(node, el) {
  if (!node) return;
  const isRunning = Boolean(el.running);
  node.classList.toggle('running', isRunning);

  if (!Array.isArray(el.records)) el.records = [];

  // Mode badge
  const modeBtn = node.querySelector('.timer-mode-btn');
  if (modeBtn) {
    modeBtn.textContent = el.mode === 'pomodoro' ? '🍅 Pomodoro' : '⏱️ Stopwatch';
  }

  // Records toggle button count
  const recordsCountEl = node.querySelector('.records-count');
  if (recordsCountEl) {
    recordsCountEl.textContent = el.records.length;
  }

  // Title
  const titleInput = node.querySelector('.timer-title-input');
  if (titleInput && document.activeElement !== titleInput) {
    titleInput.value = el.title || 'Focus Session';
  }

  // View toggle visibility
  const isRecordsView = (node.dataset.view === 'records');
  const mainView = node.querySelector('.timer-main-view');
  const recordsView = node.querySelector('.timer-records-view');
  if (mainView && recordsView) {
    mainView.style.display = isRecordsView ? 'none' : 'flex';
    recordsView.style.display = isRecordsView ? 'flex' : 'none';
  }

  // Digits
  const digits = node.querySelector('.timer-digits');
  if (digits) {
    const ms = getTimerCurrentMs(el);
    digits.textContent = formatTimerTime(ms, ms >= 3600000);
  }

  // Status text
  const statusText = node.querySelector('.timer-status-text');
  if (statusText) {
    if (isRunning) {
      statusText.textContent = el.mode === 'pomodoro' ? 'Focusing' : 'Tracking';
    } else if (el.accumulatedMs > 0) {
      statusText.textContent = 'Paused';
    } else {
      statusText.textContent = 'Ready';
    }
  }

  // Play button text & icon
  const playBtn = node.querySelector('.timer-play-btn');
  if (playBtn) {
    if (isRunning) {
      playBtn.className = 'timer-btn primary timer-play-btn pause-state';
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg><span>Pause</span>`;
    } else {
      playBtn.className = 'timer-btn primary timer-play-btn';
      playBtn.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><polygon points="5 3 19 12 5 21 5 3"/></svg><span>${el.accumulatedMs > 0 ? 'Resume' : 'Start'}</span>`;
    }
  }

  // Laps list
  const lapsContainer = node.querySelector('.timer-laps-container');
  if (lapsContainer) {
    lapsContainer.innerHTML = '';
    if (Array.isArray(el.laps) && el.laps.length > 0) {
      el.laps.forEach((lap, idx) => {
        const row = document.createElement('div');
        row.className = 'timer-lap-row';
        const num = el.laps.length - idx;
        row.innerHTML = `<span>Lap ${num}</span><span>${formatTimerTime(lap.timeMs, lap.timeMs >= 3600000)}</span>`;
        lapsContainer.appendChild(row);
      });
    }
  }

  // Records list
  if (recordsView) {
    const listContainer = recordsView.querySelector('.timer-records-list');
    if (listContainer) {
      listContainer.innerHTML = '';
      if (el.records.length === 0) {
        listContainer.innerHTML = `<div class="timer-records-empty">No recorded sessions yet.<br>Click <strong>Record</strong> to save one!</div>`;
      } else {
        el.records.forEach((rec, idx) => {
          const item = document.createElement('div');
          item.className = 'timer-record-item';

          const timeFormatted = formatTimerTime(rec.durationMs, rec.durationMs >= 3600000);
          const dateFormatted = formatRecordDate(rec.completedAt);
          const modeIcon = rec.mode === 'pomodoro' ? '🍅' : '⏱️';

          item.innerHTML = `
            <div class="timer-record-top">
              <span class="timer-record-title" title="${escapeHtml(rec.title || 'Session')}">${escapeHtml(rec.title || 'Session')}</span>
              <span class="timer-record-duration">${modeIcon} ${timeFormatted}</span>
            </div>
            <div class="timer-record-meta">
              <span>${dateFormatted}${rec.lapsCount ? ` • ${rec.lapsCount} lap${rec.lapsCount > 1 ? 's' : ''}` : ''}</span>
              <div class="timer-record-actions">
                <button class="timer-rec-btn pin-btn" title="Pin as note card onto canvas">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 2h6l1 7H8l1-7z"/><path d="M5 9h14l-1 8H6L5 9z"/></svg>
                  <span>Note</span>
                </button>
                <button class="timer-rec-btn del-btn" title="Delete record">
                  <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
              </div>
            </div>
          `;

          const pinBtn = item.querySelector('.pin-btn');
          pinBtn.addEventListener('pointerdown', e => e.stopPropagation());
          pinBtn.addEventListener('click', e => {
            e.stopPropagation();
            pinRecordToNote(el, rec);
          });

          const delBtn = item.querySelector('.del-btn');
          delBtn.addEventListener('pointerdown', e => e.stopPropagation());
          delBtn.addEventListener('click', e => {
            e.stopPropagation();
            el.records.splice(idx, 1);
            syncTimerNode(node, el);
            sendOp('update', { element: el });
          });

          listContainer.appendChild(item);
        });
      }
    }
  }

  // Keep interval in sync
  ensureTimerTick(el);
}

function buildDrawContent(node, el) {
  // Make bounding div invisible inline
  node.style.background = 'transparent';
  node.style.border = 'none';
  node.style.boxShadow = 'none';
  node.style.borderRadius = '0';
  node.style.overflow = 'visible';

  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.style.width = '100%';
  svg.style.height = '100%';
  svg.style.overflow = 'visible';
  svg.style.display = 'block';
  node.appendChild(svg);
  syncDrawSVG(node, el);
}

function syncDrawSVG(node, el) {
  const svg = node.querySelector('svg');
  if (!svg) return;
  svg.innerHTML = '';
  if (!el.points || el.points.length < 2) return;

  const c = SHAPE_COLORS[el.color] || SHAPE_COLORS.blueprint;
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  let d = '';
  el.points.forEach((p, i) => {
    const lx = p.x - el.x;
    const ly = p.y - el.y;
    d += (i === 0 ? `M ${lx} ${ly}` : ` L ${lx} ${ly}`);
  });
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', c.stroke);
  path.setAttribute('stroke-width', '3');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(path);
}

// ─────────────────────────────────────────────────────────────
// VOICE NOTE ELEMENT LOGIC
// ─────────────────────────────────────────────────────────────
const voicePlayers   = new Map(); // id -> { audio, updateProgressUI }
const voiceRecorders = new Map(); // id -> { mediaRecorder, stream, audioCtx, animId, timerId, chunks, rawSamples }

function formatAudioTime(sec) {
  if (!sec || isNaN(sec) || !isFinite(sec)) return '00:00';
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${String(m).padStart(2, '0')}:${String(remS).padStart(2, '0')}`;
}

function downsampleWaveform(rawSamples, targetCount = 28) {
  if (!rawSamples || rawSamples.length === 0) {
    return Array.from({ length: targetCount }, (_, i) => +(0.25 + 0.35 * Math.sin(i * 0.4) + 0.2 * Math.cos(i * 0.7)).toFixed(2));
  }
  const result = [];
  const chunkSize = rawSamples.length / targetCount;
  for (let i = 0; i < targetCount; i++) {
    const start = Math.floor(i * chunkSize);
    const end = Math.min(rawSamples.length, Math.floor((i + 1) * chunkSize));
    let sum = 0, count = 0;
    for (let j = start; j < end; j++) {
      sum += rawSamples[j];
      count++;
    }
    const avg = count ? (sum / count) : 0.2;
    result.push(+Math.max(0.15, Math.min(1.0, avg)).toFixed(2));
  }
  return result;
}

function cleanupVoiceNode(id) {
  const p = voicePlayers.get(id);
  if (p) {
    if (p.audio) { p.audio.pause(); p.audio.src = ''; }
    voicePlayers.delete(id);
  }
  const r = voiceRecorders.get(id);
  if (r) {
    try { if (r.stream) r.stream.getTracks().forEach(t => t.stop()); } catch(_) {}
    try { if (r.audioCtx && r.audioCtx.state !== 'closed') r.audioCtx.close(); } catch(_) {}
    if (r.animId) cancelAnimationFrame(r.animId);
    if (r.timerId) clearInterval(r.timerId);
    voiceRecorders.delete(id);
  }
}

function buildVoiceContent(node, el) {
  node.classList.add('voice-element');
  const inner = document.createElement('div');
  inner.className = 'voice-card-inner';

  // 1. Header: Icon + Title Input + Delete Button
  const header = document.createElement('div');
  header.className = 'voice-header';

  const titleWrap = document.createElement('div');
  titleWrap.className = 'voice-title-wrap';

  const icon = document.createElement('div');
  icon.className = 'voice-icon';
  icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/><line x1="8" y1="22" x2="16" y2="22"/></svg>`;

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'voice-title-input';
  titleInput.value = el.title || 'Voice Note';
  titleInput.placeholder = 'Voice Note...';
  titleInput.addEventListener('pointerdown', e => e.stopPropagation());
  titleInput.addEventListener('keydown', e => {
    e.stopPropagation();
    if (e.key === 'Enter') titleInput.blur();
  });
  titleInput.addEventListener('change', () => {
    el.title = titleInput.value.trim() || 'Voice Note';
    sendOp('update', { element: el });
  });

  titleWrap.appendChild(icon);
  titleWrap.appendChild(titleInput);

  const delBtn = document.createElement('button');
  delBtn.className = 'voice-del-btn';
  delBtn.title = 'Delete voice note';
  delBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  delBtn.addEventListener('pointerdown', e => e.stopPropagation());
  delBtn.addEventListener('click', e => {
    e.stopPropagation();
    cleanupVoiceNode(el.id);
    dropNode(el.id);
    delete elements[el.id];
    selectedIds.delete(el.id);
    sendOp('delete', { id: el.id });
    syncSelectionUI();
  });

  header.appendChild(titleWrap);
  header.appendChild(delBtn);
  inner.appendChild(header);

  // 2. Body Container
  const body = document.createElement('div');
  body.className = 'voice-body';
  inner.appendChild(body);
  node.appendChild(inner);

  renderVoiceBody(node, el, body);
}

function renderVoiceBody(node, el, body) {
  cleanupVoiceNode(el.id);
  body.innerHTML = '';
  node.dataset.audioUrl = el.audioUrl || '';

  if (el.audioUrl) {
    renderVoicePlayer(node, el, body);
  } else {
    renderVoiceIdle(node, el, body);
  }
}

function saveAndUploadVoiceNote(node, el, body, base64Data, ext, finalDuration, finalWaveform) {
  showToast('💾 Uploading voice note...');
  const filename = `voice_${Date.now()}.${ext}`;

  // If in Android offline mode, save locally directly
  if (window.AndroidBridge && typeof window.AndroidBridge.isOffline === 'function' && window.AndroidBridge.isOffline()) {
    if (typeof window.AndroidBridge.saveLocalFile === 'function') {
      const localUrl = window.AndroidBridge.saveLocalFile(filename, base64Data);
      if (localUrl) {
        el.audioUrl = localUrl;
        el.duration = finalDuration;
        el.waveform = finalWaveform;
        renderVoiceBody(node, el, body);
        showToast('🎙️ Voice note saved locally!');
        return;
      }
    }
  }

  fetch('/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, fileData: base64Data })
  })
  .then(r => r.json())
  .then(data => {
    if (data && data.url) {
      el.audioUrl = data.url;
      el.duration = finalDuration;
      el.waveform = finalWaveform;
      renderVoiceBody(node, el, body);
      sendOp('update', { element: el });
      showToast('🎙️ Voice note saved!');
    } else {
      showToast('❌ Failed to upload audio');
      renderVoiceBody(node, el, body);
    }
  })
  .catch(err => {
    console.error('Upload error:', err);
    // Fallback to saving locally if server unreachable
    if (window.AndroidBridge && typeof window.AndroidBridge.saveLocalFile === 'function') {
      const localUrl = window.AndroidBridge.saveLocalFile(filename, base64Data);
      if (localUrl) {
        el.audioUrl = localUrl;
        el.duration = finalDuration;
        el.waveform = finalWaveform;
        renderVoiceBody(node, el, body);
        showToast('🎙️ Saved locally (offline)');
        return;
      }
    }
    showToast('❌ Network error uploading voice note');
    renderVoiceBody(node, el, body);
  });
}

function startNativeVoiceRecording(node, el, body) {
  body.innerHTML = '';
  const started = window.AndroidBridge.startNativeRecording();
  if (!started) {
    showToast('❌ Could not start microphone recording');
    renderVoiceBody(node, el, body);
    return;
  }

  const rawSamples = [];
  let elapsedSeconds = 0;

  // Build Active Recording UI
  const recWrap = document.createElement('div');
  recWrap.className = 'voice-recording-wrap';

  const recBadge = document.createElement('div');
  recBadge.className = 'voice-rec-badge';
  recBadge.innerHTML = `<div class="voice-rec-dot-pulsing"></div><span>REC</span>`;

  const timeEl = document.createElement('div');
  timeEl.className = 'voice-live-time';
  timeEl.textContent = '00:00';

  const eqWrap = document.createElement('div');
  eqWrap.className = 'voice-live-eq';
  const eqBars = [];
  for (let i = 0; i < 14; i++) {
    const b = document.createElement('div');
    b.className = 'voice-eq-bar';
    eqWrap.appendChild(b);
    eqBars.push(b);
  }

  const actions = document.createElement('div');
  actions.className = 'voice-rec-actions';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'voice-stop-btn';
  stopBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Done`;
  stopBtn.addEventListener('pointerdown', e => e.stopPropagation());

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'voice-cancel-btn';
  cancelBtn.title = 'Cancel recording';
  cancelBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  cancelBtn.addEventListener('pointerdown', e => e.stopPropagation());

  actions.appendChild(stopBtn);
  actions.appendChild(cancelBtn);

  recWrap.appendChild(recBadge);
  recWrap.appendChild(timeEl);
  recWrap.appendChild(eqWrap);
  recWrap.appendChild(actions);
  body.appendChild(recWrap);

  // Timer loop
  const timerId = setInterval(() => {
    elapsedSeconds++;
    timeEl.textContent = formatAudioTime(elapsedSeconds);
  }, 1000);

  // EQ volume sampling loop using AndroidBridge.getNativeAmplitude()
  const ampIntervalId = setInterval(() => {
    try {
      if (window.AndroidBridge && typeof window.AndroidBridge.getNativeAmplitude === 'function') {
        const amp = window.AndroidBridge.getNativeAmplitude();
        const norm = Math.min(1, Math.max(0.05, amp / 16000));
        rawSamples.push(norm);

        eqBars.forEach((b, idx) => {
          const jitter = 0.6 + (Math.sin(idx + Date.now() / 150) * 0.4);
          const h = Math.max(4, Math.min(22, Math.round(norm * jitter * 24)));
          b.style.height = `${h}px`;
        });
      }
    } catch (_) {}
  }, 100);

  const cleanup = () => {
    clearInterval(timerId);
    clearInterval(ampIntervalId);
    voiceRecorders.delete(el.id);
  };

  voiceRecorders.set(el.id, { cleanup });

  // Cancel Handler
  cancelBtn.addEventListener('click', e => {
    e.stopPropagation();
    cleanup();
    if (window.AndroidBridge && typeof window.AndroidBridge.cancelNativeRecording === 'function') {
      window.AndroidBridge.cancelNativeRecording();
    }
    renderVoiceBody(node, el, body);
  });

  // Stop / Done Handler
  stopBtn.addEventListener('click', e => {
    e.stopPropagation();
    stopBtn.disabled = true;
    stopBtn.textContent = 'Saving...';

    cleanup();

    let base64Data = null;
    if (window.AndroidBridge && typeof window.AndroidBridge.stopNativeRecording === 'function') {
      base64Data = window.AndroidBridge.stopNativeRecording();
    }

    if (!base64Data) {
      showToast('❌ Failed to capture audio recording');
      renderVoiceBody(node, el, body);
      return;
    }

    const finalDuration = elapsedSeconds || 1;
    const finalWaveform = downsampleWaveform(rawSamples, 28);
    saveAndUploadVoiceNote(node, el, body, base64Data, 'm4a', finalDuration, finalWaveform);
  });
}

function renderVoiceIdle(node, el, body) {
  const idleWrap = document.createElement('div');
  idleWrap.className = 'voice-idle-wrap';

  const recBtn = document.createElement('button');
  recBtn.className = 'voice-record-btn';
  recBtn.innerHTML = `<div class="voice-record-dot"></div><span>Record</span>`;
  recBtn.addEventListener('pointerdown', e => e.stopPropagation());
  recBtn.addEventListener('click', e => {
    e.stopPropagation();

    // 1. Android Native Recording Support (bypasses HTTP insecure-context restriction)
    if (window.AndroidBridge && typeof window.AndroidBridge.isVoiceRecordingSupported === 'function' && window.AndroidBridge.isVoiceRecordingSupported()) {
      if (typeof window.AndroidBridge.hasAudioPermission === 'function' && !window.AndroidBridge.hasAudioPermission()) {
        if (typeof window.AndroidBridge.requestAudioPermission === 'function') {
          window.AndroidBridge.requestAudioPermission();
        }
        showToast('🎙️ Please allow microphone permission');
        return;
      }
      startNativeVoiceRecording(node, el, body);
      return;
    }

    // 2. Standard Browser Web Audio Recording
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showToast('❌ Audio recording is not supported in this browser');
      return;
    }
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(stream => {
        startVoiceRecording(node, el, body, stream);
      })
      .catch(err => {
        console.error('Mic access error:', err);
        showToast('❌ Microphone permission denied');
      });
  });

  const hint = document.createElement('div');
  hint.className = 'voice-idle-hint';
  hint.textContent = 'Click to record voice memo';

  idleWrap.appendChild(recBtn);
  idleWrap.appendChild(hint);
  body.appendChild(idleWrap);
}

function startVoiceRecording(node, el, body, stream) {
  body.innerHTML = '';

  // Setup Web Audio Analyser
  let audioCtx = null;
  let analyser = null;
  let dataArray = null;
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) {
      audioCtx = new AudioCtx();
      const source = audioCtx.createMediaStreamSource(stream);
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = 64;
      source.connect(analyser);
      dataArray = new Uint8Array(analyser.frequencyBinCount);
    }
  } catch (err) {
    console.warn('AudioContext not available:', err);
  }

  // Setup MediaRecorder
  let mimeType = '';
  const candidateTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
  for (const t of candidateTypes) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(t)) {
      mimeType = t;
      break;
    }
  }

  let mediaRecorder;
  try {
    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  } catch (e) {
    mediaRecorder = new MediaRecorder(stream);
  }

  const chunks = [];
  mediaRecorder.ondataavailable = e => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  };

  const rawSamples = [];
  let elapsedSeconds = 0;

  // Build Active Recording UI
  const recWrap = document.createElement('div');
  recWrap.className = 'voice-recording-wrap';

  const recBadge = document.createElement('div');
  recBadge.className = 'voice-rec-badge';
  recBadge.innerHTML = `<div class="voice-rec-dot-pulsing"></div><span>REC</span>`;

  const timeEl = document.createElement('div');
  timeEl.className = 'voice-live-time';
  timeEl.textContent = '00:00';

  const eqWrap = document.createElement('div');
  eqWrap.className = 'voice-live-eq';
  const eqBars = [];
  for (let i = 0; i < 14; i++) {
    const b = document.createElement('div');
    b.className = 'voice-eq-bar';
    eqWrap.appendChild(b);
    eqBars.push(b);
  }

  const actions = document.createElement('div');
  actions.className = 'voice-rec-actions';

  const stopBtn = document.createElement('button');
  stopBtn.className = 'voice-stop-btn';
  stopBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="currentColor" width="12" height="12"><rect x="4" y="4" width="16" height="16" rx="2"/></svg> Done`;
  stopBtn.addEventListener('pointerdown', e => e.stopPropagation());

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'voice-cancel-btn';
  cancelBtn.title = 'Cancel recording';
  cancelBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" width="14" height="14"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
  cancelBtn.addEventListener('pointerdown', e => e.stopPropagation());

  actions.appendChild(stopBtn);
  actions.appendChild(cancelBtn);

  recWrap.appendChild(recBadge);
  recWrap.appendChild(timeEl);
  recWrap.appendChild(eqWrap);
  recWrap.appendChild(actions);
  body.appendChild(recWrap);

  // Timer loop
  const timerId = setInterval(() => {
    elapsedSeconds++;
    timeEl.textContent = formatAudioTime(elapsedSeconds);
  }, 1000);

  // Animation frame loop for EQ and volume sampling
  let animId = null;
  const updateEQ = () => {
    if (analyser && dataArray) {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) {
        sum += dataArray[i];
      }
      const avg = sum / (dataArray.length * 255);
      rawSamples.push(avg);

      // Animate eqBars
      eqBars.forEach((b, idx) => {
        const val = (dataArray[idx % dataArray.length] / 255) || 0.1;
        const h = Math.max(4, Math.min(22, Math.round(val * 24)));
        b.style.height = `${h}px`;
      });
    }
    animId = requestAnimationFrame(updateEQ);
  };
  animId = requestAnimationFrame(updateEQ);

  voiceRecorders.set(el.id, { mediaRecorder, stream, audioCtx, animId, timerId, chunks, rawSamples });

  // Cancel Handler
  cancelBtn.addEventListener('click', e => {
    e.stopPropagation();
    cleanupVoiceNode(el.id);
    renderVoiceBody(node, el, body);
  });

  // Stop Handler
  stopBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (mediaRecorder.state !== 'inactive') {
      stopBtn.disabled = true;
      stopBtn.textContent = 'Saving...';
      mediaRecorder.onstop = () => {
        const blob = new Blob(chunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const finalDuration = elapsedSeconds || 1;
        const finalWaveform = downsampleWaveform(rawSamples, 28);

        cleanupVoiceNode(el.id);

        const reader = new FileReader();
        reader.onloadend = () => {
          const base64Data = reader.result;
          const ext = (mediaRecorder.mimeType && mediaRecorder.mimeType.includes('mp4')) ? 'mp4' : 'webm';
          saveAndUploadVoiceNote(node, el, body, base64Data, ext, finalDuration, finalWaveform);
        };
        reader.readAsDataURL(blob);
      };

      try { mediaRecorder.stop(); } catch (_) {}
    }
  });

  mediaRecorder.start(250);
}

function renderVoicePlayer(node, el, body) {
  const playerWrap = document.createElement('div');
  playerWrap.className = 'voice-player-wrap';

  // Audio element
  const audio = new Audio(el.audioUrl);
  audio.preload = 'metadata';

  // Play / Pause Button
  const playBtn = document.createElement('button');
  playBtn.className = 'voice-play-btn';
  playBtn.title = 'Play';
  const playSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><polygon points="6 3 20 12 6 21 6 3"/></svg>`;
  const pauseSvg = `<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>`;
  playBtn.innerHTML = playSvg;
  playBtn.addEventListener('pointerdown', e => e.stopPropagation());

  // Center: Waveform + Time
  const centerWrap = document.createElement('div');
  centerWrap.className = 'voice-player-center';

  const waveWrap = document.createElement('div');
  waveWrap.className = 'voice-waveform-wrap';
  waveWrap.addEventListener('pointerdown', e => e.stopPropagation());

  const waveBars = [];
  const waveformData = (el.waveform && el.waveform.length) ? el.waveform : downsampleWaveform([], 28);
  waveformData.forEach(val => {
    const bar = document.createElement('div');
    bar.className = 'voice-waveform-bar';
    const h = Math.max(6, Math.min(26, Math.round(val * 26)));
    bar.style.height = `${h}px`;
    waveWrap.appendChild(bar);
    waveBars.push(bar);
  });

  // Seeking on waveform
  const handleSeek = (clientX) => {
    const r = waveWrap.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const targetTime = pct * (audio.duration || el.duration || 0);
    audio.currentTime = targetTime;
    updateProgressUI();
  };

  waveWrap.addEventListener('click', e => {
    e.stopPropagation();
    handleSeek(e.clientX);
  });

  const metaRow = document.createElement('div');
  metaRow.className = 'voice-player-meta';

  const curTimeEl = document.createElement('span');
  curTimeEl.textContent = '00:00';

  const durTimeEl = document.createElement('span');
  durTimeEl.textContent = formatAudioTime(el.duration);

  metaRow.appendChild(curTimeEl);
  metaRow.appendChild(durTimeEl);

  centerWrap.appendChild(waveWrap);
  centerWrap.appendChild(metaRow);

  // Right actions: Speed + Re-record
  const rightWrap = document.createElement('div');
  rightWrap.className = 'voice-player-right';

  let currentSpeed = 1.0;
  const speedBtn = document.createElement('button');
  speedBtn.className = 'voice-speed-btn';
  speedBtn.textContent = '1x';
  speedBtn.title = 'Change playback speed';
  speedBtn.addEventListener('pointerdown', e => e.stopPropagation());
  speedBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (currentSpeed === 1.0) currentSpeed = 1.5;
    else if (currentSpeed === 1.5) currentSpeed = 2.0;
    else currentSpeed = 1.0;
    audio.playbackRate = currentSpeed;
    speedBtn.textContent = currentSpeed + 'x';
  });

  const rerecordBtn = document.createElement('button');
  rerecordBtn.className = 'voice-rerecord-btn';
  rerecordBtn.title = 'Re-record voice memo';
  rerecordBtn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/></svg>`;
  rerecordBtn.addEventListener('pointerdown', e => e.stopPropagation());
  rerecordBtn.addEventListener('click', e => {
    e.stopPropagation();
    audio.pause();
    el.audioUrl = '';
    el.waveform = [];
    el.duration = 0;
    renderVoiceBody(node, el, body);
    sendOp('update', { element: el });
  });

  rightWrap.appendChild(speedBtn);
  rightWrap.appendChild(rerecordBtn);

  playerWrap.appendChild(playBtn);
  playerWrap.appendChild(centerWrap);
  playerWrap.appendChild(rightWrap);
  body.appendChild(playerWrap);

  const updateProgressUI = () => {
    curTimeEl.textContent = formatAudioTime(audio.currentTime);
    const totalDur = audio.duration || el.duration || 1;
    const progress = Math.max(0, Math.min(1, audio.currentTime / totalDur));
    const activeIndex = Math.floor(progress * waveBars.length);
    waveBars.forEach((bar, idx) => {
      bar.classList.toggle('played', idx <= activeIndex);
    });
  };

  audio.addEventListener('loadedmetadata', () => {
    if (audio.duration && isFinite(audio.duration)) {
      durTimeEl.textContent = formatAudioTime(audio.duration);
    }
  });

  audio.addEventListener('timeupdate', updateProgressUI);

  audio.addEventListener('ended', () => {
    playBtn.innerHTML = playSvg;
    audio.currentTime = 0;
    updateProgressUI();
  });

  playBtn.addEventListener('click', e => {
    e.stopPropagation();
    if (audio.paused) {
      // Pause any other playing voice notes
      voicePlayers.forEach((p, otherId) => {
        if (otherId !== el.id && p.audio) {
          p.audio.pause();
        }
      });
      audio.play().then(() => {
        playBtn.innerHTML = pauseSvg;
      }).catch(err => {
        console.error('Play error:', err);
      });
    } else {
      audio.pause();
      playBtn.innerHTML = playSvg;
    }
  });

  voicePlayers.set(el.id, { audio, updateProgressUI });
}

function syncVoiceNode(node, el) {
  const titleInput = node.querySelector('.voice-title-input');
  if (titleInput && document.activeElement !== titleInput) {
    titleInput.value = el.title || 'Voice Note';
  }
  const currentUrl = node.dataset.audioUrl || '';
  if (currentUrl !== (el.audioUrl || '')) {
    node.dataset.audioUrl = el.audioUrl || '';
    const body = node.querySelector('.voice-body');
    if (body) renderVoiceBody(node, el, body);
  }
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

  let shapeTypingTimer = null;

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
    if (shapeTypingTimer) {
      clearTimeout(shapeTypingTimer);
      shapeTypingTimer = null;
    }
    ta.style.display = 'none';
    view.style.display = '';
    wrap.classList.remove('editing');
    node.classList.remove('shape-editing');

    const stored = elements[el.id];
    if (!stored) return;
    const newText = ta.value;
    view.textContent = newText;
    view.classList.toggle('empty', !newText.trim());
    stored.text = newText;
    sendOp('update', { element: stored });
  }

  // ── Event listeners ────────────────────────────────────
  // Prevent drag starting when clicking inside the edit textarea
  ta.addEventListener('pointerdown', e => e.stopPropagation());
  // Keep local state in sync while typing
  ta.addEventListener('input', () => {
    const stored = elements[el.id];
    if (stored) {
      stored.text = ta.value;
      if (shapeTypingTimer) clearTimeout(shapeTypingTimer);
      shapeTypingTimer = setTimeout(() => {
        sendOp('update', { element: stored });
      }, 100);
    }
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
      ta.style.height = 'auto';
      ta.style.height = ta.scrollHeight + 'px';
      const body = node.querySelector('.note-body');
      if (body) body.classList.toggle('has-content', (el.text || '').trim().length > 0);
    }
    // Sync font size from remote
    if (el.fontSize) node.style.setProperty('--note-font-size', `${el.fontSize}px`);
  } else if (el.type === 'image') {
    const img = node.querySelector('img');
    if (img) img.src = el.url || '';
  } else if (el.type === 'file' || el.type === 'link') {
    // file and link elements do not use SVG
  } else if (el.type === 'timer') {
    syncTimerNode(node, el);
  } else if (el.type === 'voice') {
    syncVoiceNode(node, el);
  } else if (el.type === 'draw') {
    syncDrawSVG(node, el);
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
  stopTimerTick(id);
  cleanupVoiceNode(id);
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
  viewport.addEventListener('contextmenu',   e => {
    if (e.target === world || e.target === viewport) e.preventDefault();
  });

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
    if (fileItem) {
      e.preventDefault();
      const blob = fileItem.getAsFile();
      // Place at canvas centre
      const r  = viewport.getBoundingClientRect();
      const cp = clientToWorld(r.width / 2, r.height / 2);
      uploadAndPlaceFile(blob, cp.x, cp.y);
      return;
    }

    const textItem = items.find(i => i.type === 'text/plain');
    if (textItem) {
      textItem.getAsString(async text => {
        const url = text.trim();
        if (/^https?:\/\//i.test(url)) {
          e.preventDefault();
          showToast('🔗 Fetching link preview...');
          const r = viewport.getBoundingClientRect();
          const cp = clientToWorld(r.width / 2, r.height / 2);
          try {
            const res = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
            const data = await res.json();
            if (data.isImage && data.image) {
              placeImageAt(data.image, cp.x, cp.y);
            } else {
              placeLinkCard(data, cp.x, cp.y);
            }
          } catch (_) {
            try {
              const parsed = new URL(url);
              placeLinkCard({ url, title: parsed.hostname, domain: parsed.hostname.replace(/^www\./, '') }, cp.x, cp.y);
            } catch (err) {}
          }
        }
      });
    }
  });
}

// ── Helper: upload File → Server → place on board ─────────────
function uploadAndPlaceFile(file, cx, cy) {
  if (file.size > 200 * 1024 * 1024) {
    showToast('❌ File too large (max 200 MB)');
    return;
  }
  showToast('⏳ Uploading...');
  const reader = new FileReader();
  reader.onload = async ev => {
    const isImage = file.type.startsWith('image/');
    const host = resolveServerHost();
    const uploadUrl = (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
      ? (host ? `http://${host}/upload` : '/upload')
      : '/upload';
    try {
      const res = await fetch(uploadUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name || 'PastedFile', fileData: ev.target.result })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      
      if (isImage) {
        placeImageAt(data.url, cx, cy);
      } else {
        placeFileAt(data.url, file.name || 'File', cx, cy);
      }
      showToast('✅ Upload complete');
    } catch (e) {
      if (isImage) {
        // Fallback in offline mode: place the image locally using the data URL
        placeImageAt(ev.target.result, cx, cy);
        showToast('✅ Image placed locally (Offline)');
      } else {
        if (window.AndroidBridge && window.AndroidBridge.saveLocalFile) {
          try {
            const localUrl = window.AndroidBridge.saveLocalFile(file.name || 'Document.pdf', ev.target.result);
            if (localUrl) {
              placeFileAt(localUrl, file.name || 'Document', cx, cy);
              showToast('✅ File saved locally (Offline)');
              return;
            }
          } catch (err) {
            console.error('saveLocalFile error:', err);
          }
        }
        placeFileAt(ev.target.result, file.name || 'File', cx, cy);
        showToast('✅ File placed locally (Offline)');
      }
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

  // ── Freehand draw tool ──────────────────────────────────
  if (activeTool === 'draw') {
    const wp = clientToWorld(e.clientX, e.clientY);
    isDrawingFreehand = true;
    const id = 'e' + Math.random().toString(36).slice(2, 11);
    drawFreehandId = id;
    const el = { id, type: 'draw', color: 'blueprint', zIndex: nextZ(), x: wp.x, y: wp.y, w: 1, h: 1, points: [{x: wp.x, y: wp.y}] };
    elements[id] = el;
    mountElement(el, false);
    return;
  }

  // ── Non-select tools → create element ──────────────────
  if (activeTool !== 'select') {
    const wp = clientToWorld(e.clientX, e.clientY);
    createElement(activeTool, wp.x, wp.y);
    setActiveTool('select');
    return;
  }

  // ── Canvas navigation: Spacebar, middle mouse, right-click, or touch pan ──
  if (isSpaceHeld || e.button === 1 || e.button === 2 || (e.pointerType === 'touch' && !e.shiftKey)) {
    if (e.target === world || e.target === viewport) {
      isDraggingCanvas = true;
      canvasDragStartClientX = e.clientX;
      canvasDragStartClientY = e.clientY;
      canvasDragStartPanX    = panX;
      canvasDragStartPanY    = panY;
    }
    return;
  }

  // ── Left-click on empty canvas → Windows File Manager Marquee Selection ──
  if ((e.target === world || e.target === viewport) && e.button === 0) {
    marqueeAdditive = e.shiftKey || e.ctrlKey || e.metaKey;
    if (!marqueeAdditive) {
      deselect();
      initialMarqueeSelection.clear();
    } else {
      initialMarqueeSelection = new Set(selectedIds);
    }
    isDragSelecting = true;
    marqueeStart    = { x: e.clientX, y: e.clientY };
    createMarquee();
    updateMarquee(e.clientX, e.clientY);
    return;
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

  // ── Freehand draw tracking (smooth real-time ink, no bbox jumping) ──
  if (isDrawingFreehand && drawFreehandId) {
    const el = elements[drawFreehandId];
    if (el) {
      el.points.push({x: wp.x, y: wp.y});
      const node = elementNodes.get(drawFreehandId);
      if (node) {
        const path = node.querySelector('path');
        if (!path) {
          syncDrawSVG(node, el);
        } else {
          const lx = wp.x - el.x;
          const ly = wp.y - el.y;
          path.setAttribute('d', path.getAttribute('d') + ` L ${lx} ${ly}`);
        }
      }
    }
    return;
  }

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
      clickedAlreadySelected = null; // Dragging has begun; do not narrow selection on mouse up
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
        // Break bind only if bound target isn't also being moved in this selection
        if (el.startBind && !selectedIds.has(el.startBind)) delete el.startBind;
        if (el.endBind && !selectedIds.has(el.endBind)) delete el.endBind;
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

  // ── Finalize freehand drawing ──────────────────────────
  if (isDrawingFreehand) {
    isDrawingFreehand = false;
    if (drawFreehandId) {
      const el = elements[drawFreehandId];
      if (el && el.points && el.points.length > 1) {
        fixBBox(el);
        syncNode(el);
        sendOp('add', { element: el });
        select(drawFreehandId, false);
      } else if (el) {
        delete elements[drawFreehandId];
        const n = elementNodes.get(drawFreehandId);
        if (n) { n.remove(); elementNodes.delete(drawFreehandId); }
      }
      drawFreehandId = null;
    }
    return;
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

  // Handle click on an already-selected element that was NOT dragged (simple click)
  if (clickedAlreadySelected && !dragThresholdMet) {
    if (clickedAdditive) {
      selectedIds.delete(clickedAlreadySelected);
      if (elements[clickedAlreadySelected]) syncNode(elements[clickedAlreadySelected]);
      syncSelectionUI();
    } else {
      select(clickedAlreadySelected, false);
    }
  }
  clickedAlreadySelected = null;
  clickedAdditive = false;

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

  if (selectedIds.has(id)) {
    // In Windows File Manager style:
    // If the element is already selected, do NOT deselect other items on pointerdown.
    // This allows grabbing any item in the selection to move the whole group!
    clickedAlreadySelected = id;
    clickedAdditive = additive;
  } else {
    clickedAlreadySelected = null;
    clickedAdditive = false;
    select(id, additive);
  }

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

  if (w < 4 && h < 4) return;

  const tl = clientToWorld(x, y);
  const br = clientToWorld(x + w, y + h);

  const prevSelected = new Set(selectedIds);
  selectedIds.clear();

  Object.values(elements).forEach(el => {
    let inRect = false;
    if (el.type === 'line' || el.type === 'arrow') {
      const minX = Math.min(el.x1, el.x2);
      const maxX = Math.max(el.x1, el.x2);
      const minY = Math.min(el.y1, el.y2);
      const maxY = Math.max(el.y1, el.y2);
      inRect = (minX < br.x && maxX > tl.x && minY < br.y && maxY > tl.y);
    } else {
      inRect = (el.x < br.x && el.x + el.w > tl.x &&
                el.y < br.y && el.y + el.h > tl.y);
    }

    if (inRect || (marqueeAdditive && initialMarqueeSelection.has(el.id))) {
      selectedIds.add(el.id);
    }
  });

  let changed = false;
  Object.values(elements).forEach(el => {
    const was = prevSelected.has(el.id);
    const is = selectedIds.has(el.id);
    if (was !== is) {
      syncNode(el);
      changed = true;
    }
  });
  if (changed || prevSelected.size !== selectedIds.size) {
    syncSelectionUI();
  }
}

function finishMarquee(cx, cy) {
  if (marqueeEl) {
    marqueeEl.remove();
    marqueeEl = null;
  }
  isDragSelecting = false;
  initialMarqueeSelection.clear();
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
  } else if (type === 'timer') {
    Object.assign(el, {
      x: wx - 140, y: wy - 112, w: 280, h: 225,
      title: 'Focus Session', mode: 'stopwatch',
      accumulatedMs: 0, running: false, startedAt: null,
      pomodoroDurationMs: 25 * 60 * 1000, laps: [],
      records: []
    });
  } else if (type === 'voice') {
    Object.assign(el, {
      x: wx - 150, y: wy - 65, w: 300, h: 130,
      title: 'Voice Note',
      color: 'purple',
      audioUrl: '',
      duration: 0,
      waveform: []
    });
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
// DUPLICATE SELECTED
// ─────────────────────────────────────────────────────────────
function duplicateSelected() {
  if (!selectedIds.size) return;
  const newIds = [];
  const offset = 24;
  const idMap = new Map();

  selectedIds.forEach(id => {
    const orig = elements[id];
    if (!orig) return;
    const newId = 'e' + Math.random().toString(36).slice(2, 11);
    idMap.set(id, newId);
    const clone = JSON.parse(JSON.stringify(orig));
    clone.id = newId;
    clone.zIndex = nextZ();
    if (clone.type === 'line' || clone.type === 'arrow') {
      clone.x1 += offset; clone.y1 += offset;
      clone.x2 += offset; clone.y2 += offset;
    } else {
      clone.x += offset;
      clone.y += offset;
      if (clone.type === 'draw' && Array.isArray(clone.points)) {
        clone.points = clone.points.map(pt => ({ x: pt.x + offset, y: pt.y + offset }));
      }
    }
    elements[newId] = clone;
    newIds.push(newId);
  });

  newIds.forEach(nid => {
    const el = elements[nid];
    if (el && (el.type === 'line' || el.type === 'arrow')) {
      if (el.startBind && idMap.has(el.startBind)) {
        el.startBind = idMap.get(el.startBind);
      } else {
        delete el.startBind;
      }
      if (el.endBind && idMap.has(el.endBind)) {
        el.endBind = idMap.get(el.endBind);
      } else {
        delete el.endBind;
      }
      fixBBox(el);
    }
    mountElement(el, true);
    sendOp('add', { element: el });
  });

  selectedIds.clear();
  newIds.forEach(nid => selectedIds.add(nid));
  Object.values(elements).forEach(el => syncNode(el));
  syncSelectionUI();
  showToast(`Duplicated ${newIds.length} item${newIds.length > 1 ? 's' : ''}`);
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
  { id: 'tool-draw',    mId: 'm-tool-draw',    name: 'draw'    },
  { id: 'tool-image',   mId: 'm-tool-image',   name: 'image'   },
  { id: 'tool-timer',   mId: 'm-tool-timer',   name: 'timer'   },
  { id: 'tool-voice',   mId: 'm-tool-voice',   name: 'voice'   },
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
        } else if (t.name === 'draw') {
          setActiveTool('draw');
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

  // Duplicate buttons
  ['desktop-duplicate-btn', 'mobile-duplicate-btn'].forEach(id => {
    const btn = document.getElementById(id);
    if (btn) btn.addEventListener('click', duplicateSelected);
  });

  // Mobile drawer close
  const closeBtn = document.getElementById('mobile-close-drawer');
  if (closeBtn) closeBtn.addEventListener('click', deselect);
}

// ─────────────────────────────────────────────────────────────
// MODALS — Image insertion with URL, upload, drag-drop, paste
// ─────────────────────────────────────────────────────────────

// State for the pending image / link to insert
let pendingImageUrl  = null; // resolved URL/dataURL ready to place
let pendingLinkData  = null; // parsed link card metadata
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
    pendingLinkData = null;
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

  // ── URL / Link tab: debounced live preview ────────────
  urlInput?.addEventListener('input', () => {
    clearTimeout(previewDebounce);
    const url = urlInput.value.trim();
    setUrlStatus('');
    clearPreview();
    pendingImageUrl = null;
    pendingLinkData = null;
    submitBtn.disabled = true;

    if (!url) return;

    // Show loading after short pause
    previewDebounce = setTimeout(() => {
      setUrlStatus('⏳');
      setPreviewLoading();
      probeUrl(url);
    }, 500);
  });

  urlInput?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !submitBtn.disabled) commitImage();
    if (e.key === 'Escape') closeModal();
  });

  // ── Submit ─────────────────────────────────────────────
  submitBtn?.addEventListener('click', commitImage);

  function commitImage() {
    if (pendingFileType === 'link' && pendingLinkData) {
      const data = pendingLinkData;
      closeModal();
      placeLinkCard(data);
      return;
    }
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

  setupTimerRecordsModal();
}

// ── Central Timer Records Database Modal ──────────────────────
let cachedTimerDbRecords = [];

function setupTimerRecordsModal() {
  const modal = document.getElementById('timer-records-modal');
  if (!modal) return;
  const backdrop = document.getElementById('records-modal-backdrop');
  const closeBtn = document.getElementById('records-modal-close');
  const doneBtn = document.getElementById('records-done-btn');
  const searchInput = document.getElementById('records-search-input');
  const exportBtn = document.getElementById('records-export-btn');
  const clearAllBtn = document.getElementById('records-clear-all-btn');

  const closeModal = () => {
    modal.classList.remove('open');
  };

  closeBtn?.addEventListener('click', closeModal);
  doneBtn?.addEventListener('click', closeModal);
  backdrop?.addEventListener('click', closeModal);

  // Modal tabs
  document.getElementById('tab-btn-list')?.addEventListener('click', () => switchRecordsModalTab('list'));
  document.getElementById('tab-btn-stats')?.addEventListener('click', () => switchRecordsModalTab('stats'));

  // Breakdown toggle
  document.getElementById('stats-group-task')?.addEventListener('click', () => {
    currentStatsBreakdown = 'task';
    document.getElementById('stats-group-task')?.classList.add('active');
    document.getElementById('stats-group-mode')?.classList.remove('active');
    renderTimerStatistics(cachedTimerDbRecords);
  });
  document.getElementById('stats-group-mode')?.addEventListener('click', () => {
    currentStatsBreakdown = 'mode';
    document.getElementById('stats-group-mode')?.classList.add('active');
    document.getElementById('stats-group-task')?.classList.remove('active');
    renderTimerStatistics(cachedTimerDbRecords);
  });

  // Desktop and Mobile trigger buttons
  document.getElementById('tool-timer-records')?.addEventListener('click', openTimerRecordsModal);
  document.getElementById('m-tool-timer-records')?.addEventListener('click', openTimerRecordsModal);

  // Search filter
  searchInput?.addEventListener('input', () => {
    const q = searchInput.value.trim().toLowerCase();
    const filtered = cachedTimerDbRecords.filter(r => 
      (r.title && r.title.toLowerCase().includes(q)) ||
      (r.mode && r.mode.toLowerCase().includes(q))
    );
    renderTimerDbList(filtered);
  });

  // Export database
  exportBtn?.addEventListener('click', () => {
    window.open('/api/timer-records/export', '_blank');
  });

  // Clear all database
  clearAllBtn?.addEventListener('click', async () => {
    if (!cachedTimerDbRecords.length) return;
    if (!confirm('Are you sure you want to permanently clear all closed timer records from the database?')) return;
    try {
      const res = await fetch('/api/timer-records', { method: 'DELETE' });
      if (res.ok) {
        showToast('Timer records database cleared');
        loadTimerRecordsDatabase();
      }
    } catch (e) {
      console.error('Failed to clear timer records:', e);
    }
  });
}

let currentStatsBreakdown = 'task'; // 'task' | 'mode'

function switchRecordsModalTab(tabName) {
  const tabListBtn = document.getElementById('tab-btn-list');
  const tabStatsBtn = document.getElementById('tab-btn-stats');
  const viewList = document.getElementById('records-view-list');
  const viewStats = document.getElementById('records-view-stats');

  if (tabName === 'stats') {
    tabListBtn?.classList.remove('active');
    tabStatsBtn?.classList.add('active');
    if (viewList) viewList.style.display = 'none';
    if (viewStats) viewStats.style.display = 'flex';
    renderTimerStatistics(cachedTimerDbRecords);
  } else {
    tabStatsBtn?.classList.remove('active');
    tabListBtn?.classList.add('active');
    if (viewStats) viewStats.style.display = 'none';
    if (viewList) viewList.style.display = 'flex';
  }
}

const CHART_COLORS = [
  '#3b82f6', '#10b981', '#f59e0b', '#ec4899', '#8b5cf6',
  '#06b6d4', '#f97316', '#6366f1', '#14b8a6', '#84cc16'
];

function renderTimerStatistics(records) {
  const svg = document.getElementById('stats-pie-svg');
  const legendWrap = document.getElementById('stats-legend-wrap');
  const totalPill = document.getElementById('stats-total-pill');
  const centerTime = document.getElementById('pie-center-time');
  const centerLabel = document.getElementById('pie-center-label');
  const tooltip = document.getElementById('stats-pie-tooltip');

  const avgMetric = document.getElementById('metric-avg-session');
  const maxMetric = document.getElementById('metric-max-session');
  const topTaskMetric = document.getElementById('metric-top-task');
  const pomodoroCountMetric = document.getElementById('metric-pomodoro-count');

  if (!svg || !legendWrap) return;

  const totalDurationMs = (records || []).reduce((acc, r) => acc + (r.durationMs || 0), 0);
  const count = (records || []).length;

  if (totalPill) {
    totalPill.textContent = `Total: ${formatTimerTime(totalDurationMs, true)}`;
  }

  // Update center
  const resetCenter = () => {
    if (centerTime) centerTime.textContent = formatTimerTime(totalDurationMs, totalDurationMs >= 3600000);
    if (centerLabel) centerLabel.textContent = 'Total Time';
    if (tooltip) tooltip.style.opacity = '0';
    svg.querySelectorAll('.pie-slice').forEach(s => s.classList.remove('active'));
    legendWrap.querySelectorAll('.legend-row').forEach(r => r.classList.remove('active'));
  };
  resetCenter();

  // 1. Productivity Metrics
  if (avgMetric) {
    const avgMs = count > 0 ? Math.round(totalDurationMs / count) : 0;
    avgMetric.textContent = formatTimerTime(avgMs, avgMs >= 3600000);
  }

  if (maxMetric) {
    const maxMs = (records || []).reduce((max, r) => Math.max(max, r.durationMs || 0), 0);
    maxMetric.textContent = formatTimerTime(maxMs, maxMs >= 3600000);
  }

  const pomodorosDone = (records || []).filter(r => r.mode === 'pomodoro').length;
  if (pomodoroCountMetric) {
    pomodoroCountMetric.textContent = pomodorosDone;
  }

  // 2. Aggregate by breakdown
  const groups = new Map();
  (records || []).forEach(r => {
    let key;
    if (currentStatsBreakdown === 'mode') {
      key = r.mode === 'pomodoro' ? '🍅 Pomodoro' : '⏱️ Stopwatch';
    } else {
      key = (r.title || 'Timer').trim() || 'Timer';
    }
    const cur = groups.get(key) || { durationMs: 0, count: 0, label: key };
    cur.durationMs += (r.durationMs || 0);
    cur.count += 1;
    groups.set(key, cur);
  });

  const sortedGroups = [...groups.values()].sort((a, b) => b.durationMs - a.durationMs);

  // Top focus task metric
  if (topTaskMetric) {
    topTaskMetric.textContent = sortedGroups.length > 0 ? sortedGroups[0].label : '--';
    topTaskMetric.title = sortedGroups.length > 0 ? sortedGroups[0].label : '';
  }

  svg.innerHTML = '';
  legendWrap.innerHTML = '';

  if (!records || records.length === 0 || totalDurationMs <= 0 || sortedGroups.length === 0) {
    svg.innerHTML = `<circle cx="0" cy="0" r="75" fill="none" stroke="#e2e8f0" stroke-width="30"/>`;
    legendWrap.innerHTML = `<div class="records-db-empty" style="padding:20px 0;">No timer activity to chart yet.</div>`;
    if (centerTime) centerTime.textContent = '00:00';
    return;
  }

  // 3. Draw Donut / Pie Chart Slices
  const R = 90; // outer radius
  const r = 58; // inner radius
  let cumulativeAngle = 0;

  sortedGroups.forEach((group, idx) => {
    const fraction = totalDurationMs > 0 ? (group.durationMs / totalDurationMs) : 0;
    const sliceAngle = fraction * 360;
    const color = CHART_COLORS[idx % CHART_COLORS.length];
    const pct = Math.round(fraction * 100);

    const startAngle = cumulativeAngle;
    const endAngle = cumulativeAngle + sliceAngle;
    cumulativeAngle += sliceAngle;

    let pathD;
    if (sortedGroups.length === 1 || fraction >= 0.999) {
      pathD = `
        M 0 ${-R}
        A ${R} ${R} 0 1 1 0 ${R}
        A ${R} ${R} 0 1 1 0 ${-R}
        M 0 ${-r}
        A ${r} ${r} 0 1 0 0 ${r}
        A ${r} ${r} 0 1 0 0 ${-r}
        Z
      `;
    } else {
      const startRad = (startAngle - 90) * Math.PI / 180;
      const endRad = (endAngle - 90) * Math.PI / 180;
      const x1 = R * Math.cos(startRad), y1 = R * Math.sin(startRad);
      const x2 = R * Math.cos(endRad),   y2 = R * Math.sin(endRad);
      const x3 = r * Math.cos(endRad),   y3 = r * Math.sin(endRad);
      const x4 = r * Math.cos(startRad), y4 = r * Math.sin(startRad);
      const largeArc = sliceAngle > 180 ? 1 : 0;

      pathD = `M ${x1} ${y1} A ${R} ${R} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${r} ${r} 0 ${largeArc} 0 ${x4} ${y4} Z`;
    }

    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', pathD);
    path.setAttribute('fill', color);
    path.setAttribute('class', 'pie-slice');
    path.dataset.idx = idx;

    // Legend row
    const legendRow = document.createElement('div');
    legendRow.className = 'legend-row';
    legendRow.dataset.idx = idx;
    legendRow.innerHTML = `
      <div class="legend-left">
        <span class="legend-dot" style="background:${color}"></span>
        <span class="legend-label" title="${escapeHtml(group.label)}">${escapeHtml(group.label)}</span>
      </div>
      <div class="legend-right">
        <span class="legend-time">${formatTimerTime(group.durationMs, group.durationMs >= 3600000)}</span>
        <span class="legend-pct">${pct}%</span>
      </div>
    `;

    const activate = () => {
      svg.querySelectorAll('.pie-slice').forEach(s => s.classList.remove('active'));
      legendWrap.querySelectorAll('.legend-row').forEach(r => r.classList.remove('active'));
      path.classList.add('active');
      legendRow.classList.add('active');
      if (centerTime) centerTime.textContent = formatTimerTime(group.durationMs, group.durationMs >= 3600000);
      if (centerLabel) centerLabel.textContent = group.label;
      if (tooltip) {
        tooltip.textContent = `${group.label}: ${formatTimerTime(group.durationMs, true)} (${pct}%)`;
        tooltip.style.opacity = '1';
      }
    };

    path.addEventListener('mouseenter', activate);
    legendRow.addEventListener('mouseenter', activate);
    path.addEventListener('click', activate);
    legendRow.addEventListener('click', activate);

    svg.appendChild(path);
    legendWrap.appendChild(legendRow);
  });

  svg.addEventListener('mouseleave', resetCenter);
  legendWrap.addEventListener('mouseleave', resetCenter);
}

async function openTimerRecordsModal() {
  const modal = document.getElementById('timer-records-modal');
  if (!modal) return;
  modal.classList.add('open');
  switchRecordsModalTab('list');
  const searchInput = document.getElementById('records-search-input');
  if (searchInput) searchInput.value = '';
  await loadTimerRecordsDatabase();
}

async function loadTimerRecordsDatabase() {
  const listContainer = document.getElementById('records-db-list');
  const totalCountEl = document.getElementById('db-total-count');
  const totalTimeEl = document.getElementById('db-total-time');

  if (listContainer) {
    listContainer.innerHTML = `<div class="records-db-empty">Loading records database...</div>`;
  }

  try {
    const res = await fetch('/api/timer-records');
    if (!res.ok) throw new Error('Failed to fetch records');
    const data = await res.json();
    cachedTimerDbRecords = data.records || [];

    if (totalCountEl) totalCountEl.textContent = data.totalCount || 0;
    if (totalTimeEl) totalTimeEl.textContent = formatTimerTime(data.totalDurationMs || 0, true);

    renderTimerDbList(cachedTimerDbRecords);
    renderTimerStatistics(cachedTimerDbRecords);
  } catch (err) {
    console.error('Error loading timer records database:', err);
    if (listContainer) {
      listContainer.innerHTML = `<div class="records-db-empty" style="color:#ef4444;">Failed to load records database.</div>`;
    }
  }
}

function renderTimerDbList(records) {
  const listContainer = document.getElementById('records-db-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (!records || records.length === 0) {
    listContainer.innerHTML = `
      <div class="records-db-empty">
        No archived timers found in the database.<br>
        Closing or deleting any timer on the board automatically archives it here!
      </div>
    `;
    return;
  }

  records.forEach(rec => {
    const item = document.createElement('div');
    item.className = 'records-db-item';

    const durationStr = formatTimerTime(rec.durationMs, true);
    const dateStr = formatRecordDate(rec.closedAt);
    const modeBadge = rec.mode === 'pomodoro' ? '🍅 Pomodoro' : '⏱️ Stopwatch';
    const lapsText = rec.laps && rec.laps.length > 0 ? ` • ${rec.laps.length} lap${rec.laps.length > 1 ? 's' : ''}` : '';

    item.innerHTML = `
      <div class="records-db-item-top">
        <div class="records-db-title-wrap">
          <span class="records-db-title" title="${escapeHtml(rec.title || 'Timer')}">${escapeHtml(rec.title || 'Timer')}</span>
          <span class="records-db-mode-badge">${modeBadge}</span>
        </div>
        <div class="records-db-duration">${durationStr}</div>
      </div>
      <div class="records-db-item-meta">
        <span>Closed ${dateStr}${lapsText}</span>
        <div class="records-db-actions">
          <button class="records-item-btn restore" title="Restore timer back onto active board">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
            <span>Restore</span>
          </button>
          <button class="records-item-btn pin-note" title="Create sticky note with summary">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 17v5"/><path d="M9 2h6l1 7H8l1-7z"/><path d="M5 9h14l-1 8H6L5 9z"/></svg>
            <span>Note</span>
          </button>
          <button class="records-item-btn delete" title="Delete from database">
            <svg viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
          </button>
        </div>
      </div>
    `;

    // Restore button
    const restoreBtn = item.querySelector('.records-item-btn.restore');
    restoreBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      restoreTimerToBoard(rec);
    });

    // Note button
    const noteBtn = item.querySelector('.records-item-btn.pin-note');
    noteBtn?.addEventListener('click', (e) => {
      e.stopPropagation();
      pinArchivedRecordToNote(rec);
    });

    // Delete button
    const delBtn = item.querySelector('.records-item-btn.delete');
    delBtn?.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const res = await fetch(`/api/timer-records/${rec.id}`, { method: 'DELETE' });
        if (res.ok) {
          showToast('Record removed from database');
          cachedTimerDbRecords = cachedTimerDbRecords.filter(r => r.id !== rec.id);
          renderTimerDbList(cachedTimerDbRecords);
          const totalCountEl = document.getElementById('db-total-count');
          const totalTimeEl = document.getElementById('db-total-time');
          if (totalCountEl) totalCountEl.textContent = cachedTimerDbRecords.length;
          const sum = cachedTimerDbRecords.reduce((acc, r) => acc + (r.durationMs || 0), 0);
          if (totalTimeEl) totalTimeEl.textContent = formatTimerTime(sum, true);
        }
      } catch (err) {
        console.error('Failed to delete timer record:', err);
      }
    });

    listContainer.appendChild(item);
  });
}

function restoreTimerToBoard(rec) {
  const newId = 'e' + Math.random().toString(36).slice(2, 11);
  const vpW = viewport.clientWidth, vpH = viewport.clientHeight;
  const center = clientToWorld(vpW / 2, vpH / 2);

  const restoredEl = {
    id: newId,
    type: 'timer',
    color: rec.color || 'blueprint',
    zIndex: nextZ(),
    x: center.x - 140,
    y: center.y - 112,
    w: 280,
    h: 225,
    title: rec.title || 'Focus Session',
    mode: rec.mode || 'stopwatch',
    accumulatedMs: rec.durationMs || 0,
    running: false,
    startedAt: null,
    pomodoroDurationMs: 25 * 60 * 1000,
    laps: Array.isArray(rec.laps) ? [...rec.laps] : [],
    records: Array.isArray(rec.records) ? [...rec.records] : []
  };

  elements[newId] = restoredEl;
  mountElement(restoredEl, true);
  select(newId, false);
  sendOp('add', { element: restoredEl });

  const modal = document.getElementById('timer-records-modal');
  modal?.classList.remove('open');
  showToast(`⏱️ Restored '${rec.title || 'Timer'}' to board!`);
}

function pinArchivedRecordToNote(rec) {
  const noteId = 'e' + Math.random().toString(36).slice(2, 11);
  const durationStr = formatTimerTime(rec.durationMs, true);
  const dateStr = formatRecordDate(rec.closedAt);
  const modeLabel = rec.mode === 'pomodoro' ? '🍅 Pomodoro' : '⏱️ Stopwatch';

  let lines = [
    `⏱️ ${rec.title || 'Timer Record'}`,
    `────────────────────`,
    `Mode: ${modeLabel}`,
    `Total Time: ${durationStr}`,
    `Archived: ${dateStr}`
  ];

  if (Array.isArray(rec.laps) && rec.laps.length > 0) {
    lines.push(`\nLaps (${rec.laps.length}):`);
    rec.laps.forEach((lap, i) => {
      lines.push(`• Lap ${rec.laps.length - i}: ${formatTimerTime(lap.timeMs, lap.timeMs >= 3600000)}`);
    });
  }

  const vpW = viewport.clientWidth, vpH = viewport.clientHeight;
  const center = clientToWorld(vpW / 2, vpH / 2);

  const noteEl = {
    id: noteId,
    type: 'note',
    color: rec.color || 'yellow',
    zIndex: nextZ(),
    x: center.x - 110,
    y: center.y - 110,
    w: 220,
    h: 220,
    text: lines.join('\n')
  };

  elements[noteId] = noteEl;
  mountElement(noteEl, true);
  select(noteId, false);
  sendOp('add', { element: noteEl });

  const modal = document.getElementById('timer-records-modal');
  modal?.classList.remove('open');
  showToast('📌 Record pinned to note!');
}

// ── URL probing (Images & Link Cards) ──────────────────────────
function probeUrl(url) {
  if (/\.(png|jpe?g|gif|webp|svg|ico)($|\?)/i.test(url)) {
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
      fetchLinkPreview(url);
    };
    img.src = url;
    return;
  }

  fetchLinkPreview(url);
}

function probeImageUrl(url) {
  probeUrl(url);
}

async function fetchLinkPreview(url) {
  try {
    const res = await fetch(`/api/link-preview?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error('Preview fetch failed');
    const data = await res.json();

    if (data.isImage && data.image) {
      setUrlStatus('✅');
      pendingImageUrl = data.image;
      pendingFileType = 'image';
      const img = new Image();
      img.onload = () => {
        pendingImageW = img.naturalWidth;
        pendingImageH = img.naturalHeight;
        document.getElementById('image-submit-btn').disabled = false;
        setPreviewImage(data.image, img.naturalWidth, img.naturalHeight);
      };
      img.onerror = () => {
        setPreviewLinkCard(data);
      };
      img.src = data.image;
      return;
    }

    setUrlStatus('✅');
    pendingLinkData = data;
    pendingFileType = 'link';
    document.getElementById('image-submit-btn').disabled = false;
    setPreviewLinkCard(data);
  } catch (err) {
    try {
      const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
      const fallbackData = {
        url: parsed.href,
        domain: parsed.hostname.replace(/^www\./, ''),
        title: parsed.hostname.replace(/^www\./, ''),
        description: '',
        image: '',
        favicon: `https://www.google.com/s2/favicons?domain=${parsed.hostname}&sz=64`
      };
      setUrlStatus('✅');
      pendingLinkData = fallbackData;
      pendingFileType = 'link';
      document.getElementById('image-submit-btn').disabled = false;
      setPreviewLinkCard(fallbackData);
    } catch (_) {
      setUrlStatus('❌');
      pendingLinkData = null;
      document.getElementById('image-submit-btn').disabled = true;
      setPreviewError('Could not load URL — please enter a valid web link.');
    }
  }
}

// ── File → Server Upload ────────────────────────────────────────────
async function uploadFileToServer(file) {
  if (!file) return;
  if (file.size > 200 * 1024 * 1024) {
    setPreviewError('File is too large (max 200 MB).');
    return;
  }
  setPreviewLoading();
  try {
    const reader = new FileReader();
    reader.onload = async ev => {
      const dataUrl = ev.target.result;
      const isImage = file.type.startsWith('image/');
      const host = resolveServerHost();
      const uploadUrl = (location.protocol === 'file:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')
        ? (host ? `http://${host}/upload` : '/upload')
        : '/upload';
      try {
        const res = await fetch(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, fileData: dataUrl })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Upload failed');
        
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
        if (isImage) {
          // Offline fallback for modal: allow inserting the image locally using the dataUrl
          pendingImageUrl = dataUrl;
          pendingFileType = 'image';
          pendingFileName = file.name;
          document.getElementById('image-submit-btn').disabled = false;
          const img = new Image();
          img.onload = () => {
            pendingImageW = img.naturalWidth;
            pendingImageH = img.naturalHeight;
            setPreviewImage(dataUrl, img.naturalWidth, img.naturalHeight);
          };
          img.src = dataUrl;
        } else {
          console.error(e);
          setPreviewError('Failed to upload file (server offline).');
        }
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
  pendingLinkData = null;
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

function setPreviewLinkCard(data) {
  const zone  = document.getElementById('img-preview-zone');
  const inner = document.getElementById('img-preview-inner');
  if (!zone || !inner) return;
  zone.classList.add('has-preview');

  const bannerHtml = data.image
    ? `<div class="link-prev-banner" style="background-image:url('${data.image}')"></div>`
    : '';
  const favHtml = data.favicon
    ? `<img class="link-prev-fav" src="${data.favicon}" alt="" onerror="this.style.display='none'">`
    : '';

  inner.innerHTML = `
    <div class="link-preview-card">
      ${bannerHtml}
      <div class="link-prev-content">
        <div class="link-prev-meta">
          ${favHtml}
          <span class="link-prev-domain">${data.domain || ''}</span>
        </div>
        <div class="link-prev-title">${data.title || data.url}</div>
        ${data.description ? `<div class="link-prev-desc">${data.description}</div>` : ''}
      </div>
    </div>
  `;
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
  pendingLinkData = null;

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

function placeLinkCardAt(data, cx, cy) {
  const w = 320;
  const h = data.image ? 230 : 130;
  const id = 'e' + Math.random().toString(36).slice(2, 11);

  const el = {
    id,
    type: 'link',
    url: data.url,
    title: data.title || data.url,
    description: data.description || '',
    image: data.image || '',
    favicon: data.favicon || '',
    domain: data.domain || '',
    x: cx - w / 2,
    y: cy - h / 2,
    w,
    h,
    zIndex: nextZ(),
    color: 'blueprint'
  };

  elements[id] = el;
  mountElement(el, true);
  select(id, false);
  sendOp('add', { element: el });
}

function placeLinkCard(data, w = null, h = null) {
  const r  = viewport.getBoundingClientRect();
  const wp = clientToWorld(r.width / 2, r.height / 2);
  placeLinkCardAt(data, wp.x, wp.y);
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

    // ── Windows File Manager / Canvas shortcuts ──────────────
    // Ctrl+A / Cmd+A → Select all
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
      e.preventDefault();
      selectedIds = new Set(Object.keys(elements));
      Object.values(elements).forEach(el => syncNode(el));
      syncSelectionUI();
      showToast(`Selected all (${selectedIds.size} items)`);
      return;
    }

    // Ctrl+D / Cmd+D → Duplicate selected
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'd') {
      e.preventDefault();
      duplicateSelected();
      return;
    }

    // Arrow keys → Nudge selected elements (1px, or 10px with Shift)
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key) && selectedIds.size > 0) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      let dx = 0, dy = 0;
      if (e.key === 'ArrowUp') dy = -step;
      if (e.key === 'ArrowDown') dy = step;
      if (e.key === 'ArrowLeft') dx = -step;
      if (e.key === 'ArrowRight') dx = step;

      const movedNodes = new Set();
      selectedIds.forEach(id => {
        const el = elements[id];
        if (!el) return;
        if (el.type === 'line' || el.type === 'arrow') {
          el.x1 += dx; el.y1 += dy;
          el.x2 += dx; el.y2 += dy;
          fixBBox(el);
        } else {
          el.x += dx;
          el.y += dy;
          movedNodes.add(id);
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

    switch (e.key.toLowerCase()) {
      case 'v':       setActiveTool('select'); break;
      case 'd':       setActiveTool('draw');   break;
      case 'n':       spawnAtCenter('note');    break;
      case 'r':       spawnAtCenter('rect');    break;
      case 'o':       spawnAtCenter('ellipse'); break;
      case 'l':       spawnAtCenter('line');    break;
      case 'a':       spawnAtCenter('arrow');   break;
      case 'i':       showImageModal();          break;
      case 't':       spawnAtCenter('timer');    break;
      case 'm':       spawnAtCenter('voice');    break;
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
// PREVIEW WINDOW & MINIMAP
// ─────────────────────────────────────────────────────────────
let previewHideTimer = null;
let isHoveringPreview = false;
let isDraggingMinimap = false;
let minimapTransform = null;

function showPreviewWindow() {
  if (!previewWindow) return;
  previewWindow.classList.add('visible');
  updateMinimap();
  scheduleHidePreview();
}

function scheduleHidePreview(delay = 2500) {
  if (previewHideTimer) clearTimeout(previewHideTimer);
  if (isHoveringPreview || isDraggingMinimap) return;
  previewHideTimer = setTimeout(() => {
    if (!isHoveringPreview && !isDraggingMinimap && previewWindow) {
      previewWindow.classList.remove('visible');
    }
  }, delay);
}

function zoomByCenter(factor) {
  const r = viewport.getBoundingClientRect();
  const cx = r.width / 2;
  const cy = r.height / 2;
  const nz = Math.min(10, Math.max(0.08, zoom * factor));
  panX = cx - (cx - panX) * (nz / zoom);
  panY = cy - (cy - panY) * (nz / zoom);
  zoom = nz;
  applyTransform();
  showPreviewWindow();
}

function zoomToCenter(targetZoom) {
  const r = viewport.getBoundingClientRect();
  const cx = r.width / 2;
  const cy = r.height / 2;
  const nz = Math.min(10, Math.max(0.08, targetZoom));
  panX = cx - (cx - panX) * (nz / zoom);
  panY = cy - (cy - panY) * (nz / zoom);
  zoom = nz;
  applyTransform();
  showPreviewWindow();
}

function updateMinimap() {
  if (!previewWindow || !previewCanvas || !previewCanvasWrap) return;

  if (previewZoomVal) {
    previewZoomVal.textContent = `${Math.round(zoom * 100)}%`;
  }

  const wrapRect = previewCanvasWrap.getBoundingClientRect();
  const W_wrap = wrapRect.width || 180;
  const H_wrap = wrapRect.height || 110;

  const dpr = window.devicePixelRatio || 1;
  const targetW = Math.round(W_wrap * dpr);
  const targetH = Math.round(H_wrap * dpr);
  if (previewCanvas.width !== targetW || previewCanvas.height !== targetH) {
    previewCanvas.width = targetW;
    previewCanvas.height = targetH;
  }

  const ctx = previewCanvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W_wrap, H_wrap);

  const vr = viewport.getBoundingClientRect();
  const vx1 = -panX / zoom;
  const vy1 = -panY / zoom;
  const vw = vr.width / zoom;
  const vh = vr.height / zoom;
  const vx2 = vx1 + vw;
  const vy2 = vy1 + vh;

  let minX = vx1;
  let minY = vy1;
  let maxX = vx2;
  let maxY = vy2;

  const allElements = Object.values(elements);
  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    if (typeof el.x === 'number' && !isNaN(el.x)) {
      const ew = el.w || 40;
      const eh = el.h || 40;
      if (el.x < minX) minX = el.x;
      if (el.y < minY) minY = el.y;
      if (el.x + ew > maxX) maxX = el.x + ew;
      if (el.y + eh > maxY) maxY = el.y + eh;
    }
  }

  const pad = Math.max(140, Math.max(vw, vh) * 0.1);
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;

  const worldW = Math.max(20, maxX - minX);
  const worldH = Math.max(20, maxY - minY);

  const S = Math.min(W_wrap / worldW, H_wrap / worldH);
  const offsetX = (W_wrap - worldW * S) / 2;
  const offsetY = (H_wrap - worldH * S) / 2;

  minimapTransform = { minX, minY, S, offsetX, offsetY, W_wrap, H_wrap };

  const toMapX = wx => offsetX + (wx - minX) * S;
  const toMapY = wy => offsetY + (wy - minY) * S;

  // Render elements in minimap
  for (let i = 0; i < allElements.length; i++) {
    const el = allElements[i];
    const mx = toMapX(el.x);
    const my = toMapY(el.y);
    const mw = Math.max(2, (el.w || 20) * S);
    const mh = Math.max(2, (el.h || 20) * S);

    if (el.type === 'draw' && Array.isArray(el.points) && el.points.length > 1) {
      ctx.beginPath();
      ctx.strokeStyle = el.color || '#2563eb';
      ctx.lineWidth = Math.max(1, (el.strokeWidth || 3) * S);
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.moveTo(toMapX(el.points[0].x), toMapY(el.points[0].y));
      for (let p = 1; p < el.points.length; p++) {
        ctx.lineTo(toMapX(el.points[p].x), toMapY(el.points[p].y));
      }
      ctx.stroke();
    } else if (el.type === 'line' || el.type === 'arrow') {
      ctx.beginPath();
      ctx.strokeStyle = el.stroke || '#2563eb';
      ctx.lineWidth = Math.max(1.2, 2 * S);
      ctx.moveTo(toMapX(el.x1 ?? el.x), toMapY(el.y1 ?? el.y));
      ctx.lineTo(toMapX(el.x2 ?? (el.x + el.w)), toMapY(el.y2 ?? (el.y + el.h)));
      ctx.stroke();
    } else if (el.type === 'ellipse') {
      ctx.beginPath();
      ctx.ellipse(mx + mw / 2, my + mh / 2, Math.max(1, mw / 2), Math.max(1, mh / 2), 0, 0, Math.PI * 2);
      ctx.fillStyle = el.fill || 'rgba(37, 99, 235, 0.15)';
      ctx.fill();
      ctx.strokeStyle = el.stroke || '#2563eb';
      ctx.lineWidth = 1;
      ctx.stroke();
    } else {
      // note, image, file, link, timer, rect, etc.
      ctx.beginPath();
      const r = Math.min(3, mw / 2, mh / 2);
      if (ctx.roundRect) {
        ctx.roundRect(mx, my, mw, mh, r);
      } else {
        ctx.rect(mx, my, mw, mh);
      }
      if (el.type === 'note') {
        ctx.fillStyle = el.color ? el.color : '#fef08a';
      } else if (el.type === 'timer') {
        ctx.fillStyle = '#f87171';
      } else if (el.type === 'image') {
        ctx.fillStyle = '#60a5fa';
      } else if (el.type === 'link') {
        ctx.fillStyle = '#a78bfa';
      } else {
        ctx.fillStyle = el.fill || '#e2e8f0';
      }
      ctx.fill();
      ctx.strokeStyle = el.stroke || 'rgba(0, 0, 0, 0.15)';
      ctx.lineWidth = 0.8;
      ctx.stroke();
    }
  }

  ctx.restore();

  // Position viewport camera indicator
  if (previewViewportRect) {
    const rx = toMapX(vx1);
    const ry = toMapY(vy1);
    const rw = vw * S;
    const rh = vh * S;

    previewViewportRect.style.left = `${Math.round(rx)}px`;
    previewViewportRect.style.top = `${Math.round(ry)}px`;
    previewViewportRect.style.width = `${Math.max(6, Math.round(rw))}px`;
    previewViewportRect.style.height = `${Math.max(6, Math.round(rh))}px`;
  }
}

function setupPreviewMinimap() {
  if (!previewWindow || !previewCanvasWrap || !previewViewportRect) return;

  let isDraggingViewportRect = false;
  let dragStartClientX = 0;
  let dragStartClientY = 0;
  let dragStartPanX = 0;
  let dragStartPanY = 0;

  // Prevent preview interaction from leaking to underlying canvas
  ['pointerdown', 'pointermove', 'pointerup', 'click', 'dblclick', 'contextmenu'].forEach(evt => {
    previewWindow.addEventListener(evt, e => e.stopPropagation());
  });

  // Wheel zoom over preview window
  previewWindow.addEventListener('wheel', e => {
    e.stopPropagation();
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.09 : 1 / 1.09;
    zoomByCenter(factor);
  }, { passive: false });

  // Hover & pointer retention
  previewWindow.addEventListener('pointerenter', () => {
    isHoveringPreview = true;
    if (previewHideTimer) clearTimeout(previewHideTimer);
  });
  previewWindow.addEventListener('pointerleave', () => {
    isHoveringPreview = false;
    scheduleHidePreview(1500);
  });

  // Zoom control buttons
  if (previewZoomIn) {
    previewZoomIn.addEventListener('click', e => {
      e.stopPropagation();
      zoomByCenter(1.2);
    });
  }
  if (previewZoomOut) {
    previewZoomOut.addEventListener('click', e => {
      e.stopPropagation();
      zoomByCenter(1 / 1.2);
    });
  }
  if (previewZoomVal) {
    previewZoomVal.addEventListener('click', e => {
      e.stopPropagation();
      zoomToCenter(1.0);
    });
  }

  // Drag the viewport camera rect
  previewViewportRect.addEventListener('pointerdown', e => {
    e.stopPropagation();
    e.preventDefault();
    if (!minimapTransform) return;
    isDraggingMinimap = true;
    isDraggingViewportRect = true;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    dragStartPanX = panX;
    dragStartPanY = panY;
    try { previewViewportRect.setPointerCapture(e.pointerId); } catch (_) {}
  });

  previewViewportRect.addEventListener('pointermove', e => {
    if (!isDraggingViewportRect || !minimapTransform) return;
    const dx = e.clientX - dragStartClientX;
    const dy = e.clientY - dragStartClientY;
    const dwx = dx / minimapTransform.S;
    const dwy = dy / minimapTransform.S;
    panX = dragStartPanX - dwx * zoom;
    panY = dragStartPanY - dwy * zoom;
    applyTransform();
  });

  const stopRectDrag = e => {
    if (isDraggingViewportRect) {
      isDraggingViewportRect = false;
      isDraggingMinimap = false;
      try { previewViewportRect.releasePointerCapture(e.pointerId); } catch (_) {}
      scheduleHidePreview();
    }
  };
  previewViewportRect.addEventListener('pointerup', stopRectDrag);
  previewViewportRect.addEventListener('pointercancel', stopRectDrag);

  // Click / drag anywhere on canvas wrap to center camera
  previewCanvasWrap.addEventListener('pointerdown', e => {
    if (e.target === previewViewportRect) return;
    e.stopPropagation();
    e.preventDefault();
    if (!minimapTransform) return;

    isDraggingMinimap = true;
    const rect = previewCanvasWrap.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickY = e.clientY - rect.top;

    const wx = minimapTransform.minX + (clickX - minimapTransform.offsetX) / minimapTransform.S;
    const wy = minimapTransform.minY + (clickY - minimapTransform.offsetY) / minimapTransform.S;

    const vr = viewport.getBoundingClientRect();
    panX = vr.width / 2 - wx * zoom;
    panY = vr.height / 2 - wy * zoom;
    applyTransform();

    isDraggingViewportRect = true;
    dragStartClientX = e.clientX;
    dragStartClientY = e.clientY;
    dragStartPanX = panX;
    dragStartPanY = panY;
    try { previewViewportRect.setPointerCapture(e.pointerId); } catch (_) {}
  });
}

// ─────────────────────────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
