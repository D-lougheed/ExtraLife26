'use strict';
/* Transport. Serves the page, the images and the WebSocket from one port, so
   the tunnel needs a single ingress rule. All the interesting logic is in
   room.js. Point the Cloudflare tunnel at http://localhost:<PORT>. */

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const room = require('./room');

const PORT = Number(process.env.PORT) || 8080;
const ROOT = __dirname;
const STATE_FILE = path.join(ROOT, 'state.json');
const PW_FILE = path.join(ROOT, 'admin-password.txt');

/* ---------- admin password ----------
   Env first, then the file beside the server, otherwise generate one and save
   it so a restart mid-show keeps the same password. Never in client source:
   the page sends what was typed and this is the only thing that judges it. */
function resolveAdminPassword() {
  if (process.env.ADMIN_PASSWORD && process.env.ADMIN_PASSWORD.trim()) {
    console.log('admin password: taken from ADMIN_PASSWORD');
    return process.env.ADMIN_PASSWORD.trim();
  }
  try {
    const v = fs.readFileSync(PW_FILE, 'utf8').trim();
    if (v) { console.log('admin password: read from admin-password.txt'); return v; }
  } catch { /* no file yet */ }
  const gen = crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(PW_FILE, gen + '\n');
    console.log('\n  admin password for this board: ' + gen);
    console.log('  saved to admin-password.txt and reused on restart\n');
  } catch (e) {
    console.warn('\n  admin password for this board: ' + gen);
    console.warn('  could not save it (' + e.message + '), so a restart will change it\n');
  }
  return gen;
}
const ADMIN_PW = resolveAdminPassword();

/* ---------- state, mirrored to disk ---------- */
let state = room.emptyState();
try {
  if (fs.existsSync(STATE_FILE)) {
    state = room.sanitizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    console.log('resumed state from state.json');
  }
} catch (e) { console.warn('state.json unreadable, starting clean:', e.message); }

let saveTimer = null;
function save() {                                   // coalesced; puck drags fire often
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    fs.writeFile(STATE_FILE + '.tmp', JSON.stringify(state), err => {
      if (err) return console.warn('state save failed:', err.message);
      fs.rename(STATE_FILE + '.tmp', STATE_FILE, e2 => e2 && console.warn('state swap failed:', e2.message));
    });
  }, 250);
}

/* ---------- static files ----------
   An allowlist, not a file server: the repo also holds the password file, the
   saved state and this source, and none of that belongs on a public tunnel. */
const IMG_TYPES = { '.png':'image/png', '.jpg':'image/jpeg', '.jpeg':'image/jpeg',
  '.gif':'image/gif', '.webp':'image/webp', '.svg':'image/svg+xml' };

function servePath(rel) {
  if (rel === '/' || rel === '/index.html') return { file: path.join(ROOT, 'index.html'), type: 'text/html; charset=utf-8', cache: 'no-store' };
  if (rel.startsWith('/images/') && !rel.includes('..')) {
    const type = IMG_TYPES[path.extname(rel).toLowerCase()];
    if (type) return { file: path.join(ROOT, rel), type, cache: 'public, max-age=300' };
  }
  return null;
}

const server = http.createServer((req, res) => {
  let rel;
  try { rel = decodeURIComponent((req.url || '/').split('?')[0]); }
  catch { res.writeHead(400); return res.end('bad url'); }

  if (rel === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, clients: conns.size, seats: Object.keys(state.seats).length }));
  }

  const hit = servePath(rel);
  if (!hit || !hit.file.startsWith(ROOT)) { res.writeHead(404); return res.end('not found'); }
  fs.readFile(hit.file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': hit.type, 'Cache-Control': hit.cache });
    res.end(data);
  });
});

/* ---------- sockets ---------- */
const wss = new WebSocketServer({ server });
const conns = new Map();                            // ws -> { viewerId, name, role, tabId }

const send = (ws, msg) => { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); };
const toAll = msg => { for (const ws of conns.keys()) send(ws, msg); };
const toOthers = (self, msg) => { for (const ws of conns.keys()) if (ws !== self) send(ws, msg); };

wss.on('connection', ws => {
  conns.set(ws, { viewerId: '', name: '', role: 'viewer', tabId: '' });
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  ws.on('message', raw => {
    if (raw.length > 4096) return;                  // nothing legitimate is this big
    let msg; try { msg = JSON.parse(raw); } catch { return; }
    const conn = conns.get(ws);
    if (!conn) return;

    if (msg.t === 'hello') {
      const auth = room.authRole(msg.role, msg.pw, ADMIN_PW);
      conn.viewerId = String(msg.viewerId || '').slice(0, 64);
      conn.name = String(msg.name || '').slice(0, 40);
      conn.tabId = String(msg.tabId || '').slice(0, 64);
      conn.role = auth.role;
      if (auth.denied) {                            // claimed admin, got the password wrong
        console.log('admin rejected for ' + (conn.name || 'someone'));
        send(ws, { t: 'denied' });
        return;
      }
    }

    const out = room.apply(state, conn, msg);
    if (out.state !== state) { state = out.state; save(); }
    if (out.reply) send(ws, out.reply);
    if (out.broadcast) toAll(out.broadcast);
    if (out.relay) toOthers(ws, out.relay);
  });

  ws.on('close', () => {
    const conn = conns.get(ws);
    conns.delete(ws);
    if (conn && conn.tabId) toAll({ t: 'gone', tab: conn.tabId });   // drop their glove
  });
  ws.on('error', () => {});
});

/* drop sockets a tunnel left for dead, so gloves do not pile up */
const beat = setInterval(() => {
  for (const ws of conns.keys()) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 30000);
wss.on('close', () => clearInterval(beat));

server.listen(PORT, () => {
  console.log('Extra Life 26 board on http://localhost:' + PORT);
  console.log('point the tunnel at that port; /health reports live clients');
});
