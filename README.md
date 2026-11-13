# Nightdrive

Endless procedural neon night drive — three.js + Vite + TypeScript.

```sh
npm install
npm run dev       # http://localhost:5173
npm run build     # static site in dist/ (serve it with any static server)
```

## Controls

| Key | Action |
|---|---|
| `F` / double-click | fullscreen |
| `N` / WASH switch | next scene (washer sweep + fade) |
| `R` / WIPE switch | toggle rain (wipers run while it rains) |
| `D` / DIM switch | dim the night sky and street lights |
| INFO switch | open the current station's website |
| `M` | toggle VHS post-fx |
| `G` | trigger a glitch |
| `Space` | pause |

## Car radio

A cassette receiver in the centre console with a 5×7 dot-matrix LED display.

- **Radio:** streams [Nightride FM](https://nightride.fm) channels (synthwave, chillsynth, datawave, spacesynth, darksynth, horrorsynth) with live now-playing titles. Presets 1–5; ◄◄ / ►► seek through all channels. Nightride FM is listener-supported; consider supporting them.
- **Tape:** drop audio files onto the page (or press ▲ TAPE to pick files) to insert a "tape"; ◄◄ / ►► skip tracks, ▲ TAPE ejects back to radio.
- Click the buttons in the dashboard, scroll over the radio for volume, click the knob to mute. Media keys / desktop media controls work too (Media Session).

| Key | Radio action |
|---|---|
| `1`–`5` | station presets |
| `P` / `Enter` | play / stop |
| `←` `→` (or `,` `.`) | previous / next (station or track) |
| `↑` `↓` (or `+` `-`) | volume |
| `0` | mute |
| `E` | tape / eject |

Browsers only allow audio after a user interaction, so the car waits at the start with "PRESS ANY KEY / TO START DRIVING" on the radio display; the first click or key press starts the music and the car accelerates away (use `?autoplay` together with a browser autoplay permission, e.g. Chromium `--autoplay-policy=no-user-gesture-required`).

Dev: `npm run dev` then open `/#test-tape` to insert a generated test tape with a state overlay.

## URL parameters

`?scene=dusk` · `?q=0.75` (render scale) · `?fx=0` · `?glitch=0` · `?seek=120` · `?rain` · `?autoplay` · `?screensaver` (closes the window on input) · `?eggs=0` (no sky easter eggs; `?eggs=20` makes them 20× more frequent)

## Layout

```
src/
  main.ts              renderer, simulation loop, camera, input
  config.ts            URL parameters
  scenes/              ScenePreset type + presets (night, dusk) — new scenes are mostly data
  world/Track.ts       endless road centreline (curvature + elevation), floating-origin friendly
  world/Chunks.ts      road surface shader, neon markings, lamps, reflectors, terrain (per 60 m chunk)
  world/Sky.ts         sky dome shader (gradient + procedural stars) + galaxy billboard
  world/Mountains.ts   distant silhouette rings
  world/Traffic.ts     oncoming cars + lead car
  cockpit/Cockpit.ts   dashboard, wheel, pillars, live-canvas instrument cluster
  cockpit/Radio.ts     cassette receiver view: LED matrix, cassette door, buttons, knob
  cockpit/ledFont.ts   5×7 dot-matrix font
  audio/RadioPlayer.ts stream/tape playback, Nightride metadata (SSE), analyser, volume
  audio/stations.ts    station list (presets = first five)
  input/radioInput.ts  button picking, wheel volume, drag & drop, media keys
  fx/Post.ts           bloom + VHS shader (chromatic aberration, scanlines, grain, glitch)
prototype/index.html   original single-file 2D canvas prototype
```

## License

[CC0 1.0 Universal](LICENSE) — public domain dedication. Radio streams are provided by [Nightride FM](https://nightride.fm) and are not covered by this license.
