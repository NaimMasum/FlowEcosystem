const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 3939;
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'board.json');

// In-memory board state: Map of elementId -> elementObject
let boardState = {};

// Ensure data directory and file exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

if (fs.existsSync(DATA_FILE)) {
  try {
    const data = fs.readFileSync(DATA_FILE, 'utf8');
    boardState = JSON.parse(data || '{}');
  } catch (err) {
    console.error('Error reading board.json, starting fresh:', err);
    boardState = {};
  }
} else {
  fs.writeFileSync(DATA_FILE, JSON.stringify({}, null, 2), 'utf8');
}

// Debounced file write
let saveTimeout = null;
function queueSave() {
  if (saveTimeout) clearTimeout(saveTimeout);
  saveTimeout = setTimeout(() => {
    fs.writeFile(DATA_FILE, JSON.stringify(boardState, null, 2), 'utf8', (err) => {
      if (err) {
        console.error('Error saving board state to disk:', err);
      } else {
        console.log('Board state successfully persisted to disk.');
      }
    });
  }, 1000); // 1-second debounce
}

const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

// Allow cross-origin requests for uploads so the PDF app can fetch and update them
app.use('/uploads', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, PUT, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

// Endpoint to overwrite an existing upload (Sync changes)
app.put('/uploads/:filename', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  try {
    const filename = req.params.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    
    fs.writeFileSync(filePath, req.body);
    res.json({ success: true, url: `/uploads/${filename}` });
  } catch (err) {
    console.error('Update error:', err);
    res.status(500).json({ error: 'Failed to update file' });
  }
});

app.use('/uploads', express.static(UPLOADS_DIR));

app.get('/api/files', (req, res) => {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    res.json(files);
  } catch (err) {
    console.error('Failed to list files:', err);
    res.json([]);
  }
});

// App update & version check endpoint
app.get('/api/app-version', (req, res) => {
  const apkPath = path.join(__dirname, 'public', 'app.apk');
  if (!fs.existsSync(apkPath)) {
    return res.json({ available: false });
  }

  try {
    const stat = fs.statSync(apkPath);
    const fileBuf = fs.readFileSync(apkPath);
    const md5 = crypto.createHash('md5').update(fileBuf).digest('hex');

    res.json({
      available: true,
      size: stat.size,
      mtime: Math.floor(stat.mtimeMs),
      date: stat.mtime.toISOString(),
      md5: md5,
      url: '/app.apk'
    });
  } catch (err) {
    console.error('Failed to inspect APK:', err);
    res.status(500).json({ error: 'Failed to inspect APK' });
  }
});

// Link preview scraper endpoint
app.get('/api/link-preview', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'Missing url parameter' });

  let validUrl;
  try {
    const raw = String(targetUrl).trim();
    validUrl = new URL(raw.startsWith('http://') || raw.startsWith('https://') ? raw : `https://${raw}`);
  } catch (e) {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  const hostname = validUrl.hostname.replace(/^www\./, '');
  const result = {
    url: validUrl.href,
    domain: hostname,
    title: hostname,
    description: '',
    image: '',
    favicon: `https://www.google.com/s2/favicons?domain=${hostname}&sz=64`,
    isImage: false
  };

  // Check direct image extension first
  if (/\.(png|jpe?g|gif|webp|svg|ico)($|\?)/i.test(validUrl.pathname)) {
    result.image = validUrl.href;
    result.isImage = true;
    return res.json(result);
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4500);

    const response = await fetch(validUrl.href, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8'
      }
    });
    clearTimeout(timeout);

    const contentType = response.headers.get('content-type') || '';
    if (contentType.includes('image/')) {
      result.image = validUrl.href;
      result.isImage = true;
      return res.json(result);
    }

    const html = await response.text();

    const getMeta = (propName) => {
      const regex1 = new RegExp(`<meta[^>]+(?:property|name)=["']${propName}["'][^>]*content=["']([^"']*)["']`, 'i');
      const regex2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${propName}["']`, 'i');
      const m = html.match(regex1) || html.match(regex2);
      return m ? m[1].trim() : null;
    };

    const titleTag = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const title = getMeta('og:title') || getMeta('twitter:title') || (titleTag ? titleTag[1].trim() : null);
    if (title) result.title = title;

    const desc = getMeta('og:description') || getMeta('twitter:description') || getMeta('description');
    if (desc) result.description = desc;

    let img = getMeta('og:image') || getMeta('twitter:image');
    if (img) {
      if (!img.startsWith('http') && !img.startsWith('data:')) {
        try { img = new URL(img, validUrl.href).href; } catch (_) {}
      }
      result.image = img;
    }

    const favMatch = html.match(/<link[^>]+rel=["'](?:shortcut )?icon["'][^>]+href=["']([^"']*)["']/i) ||
                     html.match(/<link[^>]+href=["']([^"']*)["'][^>]+rel=["'](?:shortcut )?icon["']/i);
    if (favMatch && favMatch[1]) {
      try {
        result.favicon = new URL(favMatch[1], validUrl.href).href;
      } catch (_) {}
    }

    res.json(result);
  } catch (err) {
    res.json(result);
  }
});

app.use(express.json({ limit: '50mb' }));

app.post('/upload', (req, res) => {
  try {
    const { filename, fileData } = req.body;
    if (!filename || !fileData) return res.status(400).json({ error: 'Missing file info' });
    
    const matches = fileData.match(/^data:(.+);base64,(.+)$/);
    if (!matches || matches.length !== 3) return res.status(400).json({ error: 'Invalid data URI' });
    
    const buffer = Buffer.from(matches[2], 'base64');
    const safeName = Date.now() + '_' + filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const filePath = path.join(UPLOADS_DIR, safeName);
    
    fs.writeFileSync(filePath, buffer);
    res.json({ url: `/uploads/${safeName}` });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// WebSocket connection handling
wss.on('connection', (ws) => {
  console.log('New client connected.');

  // Send initial board state to the new client
  ws.send(JSON.stringify({
    type: 'init',
    elements: boardState
  }));

  // Setup ping-pong heartbeat
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });

  // Handle incoming messages
  ws.on('message', (messageString) => {
    try {
      const data = JSON.parse(messageString);
      
      switch (data.type) {
          case 'ping': {
            ws.send(JSON.stringify({ type: 'pong' }));
            break;
          }
          case 'add': {
          const { element } = data;
          if (element && element.id) {
            boardState[element.id] = element;
            queueSave();
            broadcast(ws, { type: 'add', element });
          }
          break;
        }
        case 'update': {
          const { element } = data;
          if (element && element.id) {
            boardState[element.id] = {
              ...(boardState[element.id] || {}),
              ...element
            };
            queueSave();
            broadcast(ws, { type: 'update', element });
          }
          break;
        }
        case 'delete': {
          const { id } = data;
          if (id) {
            delete boardState[id];
            queueSave();
            broadcast(ws, { type: 'delete', id });
          }
          break;
        }
        case 'deleteMultiple': {
          const { ids } = data;
          if (Array.isArray(ids)) {
            ids.forEach(id => {
              delete boardState[id];
            });
            queueSave();
            broadcast(ws, { type: 'deleteMultiple', ids });
          }
          break;
        }
        default:
          console.warn('Unknown message type received:', data.type);
      }
    } catch (err) {
      console.error('Error parsing client message:', err);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected.');
  });
});

// Broadcast helper (sends to all clients except the sender)
function broadcast(sender, data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client !== sender && client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// Keep-alive heartbeat checker
const heartbeatInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log('Terminating unresponsive connection.');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => {
  clearInterval(heartbeatInterval);
});

// Find and format local network addresses
function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // Only keep IPv4 addresses that are not internal loopbacks
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

const { Bonjour } = require('bonjour-service');

server.listen(PORT, '0.0.0.0', () => {
  console.log(`==================================================`);
  console.log(`Flow server started!`);
  console.log(`Local Access: http://localhost:${PORT}`);
  
  const lanIPs = getLocalIPs();
  if (lanIPs.length > 0) {
    lanIPs.forEach(ip => {
      console.log(`LAN Access:   http://${ip}:${PORT}`);
    });
  } else {
    console.log(`LAN Access:   No active LAN interfaces found. Make sure you are connected to Wi-Fi.`);
  }
  console.log(`==================================================`);

  // Start mDNS/Bonjour Broadcasting
  try {
    const validIPs = lanIPs.filter(ip => !ip.startsWith('192.168.56.'));
    const hostIP = validIPs.length > 0 ? validIPs[0] : (lanIPs.length > 0 ? lanIPs[0] : '0.0.0.0');
    
    const bonjour = new Bonjour();
    bonjour.publish({ name: 'Flow Whiteboard', type: 'flowboard', port: PORT, host: hostIP });
    console.log(`[*] mDNS Broadcaster active on ${hostIP}. Android app will detect this automatically on the network.`);
  } catch (err) {
    console.error('Failed to start bonjour service:', err);
  }
});

