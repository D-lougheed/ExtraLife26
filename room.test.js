'use strict';
/* node room.test.js — no framework, just the rules that would ruin a show. */
const assert = require('assert');
const room = require('./room');

const P1 = { viewerId:'v1', name:'DAN',  role:'player', tabId:'t1' };
const P2 = { viewerId:'v2', name:'SAM',  role:'player', tabId:'t2' };
const P3 = { viewerId:'v3', name:'ALEX', role:'player', tabId:'t3' };
const P4 = { viewerId:'v4', name:'LATE', role:'player', tabId:'t4' };
const AD = { viewerId:'v9', name:'HOST', role:'admin',  tabId:'t9' };

let pass = 0;
const it = (what, fn) => { fn(); pass++; console.log('  ok  ' + what); };
const claim = (s, c) => room.apply(s, c, { t:'claim' });

it('first player takes seat 1', () => {
  const r = claim(room.emptyState(), P1);
  assert.deepStrictEqual(Object.keys(r.state.seats), ['1']);
  assert.strictEqual(r.state.seats['1'].viewer_id, 'v1');
  assert.strictEqual(r.broadcast.t, 'state');
});

it('players fill 1, 2, 3 in join order', () => {
  let s = room.emptyState();
  for (const p of [P1, P2, P3]) s = claim(s, p).state;
  assert.deepStrictEqual(Object.keys(s.seats).sort(), ['1','2','3']);
  assert.strictEqual(s.seats['3'].player_name, 'ALEX');
});

it('a fourth player is told the board is full and seats nobody', () => {
  let s = room.emptyState();
  for (const p of [P1, P2, P3]) s = claim(s, p).state;
  const r = claim(s, P4);
  assert.strictEqual(r.reply.t, 'full');
  assert.strictEqual(Object.keys(r.state.seats).length, 3);
});

it('the admin never takes a seat', () => {
  const r = claim(room.emptyState(), AD);
  assert.deepStrictEqual(r.state.seats, {});
});

it('reclaiming returns the same seat, so a reload keeps your chair', () => {
  let s = claim(room.emptyState(), P1).state;
  const r = claim(s, P1);
  assert.deepStrictEqual(Object.keys(r.state.seats), ['1']);
  assert.strictEqual(r.reply.t, 'state');
});

it('a seat patch only touches the sender\'s own row', () => {
  let s = room.emptyState();
  s = claim(s, P1).state; s = claim(s, P2).state;
  s = room.apply(s, P2, { t:'seat', patch:{ character_id:'eren', px:0.4, py:0.6 } }).state;
  assert.strictEqual(s.seats['2'].character_id, 'eren');
  assert.strictEqual(s.seats['1'].character_id, '');
});

it('a locked board refuses seat writes', () => {
  let s = claim(room.emptyState(), P1).state;
  s = room.apply(s, AD, { t:'lock', v:true }).state;
  const r = room.apply(s, P1, { t:'seat', patch:{ character_id:'goku' } });
  assert.strictEqual(r.state.seats['1'].character_id, '');
  assert.strictEqual(r.broadcast, null);
});

it('only the admin can lock, clear or drive the game', () => {
  let s = claim(room.emptyState(), P1).state;
  assert.strictEqual(room.apply(s, P1, { t:'lock', v:true }).state.locked, false);
  assert.strictEqual(room.apply(s, P1, { t:'clear' }).state.seats['1'].viewer_id, 'v1');
  assert.strictEqual(room.apply(s, P1, { t:'game', patch:{ started:true } }).state.game.started, false);
});

it('clear frees the seats but keeps spent clues', () => {
  let s = claim(room.emptyState(), P1).state;
  s = room.apply(s, AD, { t:'game', patch:{ started:true, used:['0-0-0','0-1-2'] } }).state;
  const r = room.apply(s, AD, { t:'clear' });
  assert.deepStrictEqual(r.state.seats, {});
  assert.deepStrictEqual(r.state.game.used, ['0-0-0','0-1-2']);
  assert.strictEqual(r.state.game.started, false);
});

it('game state is sanitised, not trusted', () => {
  const s = room.apply(room.emptyState(), AD,
    { t:'game', patch:{ started:'yes', page:-4, open:{ c:'x', r:1 }, used:'nope' } }).state;
  assert.strictEqual(s.game.started, true);
  assert.strictEqual(s.game.page, 0);
  assert.strictEqual(s.game.open, null);
  assert.deepStrictEqual(s.game.used, []);
});

it('hands relay to peers and never change state', () => {
  const s = claim(room.emptyState(), P1).state;
  const r = room.apply(s, P1, { t:'hand', x:0.3, y:0.7, pose:'grab', slot:1, name:'DAN' });
  assert.strictEqual(r.state, s);
  assert.strictEqual(r.broadcast, null);
  assert.strictEqual(r.relay.tab, 't1');
  assert.strictEqual(r.relay.x, 0.3);
});

it('a junk state file does not take the server down', () => {
  const s = room.sanitizeState({ seats:{ '9':{ seat:9, viewer_id:'x' }, '1':{ nope:true } }, locked:'yes', game:null });
  assert.deepStrictEqual(s.seats, {});
  assert.strictEqual(s.locked, true);
  assert.deepStrictEqual(s.game, room.emptyGame());
});

it('the right password makes an admin', () => {
  assert.deepStrictEqual(room.authRole('admin', 'hunter2', 'hunter2'), { role:'admin', denied:false });
  assert.deepStrictEqual(room.authRole('admin', ' HUNTER2 ', 'hunter2'), { role:'admin', denied:false });
});

it('a wrong, missing or empty password does not', () => {
  for (const pw of ['nope', '', '   ', null, undefined, 0, {}]) {
    const r = room.authRole('admin', pw, 'hunter2');
    assert.strictEqual(r.role, 'viewer', 'pw ' + JSON.stringify(pw) + ' got in');
    assert.strictEqual(r.denied, true);
  }
});

it('a server with no password set admits no admin at all', () => {
  assert.deepStrictEqual(room.authRole('admin', '', ''), { role:'viewer', denied:true });
  assert.deepStrictEqual(room.authRole('admin', 'anything', null), { role:'viewer', denied:true });
});

it('players and viewers need no password, and junk roles watch', () => {
  assert.deepStrictEqual(room.authRole('player', '', 'hunter2'), { role:'player', denied:false });
  assert.deepStrictEqual(room.authRole('viewer', '', 'hunter2'), { role:'viewer', denied:false });
  assert.deepStrictEqual(room.authRole('wizard', '', 'hunter2'), { role:'viewer', denied:false });
});

it('a demoted admin cannot drive the game', () => {
  const faker = { viewerId:'vx', name:'NOPE', role: room.authRole('admin','wrong','right').role, tabId:'tx' };
  let s = room.apply(room.emptyState(), faker, { t:'game', patch:{ started:true } }).state;
  assert.strictEqual(s.game.started, false);
  s = room.apply(s, faker, { t:'lock', v:true }).state;
  assert.strictEqual(s.locked, false);
});

console.log('\n' + pass + ' passing');
