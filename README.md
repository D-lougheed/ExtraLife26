# Extra Life 26 — Party Select

A character select screen for the Extra Life stream. Players open a link, take a
seat, and drag a numbered puck onto the fighter they want. Everyone's cursor is
a coloured glove visible to every other viewer, so the stream sees hands moving
around the roster in real time.

## Running it

The page, the images and the sync all come from one Node service, so the tunnel
needs a single ingress rule and there is no cloud account in the path.

```
npm install
node server.js
```

It listens on **8080** unless `PORT` says otherwise, prints the URL, and answers
`/health` with the live client and seat count. Point the Cloudflare tunnel at
that port.

On first run it prints the admin password and saves it to
`admin-password.txt`, so a restart keeps the same one. Set your own with
`ADMIN_PASSWORD=whatever node server.js`, or edit that file. Both are ignored by
git, and the password is never sent to the page — the server is the only thing
that checks it.

State lives in memory and is mirrored to `state.json` beside the server, so a
crash or a restart mid-show comes back with the same seats, the same picks and
the same spent clues. Delete that file for a clean slate.

Only the page, the images and `/health` are served. Source, saved state and the
password file are not reachable over HTTP, which matters when the port is on a
public tunnel.

**Serve it over HTTPS** (the tunnel already does). Pointer events behave
inconsistently over plain HTTP in some browsers, and the page picks `wss://`
automatically when it is loaded over TLS.

## Roles

Everyone uses the same URL; the join screen sorts out who is who.

| Role | What it does |
|---|---|
| **Player** | Takes the next free seat (P1, P2, P3 in join order), carries a puck, picks a fighter |
| **Viewer** | The broadcast source. No cursor of its own and no interface chrome — just the board and everyone's hands. This is the one to point OBS at |
| **Admin** | Runs the board and takes no seat, keeping a plain glove to point with, plus **Lock it in** and **Clear board**. The **×** in a seat's corner removes that one player (no confirm, locked or not), who lands back on the join screen and can pick Player again. Password gated |

For OBS: add it as a **Browser Source**, set width and height to your canvas, and
turn off *Shutdown source when not visible* so it stays connected while you are
on another scene.

## How a pick works

1. Enter as a player — you are seated automatically in the lowest free seat
2. Click your puck to pick it up; it rides in your glove
3. Click anywhere on a fighter's tile to set it down — the puck stays exactly
   where you dropped it
4. Click it again to lift it and change your mind

Once every seated player's puck is down, a **READY TO FIGHT** banner drops across
every screen. The moment anyone lifts a puck, it disappears again.

## Configuration

Everything adjustable sits in one block at the top of the `<script>` in
`index.html`. The seat count lives in `SLOT_COUNT` just below it, and the port
is `PORT` in the environment:

| Setting | Purpose |
|---|---|
| `OPPOSITION` | The text after "vs" in the top banner |
| `ROSTER` | The character list |
| `BOARDS` | The jeopardy boards: three of them, six categories each, six clues per category worth 1-6 Focus (`v`) |

A roster entry needs only a name:

```js
{ name: "Mereoleona", series: "Black Clover", img: "https://..." }
```

`series` shows on hover and under the portrait. `img` is optional — without it
the tile shows the character's initials on a colour derived from the name, which
is stable across reloads.

## Character art

A roster entry needs no `img`. The tile looks for `images/<slug>.png` and then
`images/<slug>.jpg`, where the slug is the name lowercased with spaces turned
into hyphens — `Aoi Todo` becomes `images/aoi-todo.png`. Nothing found leaves
the coloured initials tile, which is a supported state.

To swap a character's picture, drop a file at that path and reload. No code
change, no rebuild. The same lookup fills the portrait on the player's card.

Art currently in the repo came from each series' Fandom wiki, except Alphonse,
Eren and Aoi Todo, which use the portraits that were already in `images/`.

## The jeopardy board

**Start the game** in the admin footer moves every screen — players and the OBS
viewer — onto the board. The flow from there:

1. The admin clicks a cell. The clue fills the screen on every connected page.
2. **Show answer** puts the answer up for everyone.
3. **Next** marks that cell dark and unpickable and returns everyone to the grid.

Clearing the last cell on a board moves straight to the next one, so the night
runs board 1 to board 3 without an extra click. **Next board** skips ahead early;
**Back to party select** returns everyone to the roster screen.

Only the admin can pick. Players and viewers see the same screen with no
controls, and their pucks are frozen while the board is up. Hands are hidden
while the board is up: no glove is drawn or relayed, and players and the admin
get their normal mouse cursor back. Gloves return on the next mouse move after
**Back to party select**.

Progress lives in `board.game` and survives a reload — an OBS source that
reconnects mid-show lands back on the right screen. **Clear board** frees the
seats and returns everyone to select but deliberately keeps trivia progress, so
a mid-show reset does not replay answered clues. To start the trivia over, the
admin's **Reset questions** button (on the grid or Board clear view, behind a
confirm) clears all clue progress on every board and puts everyone back on
board 1 with the game still running.

Editing `BOARDS` is the only thing needed to change the questions. The grid is
drawn from that array, so a category with four clues instead of five just works.

## Backend

Two files, split so the interesting logic is not tangled with socket plumbing.

| File | Responsibility |
|---|---|
| `room.js` | Pure state machine. Takes a message, returns the next state plus what to send where. No I/O, no sockets. This is the part under test — `npm test` |
| `server.js` | Transport. Serves the files, holds the WebSocket room, calls `room.js` and fans out the result, mirrors state to `state.json` |

The room is `{ seats, locked, game }`. Clients send `hello`, `claim`, `seat`,
`lock`, `clear`, `kick` (admin only, `{ t:"kick", seat:n }`), `game` and
`hand`; the server answers with `state` (the whole room, after any change),
`hand` (relayed, never stored), `gone` (drop that glove), `full` and `kicked`
(sent to the removed player's sockets, which the server then treats as viewers
so they cannot simply claim again).

Seat claiming is atomic: the server picks the lowest free seat under one lock,
so there is no race to resolve and no retry loop in the page. A seat is held by
`viewer_id` and is **not** freed when a socket closes — a reload, a flaky phone
or a dropped tunnel puts that player back in their own chair. Only *Clear board*,
or the admin removing one player, frees seats.

The page reconnects on its own with backoff (500ms doubling to 5s, jittered), so
an OBS source that loses its socket comes back by itself rather than sitting
dead for the rest of the night. The footer reads `LIVE` or `OFFLINE`.

### Access

Anyone with the URL can open the page and take a seat — for a one-evening
charity stream that is the intended trade. If the link circulates further than
you would like, a room code in the page is the next step.

Admin is different. The password lives only on the server; the page sends what
was typed and the server decides. Getting it wrong sends you back to the join
screen rather than handing you a board full of buttons that do nothing, and a
connection that claimed admin without the password is treated as a viewer for
every message it sends afterwards. `npm test` covers that.
