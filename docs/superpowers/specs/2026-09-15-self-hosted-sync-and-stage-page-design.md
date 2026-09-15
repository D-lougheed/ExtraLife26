# Self-hosted sync and the adventure stage page

Design, 2026-09-15. Approved.

## Why

Three things were asked for: the READY banner should not appear when nobody is
playing, the admin should not occupy a player slot, and the admin should be able
to start the game — fading every screen into a stage page that tracks progress
through the adventure.

Designing those surfaced a larger decision. The page currently syncs through
Supabase Cloud; the sync layer is moving onto our own server instead. That
replaces seat claiming, the board lock, and the live hands, so it lands first
and the three requested changes sit on top of it.

## Scope

In: a Node sync service, the client swap onto it, the two bug fixes, and the
stage page.

Out: the open-to-anyone access question (a room code is a separate decision),
Cloudflare Tunnel and service-restart setup (owner handles deployment), the
roster content, and the OBS sizing pass.

The Supabase project is left in place and simply goes unused. It costs nothing
and remains a fallback if the server misbehaves during the show.

## Architecture

Three files, split so the interesting logic is not tangled with socket plumbing.

| File | Responsibility |
|---|---|
| `room.js` | Pure state machine. Takes a message, returns new state plus what to broadcast. No I/O, no sockets. This is the part under test. |
| `server.js` | Transport. Serves static files and holds the WebSocket room; calls `room.js` and fans out the result. |
| `index.html` | The page. Supabase client swapped for a WebSocket one; everything else unchanged. |

Static files and the socket share one port, so deployment needs a single tunnel
ingress rule. Port is `process.env.PORT || 8080`.

State lives in memory. Restarting the server clears the board, which is the same
thing *Clear board* does and what you would do before the segment anyway.

### Room state

```
{
  seats:   { "1": seatRow, ... },   // sparse, keys "1".."4"
  locked:  false,
  started: false,
  stage:   0                        // 0 = none lit, 1..5
}
```

`seatRow` keeps the exact shape the page already renders, so no render function
changes: `{ seat, viewer_id, player_name, character_id, held, px, py }`.
`updated_at` is dropped — nothing reads it.

`started` and `stage` are separate so the stage page can be reached with all
five slots still open, and *Next* lights stage 1.

## Protocol

JSON both directions.

Client to server:

| Message | Fields | Effect |
|---|---|---|
| `hello` | viewerId, name, role, tabId | Registers the connection; reclaims a held seat when viewerId matches. Server replies with full state. |
| `claim` | — | Server assigns the lowest free seat, or replies `full`. |
| `seat` | patch: character_id, px, py, held | Merges into the sender's own seat. Ignored for any other seat. |
| `lock` | v | Admin only. |
| `clear` | — | Admin only. Wipes seats, and resets locked, started and stage. |
| `start` | v | Admin only. `false` returns everyone to select, preserving seats. |
| `stage` | v | Admin only. Clamped to 0..5. |
| `hand` | x, y, pose, slot, name | Relayed to peers. Never stored. |

Server to client:

| Message | When |
|---|---|
| `state` | On `hello`, and after any state change. Carries the whole room. |
| `hand` | A peer moved. Carries their tabId. |
| `gone` | A peer's socket closed — drop their glove. |
| `full` | A `claim` found no free seat. |

Hands are relayed and never stored, matching Presence today, so the ~25/s
coalescing already in the page is kept as-is.

Clients derive their own seat by matching `viewer_id`, exactly as `mySlot()`
does now, so the protocol carries no per-recipient state.

### Trust

The server trusts the `role` given in `hello`, including `admin`. That is the
same posture as today, where the admin password sits in public client source at
`index.html:232` and anyone reading the repo has it. Moving the check
server-side behind an env var was offered and not taken; it remains the fix that
would close this, and nothing in this design blocks it later.

## Seats

Two improvements fall out of owning the server, both addressing complaints in
the handoff.

**Claiming becomes atomic.** The page currently races for a seat and relies on
Postgres rejecting a duplicate primary key, then retries the next seat. The
server picks the lowest free seat under one lock, and the retry loop in
`autoSeat()` at `index.html:336` disappears.

**Stale seats self-heal.** A socket close tells the server a player is gone,
which the database never could. A naive version of this would break reloads, and
reload survival is the entire reason `elViewerId` exists — so:

- On socket close the seat is marked orphaned, not freed, and stays visible.
- A `hello` carrying the same `viewerId` within 20 seconds reclaims it.
- A sweep every 5 seconds frees seats orphaned longer than that, and broadcasts.
- An orphaned seat still counts as occupied, so another player claiming during
  the window lands on the next free seat rather than taking it.

Close a laptop and the seat frees itself; refresh and you keep it. *Clear board*
stays as a manual override but should stop being load-bearing.

The 20-second grace period is a judgement call about player behaviour and is the
single number most likely to need tuning on the night.

## Client changes

Deliberately small. `slots`, `adminLock` and every render function keep their
current shapes, so `renderRoster`, `renderSlots` and all the glove code are
untouched. What changes:

- The supabase-js script tag comes out.
- `pushSeat`, `dropSeat`, `setAdminLock`, `clearBoard` and `autoSeat` send
  messages instead of Supabase calls. Optimistic local application stays.
- `connect()` opens a WebSocket against `location.origin`, choosing `wss` when
  the page is served over HTTPS.
- New client state: `started` and `stage`.

**Reconnect with backoff** must be added — Supabase provided it for free. Without
it, an OBS source that drops a socket stays dead for the rest of the night.
500ms doubling to a 5s cap, with jitter; on reconnect the client re-sends
`hello` and re-renders from the full state that comes back.

The footer status tag currently reads `SYNC + HANDS` because there were two
independent connections. With one socket it becomes `LIVE` or `OFFLINE`. The
pre-flight instruction in `HANDOFF.md` names the old string and must be updated
with it.

## The two bugs

**Admin takes a seat.** `CAN_PLAY()` at `index.html:279` gates seating as well as
gloves, the click handler and presence. A new `CAN_SEAT = () => ROLE === "player"`
guards seating only. The admin keeps a hand to point with — the plain white glove
in `GLOVE_PLAIN` already exists for slotless hands — but takes no slot. Their
clicks go inert on their own, because `mySlot()` and `carrying()` both return
null.

**Banner on an empty board.** `bannerOn()` at `index.html:302` becomes
`!started && allPlaced()`, dropping the `|| adminLock` that let an admin raise
the banner on an empty board by locking it. `allPlaced()` already refuses to fire
on zero claimed seats, so with the admin no longer seated an empty board cannot
raise it. Locking still freezes picks; it just stops forcing the banner up.

## The stage page

A `STAGES` array at the top of the script, mirroring `ROSTER` so configuration
stays a one-file edit:

```js
const STAGES = [
  { name:"...", img:"" },
  { name:"...", img:"" },
  { name:"...", img:"" },
  { name:"...", img:"" },
  { name:"...", img:"", boss:true },
];
```

The five entries ship with placeholder names and empty `img` fields by design;
the owner fills in both once the artwork exists. An empty `img` is a supported
state, not an unfinished one.

Five slots across the screen in the same brushed-steel frame as the roster tiles.
Unlit is a dark plate carrying its number. Reached stages show their art at full
brightness and stay lit. The current one takes a gold border. Stage 5 renders a
boss icon as inline SVG — the approach already used for the VS badge and the
gloves — so it reads as the finale before there is art for it. Any stage without
an `img` falls back to the deterministic colour wash the roster uses.

The top bar stays, with the title showing the current stage's name.

Hands stay live on this screen, so the room still feels occupied and the admin
can point at where the party is.

Stage art fills in on arrival at a stage, not on its completion.

### Controls

Select screen, admin footer: *Lock it in* and *Clear board* as now, plus
*Start the adventure*.

Stage screen, admin footer: *Back*, *Next*, and *Back to party select* to escape
a premature start. *Clear board* also returns everyone to select.

*Lock it in* and *Start* stay separate deliberately: locking freezes picks so
nobody fiddles while READY TO FIGHT sits on screen, and starting is the second,
deliberate beat.

### The fade

A crossfade of about 700ms on `started` flipping — select out, stage in — driven
by opacity so it costs nothing on the OBS source. Every client runs it off the
same broadcast, so it lands together on the stream and on phones.

## Testing

`node:test` and `node:assert`, against `room.js` only, which is pure and needs no
sockets. Cases:

- Claims assign seats 1 through 4 in order; a fifth returns `full`.
- A claim from an already-seated `viewerId` returns the existing seat.
- A `seat` patch from a non-owner is ignored.
- `lock`, `clear`, `start` and `stage` from a non-admin are ignored.
- `stage` clamps to 0..5.
- `clear` resets seats, locked, started and stage together.
- A close marks the seat orphaned and leaves it visible; a sweep past the grace
  period frees it; a `hello` with the same viewerId inside the window reclaims it.
- `start:false` returns to select while preserving seats.

`server.js` is a thin shell over `room.js` and is verified by running the show
end to end, not by unit tests.

## Build order

1. `room.js` and its tests.
2. `server.js`, `package.json`, static serving.
3. The client swap. This is the risky step — at the end of it everything must
   behave exactly as it does today, with no new features visible. The one
   intended visible difference is the footer tag reading `LIVE` instead of
   `SYNC + HANDS`; anything else that changes is a regression.
4. The two bug fixes.
5. The stage page.

Steps 1 and 2 add files without touching `index.html`, so the current page keeps
working throughout. Step 3 is the point of no return.

## Deployment

`git pull`, `npm ci`, restart — owner handles the service and the tunnel. Static
files and the socket share one port, so one ingress rule covers both.
`package-lock.json` is committed so `npm ci` is reproducible.

Static serving resolves paths against the repo root and refuses traversal, since
this is reachable from the internet through the tunnel.
