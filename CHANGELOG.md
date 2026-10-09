# Changelog

## 2.2.1

**Fog closer to the in-game map**
* Cartography tables are read: everything players recorded to a table (the game's own explored map) is uncovered exactly.
* Player traces count: the explore radius around every building, ship, cart, portal and tombstone is uncovered (someone stood there).
* `reveal_visited` was tuned against recorded table maps: margin 4 (the new default) with a 64 m circle per zone uncovers about 99% of what players had explored, where the old default 3 also opened about twice as much ground they never saw.
* `explore_radius` default 110 (the in-game map clears 100 m; a little more so trails don't look tighter than people remember), and the circle includes its edge cells like the game's.
* Existing configs keep their values. To tighten a map that already opened wider: set `reveal_visited_margin = 4`, stop the server, delete `map_data/<world>/fog.png`, start again.

**Map**
* Past the world's edge: the in-game map's own space backdrop, taken from the game files at startup (clouds as before when it can't be).
* Spawn rings reach the world's edge (whole rings only), the outermost is labelled, and the dashes stay put while zooming.
* Mini-boss lairs (Hildir's sisters: Smouldering Tomb, Howling Cavern, Sealed Tower) on explored ground, with the game's Hildir icons and a "found" event.
* Tile URLs carry the world's name, so a server that switches worlds can't show the old world's cached tiles.

**Stats**
* Mini bosses (Brenna, Geirrhafa, Zil & Thungr), Hildir's quests, what first kills unlocked (troll, surtling, bat raids), other boss keys (from mods too), and the world modifiers in words (Combat: Hard, Resources: More... with the exact effects on hover).

**3D**
* Left out: the Valkyrie on the spawn pillars and creatures inside models, loose pickups, loot chests, cave insides, attack roots and floating crates. Model library format 7: models are exported again once.

## 2.2.0

Smoother on slow connections and slow machines, and a lot more to look at. Upgrading: replace the whole `BepInEx/plugins/WebMap` folder with the one in the zip (it has four new DLLs next to `WebMap.dll`); your `map_data` and config are kept. Press Ctrl+Shift+R once in the browser after updating.

**2D map**
* Everything on the map is drawn on the GPU (WebGL): ground, fog, trees, buildings, world structures, markers, labels, grid and spawn rings. Zooming is continuous and smooth like valheim.tools, without stutter; jumping to a marker glides instead of stretching.
* Round world with a zoom-out limit, clouds past the edge, black fog inside.
* Trees and berries in their own colours (oak, birch, autumn birch, pine, raspberry, blueberry, cloudberry...), seabed rocks hidden, shallow-water ones faded. Trees, bushes & berries and rocks & ore switch on and off on their own.
* The game's own map icons (with a badge), Spawn and boss altars always labelled, traders (Haldor, Hildir, the Bog Witch) once found, distance rings from spawn, grid with coordinates.
* Labels no longer flicker on slow scroll or drag.

**Bandwidth and loading**
* Map tiles as WebP (about 45% smaller), content-hashed URLs cached for good, 304s for everything else: a repeat visit loads ~8 KB.
* Trees, buildings and world structures fetched by region instead of per chunk (421 to 143 requests on first load), unpacked off the main thread.
* After a restart everything is served from disk caches straight away (`markers-cache.json`, `structures-cache.txt`, `ruins-cache.txt`, `vegetation-cache.bin`).

**Events**
* New: raids (start and end, where), boss kills (and who was there), boss altars and traders found, everyone slept, a player's first time in a biome. Remembered in `world-events.txt`.
* Chat reads "Name: message", a leave shows once, the game's "I have arrived!" shout is dropped. Grouped filters with All / None, "Show older" pages back through `events.jsonl`.
* Server log view for admins (the key in `announce.token`): the game's console lines with the time each was written, kept in `server-log.txt`.

**Stats**
* Boss progress, totals (boss kills, raids, nights slept, deaths, peak online, bases, portals, ships and carts), pieces built per player, a leaderboard, discoveries with when and who.

**Sidebar**
* Layers, Markers and Players redesigned: switch cards with a map key, a marker search with folding sets and linked portal pairs, player cards plus who was on recently.

**3D**
* Drawn only when something changes, shadows only when needed, lighter trees, distant clutter left out, lower resolution while moving: much cooler and smoother on laptops. Loads while moving instead of after.
* Banners, rugs, cloth doors and crafting stations now have models (skinned meshes). Model library format 6: models are exported again once.

**Server**
* `GET /api/serverlog`, `GET /data/events/older.json`, `vegetation-kinds.txt` (every object name a sweep met, for checking the tree classifier).
* `tile_webp` config (on by default).

## 2.1.6

* Rename or hide the auto-detected bases from the web page. Click a base marker: type a name and Rename, "Hide this base" to drop it, "Auto name" to go back to the portal tag. Saved in `map_data/<world>/bases.json`, kept across re-scans. `web_edit_bases` turns it off (a token still works). `POST /api/base`, `POST /api/bases/reset`. (#14)
* 3D view links. The URL now follows the 3D camera (`#x,z,zoom,3d,distance,heading,tilt`), so a copied link opens the same spot, same angle. Before, only 2D updated the URL. (#13)
* Sharp 2D close-ups. Past the tiles' native zoom (1 m per pixel) the map used to scale pixels up into blocks. Now trees and rocks are drawn as shapes from the vegetation data, buildings are drawn at the screen's own resolution (crisp on phones and Retina), and the ground is scaled smoothly instead of in blocks. (#12)
* `base_min_pieces` and `base_min_per_cell` config: how much built stuff it takes before a spot counts as a base. Raise them if a lone workbench shows up as one.

## 2.1.5

* GitHub Releases. A version tag builds the mod in GitHub Actions and attaches the zip plus `SHA256SUMS` to a release, so the mod can be pinned by hash. (#15)
* Script and stylesheet URLs carry a hash of the file (via the import map), so a CDN or browser cache can never mix old and new web files. Fixes "WASD works in 2D but not 3D" / "time of day does nothing" after an update behind Cloudflare.
* Fix: a few box-only prefabs were re-exported every minute ("N models to re-export with newly extracted textures" forever), which also kept the texture extractor from starting for anything new.
* Keyboard everywhere: WASD/arrows move, Q E turn, R F tilt, Z X zoom, Shift fast, P follow next player, M 2D/3D, L layers, Home spawn. Double click in 3D centres on that spot. README "Controls".
* Follow works in 3D: camera glides after the player; drag, WASD or Esc lets go. Following carries over when you switch 2D/3D.
* "Lighting (3D)" heading in Layers for time of day and shadows.

## 2.1.4

* Sky, sun, moon and shadows in 3D. Sky dome with sun disc, stars, dawn and dusk colours; fog to the horizon; the sun follows the server's time of day (Layers > "Time of day", or pick a fixed one); buildings, trees and hills cast shadows (toggle, off on phones by default); water ripples and mirrors the sky; filmic tone mapping.

## 2.1.3

* Every model, not one in eight. The engine locks most meshes, so the 3D view drew boxes (a cart with its boxes but no cart, a bare beehive). The mod now reads locked meshes out of the game files like it already did textures: `extract_meshes` config, `map_data/models/meshes/`, `tools/extract_meshes.py` by hand. Model library format 5: everything is exported again once.
* Materials that keep their colour map under `_BaseMap` and friends get their texture too.

## 2.1.1

* Addressed issue [#2](https://github.com/f00d4tehg0dz/valheim-webmap/issues/2) with !pin command not working. Pins from the web page. Right click (long press on a phone), pick a type, label, done. Remove your own from the popup. `POST /api/pin`, `POST /api/unpin?id=`. `web_pins` turns it off. 
* Addressed issue [#3](https://github.com/f00d4tehg0dz/valheim-webmap/issues/3) with title bar in Mobile not being supported.
* Addressed issue [#1](https://github.com/f00d4tehg0dz/valheim-webmap/issues/1) with Web dir not being included in build, causing mod manager Gale to fail installation
* Addressed issue [#5](https://github.com/f00d4tehg0dz/valheim-webmap/issues/5) with @Aughen PR #6. WebSocket compression off by default, `websocket_compression` turns it back on. 
* Addressed issue with fog coverage not being 100% on initial load with @clanofartisans PR #7
* Build script: one `-ValheimManaged` path works. (#6)
* `POST /api/reload` (token): Update the web app without restarting the game.
* Layer list says "Pins", not "Chat pins".

## 2.1.0

* Old trips count. Fog lifts everywhere players have already been, even from
  before the mod was installed. The world save lists every zone the game
  built, and it only builds them near a player. Runs at start and once a
  minute. `reveal_visited` (on) and `reveal_visited_margin` (3 zones, about
  150 m from where they walked).
* Player card. Click a player on the map, in 3D or in the list: health,
  stamina, eitr, what they wear and hold, state, lifetime stats. Updates live.
  Server now sends stamina, eitr and gear.
* Export. Pick an area, get a 3D scene: glTF (instanced, or one node per
  object) or an Unreal pack with a 16-bit heightmap, CSVs in Unreal units
  and an editor script. Made in the browser. Fog applies.
* Demo site. `tools/Dockerfile.demo` and `docker-compose.demo.yml` run the
  mock server as a public demo. Mock draws the tree and rock overlay and
  loops forever.
* Stats table fits the sidebar. README in plain words.

## 1.0.1

First public release. Same as 1.0.0 plus README and screenshot fixes.

## 1.0.0

First release.

* Tiled map, seven zoom levels, 1 m/px. Rendered from world generator plus
  player terraforming (levelled ground, moats, paved roads, farmland). Trees,
  bushes, rocks as a separate overlay layer. Close-zoom tiles render only over explored ground.
  Re-render when ground changes. Worker thread, own PNG encoder, sliced
  main-thread fallback.
* Buildings as vector data per 256 m chunk: footprint, height, material,
  prefab. Drawn as material-coloured footprints with hover info.
* 3D view (three.js). Terrain from height tiles with quadtree LOD, seamless
  between tiles, clean ground tiles with tiled fine grain up close. Water.
  Players. Markers. World objects as game's own meshes: mod exports each
  prefab to glTF once (`map_data/models/`), publishes each chunk's objects
  with prefab, position, rotation, scale. Browser instances models.
* Textures pulled from the game's own asset files by the mod itself, in the
  background, on every platform. `tools/extract_textures.py` as manual
  fallback. `POST /api/reexport` rebuilds models.
* Fog of war always on. Black over unexplored ground. World locations
  (bosses, dungeons, traders) never published.
* Markers: portals with tags and links, tombstones,
  player bases (clusters of built pieces), boats, carts, custom
  `markers.json` sets.
* Layer toggles drive 2D and 3D: buildings with opacity, players, chat pins,
  trees and rocks overlay (2D),
  labels, 256 m grid, marker sets, object categories.
* Stats per player: playtime, sessions, deaths, distance, portal trips,
  biomes. Per server: day, explored %, counts, online history.
* Event feed with `events.jsonl` history. Deaths carry position.
* Web app: dark UI, sidebar, search, permalinks, follow mode, mobile
  layout. No build step.
* Simple endpoints kept for scripts: `/map`, `/players`, `/pins`,
  `/messages`, `/structures`, `/forest`, `/vehicles`. Websocket speaks JSON.
* Discord webhook, `POST /announce`, chat pin commands.
