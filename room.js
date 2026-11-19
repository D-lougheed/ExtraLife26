'use strict';
/* Pure room state machine. No sockets, no I/O, no timers — hand it a message
   and it hands back the next state plus what to send where. That is what makes
   it testable; server.js is the part that touches the network. */

const SEATS = 3;

const emptyGame  = () => ({ started:false, page:0, open:null, revealed:false, used:[] });
const emptyState = () => ({ seats:{}, locked:false, game:emptyGame() });

const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);
const clamp01 = v => Math.min(1, Math.max(0, v));

/* The client is the only thing that knows how many boards there are, so page
   is not clamped at the top here — only kept sane. */
function sanitizeGame(g) {
  g = g && typeof g === 'object' ? g : {};
  const open = g.open && typeof g.open === 'object'
    && typeof g.open.c === 'number' && typeof g.open.r === 'number'
    ? { c: g.open.c | 0, r: g.open.r | 0 } : null;
  return {
    started: !!g.started,
    page: Math.max(0, num(g.page, 0) | 0),
    open,
    revealed: !!g.revealed,
    used: Array.isArray(g.used) ? g.used.filter(x => typeof x === 'string').slice(0, 500) : [],
  };
}

function sanitizeState(s) {
  s = s && typeof s === 'object' ? s : {};
  const seats = {};
  for (const k of Object.keys(s.seats || {})) {
    const r = s.seats[k];
    if (!r || typeof r !== 'object' || !r.viewer_id) continue;
    const n = num(r.seat, 0) | 0;
    if (n < 1 || n > SEATS) continue;
    seats[String(n)] = {
      seat: n,
      viewer_id: String(r.viewer_id),
      player_name: String(r.player_name || ''),
      character_id: String(r.character_id || ''),
      held: !!r.held,
      px: clamp01(num(r.px, 0.5)),
      py: clamp01(num(r.py, 0.32)),
    };
  }
  return { seats, locked: !!s.locked, game: sanitizeGame(s.game) };
}

function seatOfViewer(state, viewerId) {
  for (const k of Object.keys(state.seats)) {
    if (state.seats[k].viewer_id === viewerId) return k;
  }
  return null;
}

/* conn is { viewerId, name, role, tabId }. Returns:
     state      the next state (unchanged object when nothing happened)
     broadcast  send to everyone, sender included
     reply      send to the sender only
     relay      send to everyone except the sender
   A seat is never freed when a socket closes — it is held by viewerId so a
   reload or a dropped tunnel puts the player back in their own chair. Only
   Clear board frees seats. */
function apply(state, conn, msg) {
  const none = { state, broadcast: null, reply: null, relay: null };
  if (!msg || typeof msg.t !== 'string') return none;
  const isAdmin = conn.role === 'admin';
  const push = next => ({ state: next, broadcast: { t: 'state', room: next }, reply: null, relay: null });

  switch (msg.t) {
    case 'hello':
      return { state, broadcast: null, reply: { t: 'state', room: state }, relay: null };

    case 'claim': {
      if (conn.role !== 'player') return none;          // the admin hosts; no seat
      const mine = seatOfViewer(state, conn.viewerId);
      if (mine) return { state, broadcast: null, reply: { t: 'state', room: state }, relay: null };
      for (let n = 1; n <= SEATS; n++) {
        if (state.seats[String(n)]) continue;
        return push({ ...state, seats: { ...state.seats, [String(n)]: {
          seat: n, viewer_id: conn.viewerId, player_name: String(conn.name || ''),
          character_id: '', held: false, px: 0.5, py: 0.32 } } });
      }
      return { state, broadcast: null, reply: { t: 'full' }, relay: null };
    }

    case 'seat': {
      const mine = seatOfViewer(state, conn.viewerId);
      if (!mine || state.locked) return none;           // never writes anyone else's seat
      const p = msg.patch && typeof msg.patch === 'object' ? msg.patch : {};
      const row = { ...state.seats[mine] };
      if (typeof p.character_id === 'string') row.character_id = p.character_id;
      if (typeof p.held === 'boolean') row.held = p.held;
      if (typeof p.px === 'number') row.px = clamp01(p.px);
      if (typeof p.py === 'number') row.py = clamp01(p.py);
      if (typeof p.player_name === 'string') row.player_name = p.player_name;
      return push({ ...state, seats: { ...state.seats, [mine]: row } });
    }

    case 'lock':
      if (!isAdmin) return none;
      return push({ ...state, locked: !!msg.v });

    case 'clear':
      if (!isAdmin) return none;
      // seats go, trivia progress stays: a mid-show reset must not replay spent clues
      return push({ ...state, seats: {}, locked: false,
        game: { ...state.game, started: false, open: null, revealed: false } });

    case 'game':
      if (!isAdmin) return none;
      return push({ ...state, game: sanitizeGame({ ...state.game, ...(msg.patch || {}) }) });

    case 'hand':
      return { state, broadcast: null, reply: null, relay: {
        t: 'hand', tab: conn.tabId,
        x: clamp01(num(msg.x, 0.5)), y: clamp01(num(msg.y, 0.5)),
        pose: String(msg.pose || 'open'),
        slot: typeof msg.slot === 'number' ? msg.slot : null,
        name: String(msg.name || ''),
      } };
  }
  return none;
}

/* The only thing that decides whether a connection is the admin. Claiming the
   role is not enough — the password has to match the one the server holds.
   A wrong password comes back denied rather than silently demoted, so the page
   can send them back to the join screen instead of showing dead buttons. */
function authRole(claimed, pw, adminPw) {
  const role = ['player', 'admin', 'viewer'].includes(claimed) ? claimed : 'viewer';
  if (role !== 'admin') return { role, denied: false };
  const given = String(pw == null ? '' : pw).trim().toLowerCase();
  const want = String(adminPw == null ? '' : adminPw).trim().toLowerCase();
  const ok = want.length > 0 && given.length > 0 && given === want;
  return ok ? { role: 'admin', denied: false } : { role: 'viewer', denied: true };
}

module.exports = { SEATS, apply, authRole, emptyState, emptyGame, sanitizeState, sanitizeGame, seatOfViewer };
