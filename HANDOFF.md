# Extra Life 26 — Party Select · Handoff

Status as of 2026-09-14. Written for whoever picks this up next, including
future-you after the show.

## What it is

One HTML file that runs a Smash-style character select screen. Players open a
link on their own device, take a seat, and carry a numbered puck onto the
fighter they want. Every cursor is a coloured glove visible to everyone else, so
the stream sees hands moving around the roster live.

**It is deliberately a single static file.** There is no build step, no server
process, and no framework. The realtime backend is Supabase; everything else is
the file. Treat that as a feature — it means deploying is `git pull`.

## Where things are

| | |
|---|---|
| Repo | `github.com/D-lougheed/ExtraLife26` — **public** |
| Page | `index.html` (the whole application) |
| Server copy | `C:\inetpub\extralife26` on the Windows box |
| Backend | Supabase project **Extra Life 26**, `rrujjcarpdazwrdqcvmj`, us-east-2 |
| Serving | Cloudflare Tunnel → a local static server (**setup unfinished**, see below) |

A second build exists in the *drawsteel-workbench* repo at
`charselect/charselect.html`. That one syncs through claude.ai's own
capabilities instead of Supabase, which made it organisation-internal and
required every viewer to sign in. It is kept only for reference. **The Supabase
build is the real one.**

## Configuration

Everything adjustable is in one block at the top of the `<script>`:

| Setting | Notes |
|---|---|
| `SUPABASE_URL`, `SUPABASE_KEY` | Already wired. The key is publishable and safe in public source |
| `ADMIN_PASSWORD` | Currently `Dan`. Case-insensitive, trimmed |
| `OPPOSITION` | Text after "vs" in the top banner. Currently `Adventure` |
| `ROSTER` | The character list |

A roster entry needs only `name`; `series` and `img` are optional:

```js
{ name: "Mereoleona", series: "Black Clover", img: "https://..." }
```

Without `img`, a tile shows the character's initials over a colour derived from
the name — deterministic, so it never changes between reloads.

## How it works

**Roles.** One URL; the join screen sorts out who is who. Player, Viewer, Admin
(password gated). The role is remembered in `localStorage`, so a reload rejoins
automatically — important for an OBS browser source that restarts. The faint
*change role* control at bottom-left clears it.

**Seats** fill in join order. Claiming inserts a row into `seats`, where `seat`
is the primary key — so two people claiming simultaneously is settled by the
database rejecting the second insert, not by any locking in the page. The loser
retries the next seat.

**Pucks.** Click yours to lift it, click a fighter to set it down. The drop point
is stored as a 0–1 coordinate pair relative to the tile, so a puck stays exactly
where it was dropped and lands identically on a different screen size.

**The banner** appears automatically once every seated player's puck is down, and
vanishes the instant anyone lifts one. The admin's *Lock it in* is separate and
freezes the board.

**Hands** ride on Supabase Realtime Presence — ephemeral, never touching the
database. Presence writes are coalesced to ~25/second.

## Things that will bite you

**Identity is split deliberately.** `elViewerId` in `localStorage` owns your
seat and survives reloads. A separate per-page-load `tabId` identifies your hand
in the room. They must stay separate: two windows in one browser share
`localStorage`, and if the hand used that id each would discard the other's
cursor as its own reflection. This was a real bug.

**Never re-render on hover.** Hover state is applied by toggling a class in
place. An earlier version rebuilt the roster on every hover change, which
destroyed the element between mousedown and mouseup — so no click event ever
fired and pucks could not be picked up. If you touch `updateHot`, keep it
class-only.

**Stale seats wedge the board.** A player who closes their laptop leaves a seat
owned by an id nobody holds. **Admin → Clear board** is the fix, and it is why
that button exists. A seat is only counted when it names an owner (`seatOf`),
which guards against half-written rows.

**Access is open on purpose.** Row level security permits anonymous reads and
writes on both tables — that is what lets people join from a link with no
account. Combined with a public repo, anyone who finds the URL can take a seat.
For one charity evening that was the accepted trade. If it stops being
acceptable, the smallest fix is a room code on the join screen; the thorough one
is tightening the policies.

## Database

```
seats   seat (PK, 1-4), viewer_id, player_name, character_id,
        held, px, py, updated_at
board   id (always 1), locked, updated_at
```

Both are on the `supabase_realtime` publication with `replica identity full`,
which realtime needs to report deletes to subscribers. Both have a single
permissive RLS policy for `anon` and `authenticated`.

Verified end-to-end as the `anon` role: claiming, the primary-key rejection of a
duplicate claim, placing, locking, and clearing all work without an account.

## Unfinished

1. **Deployment isn't done.** The files are on the box. The Cloudflare Tunnel
   needs an ingress rule routing the public hostname to whatever local port
   serves the folder, and the local server should be something that survives a
   reboot rather than a console window.
2. **The roster is placeholder names** with no artwork. Supply `img` URLs for
   art you have the rights to — portraits will do more for how this looks than
   any further CSS work.
3. **Never visually verified by the author.** Every version was written without
   being seen rendering; local files would not load in the authoring preview.
   The Supabase layer *was* tested against the live database. Treat the layout
   as unproven until you have looked at it on the actual show screen.
4. **No sizing pass for a fixed canvas.** Everything sits in a 1040px column. On
   a 1920-wide OBS source that leaves bars. Tell whoever continues this the
   target resolution and the grid and cards can be sized to fill it.

## Before going live

- Load the page and check the footer tag reads **`ADMIN · SYNC + HANDS`**.
  That single line proves both the database and live presence connected. If it
  says `SYNC` alone or `OFFLINE`, nothing else matters until that is fixed.
- Test from a phone on mobile data, not just the LAN — that exercises the real
  path a player will take.
- Have one other person join while you watch the viewer screen.
- Clear the board immediately before the segment, so no test state is on screen.
