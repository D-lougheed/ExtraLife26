# Extra Life 26 — Party Select

A character select screen for the Extra Life stream. Players open a link, take a
seat, and drag a numbered puck onto the fighter they want. Everyone's cursor is
a coloured glove visible to every other viewer, so the stream sees hands moving
around the roster in real time.

## Deploying

One file, no build step. Serve `index.html` from any web server:

```
git clone https://github.com/D-lougheed/ExtraLife26.git
```

Point the domain at it and you're done. Supabase's client library and the fonts
load from CDNs, so the only requirement is that the machine can reach the
internet.

**Serve it over HTTPS.** Pointer events behave inconsistently over plain HTTP in
some browsers, and players joining on phones will expect the padlock.

## Roles

Everyone uses the same URL; the join screen sorts out who is who.

| Role | What it does |
|---|---|
| **Player** | Takes the next free seat (P1, P2, P3, P4 in join order), carries a puck, picks a fighter |
| **Viewer** | The broadcast source. No cursor of its own and no interface chrome — just the board and everyone's hands. This is the one to point OBS at |
| **Admin** | Everything a player can do, plus **Lock it in** and **Clear board**. Password gated |

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
`index.html`:

| Setting | Purpose |
|---|---|
| `SUPABASE_URL` / `SUPABASE_KEY` | The realtime backend. Already wired to the Extra Life 26 project |
| `ADMIN_PASSWORD` | Gates the admin role |
| `OPPOSITION` | The text after "vs" in the top banner |
| `ROSTER` | The character list |

A roster entry needs only a name:

```js
{ name: "Mereoleona", series: "Black Clover", img: "https://..." }
```

`series` shows on hover and under the portrait. `img` is optional — without it
the tile shows the character's initials on a colour derived from the name, which
is stable across reloads.

## Backend

Supabase project **Extra Life 26** (`rrujjcarpdazwrdqcvmj`), two tables:

- `seats` — one row per occupied seat. `seat` is the primary key, so two people
  claiming at once is resolved by the database rejecting the second insert
  rather than by any locking in the page
- `board` — a single row holding the admin lock

Live hands ride on Supabase Realtime Presence, which is ephemeral and never
touches the database.

### Access

Row level security is open to anonymous visitors on both tables. That is what
lets people join from a link without signing in, and it means **anyone who has
the URL can take a seat**. For a one-evening charity stream that is the intended
trade; if the link circulates further than you would like, the options are a
room code in the page or tightening the policies.
