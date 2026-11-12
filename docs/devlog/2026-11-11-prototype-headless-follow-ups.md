# Headless prototype follow-ups

- Kind: idea
- Date: 2026-11-11
- Source: moved from `how-it-works/prototype-headless.md`; #18009, #17975
- Shaped: [Headless prototype mode](../how-it-works/prototype-headless.md)

## Not covered when headless mode landed

- Routing interaction tools (`tapOn`, `inputText`) and the browser page's taps into
  `VirtualPrototypeDevice.dispatch`. A renderer that reports taps and input back (the live preview
  server, #17975) would call `dispatch`.
- Timers and `simulate` (`prototype_timers_v1`).
- A project export: separate `index.html`, JS, CSS and `package.json`.
