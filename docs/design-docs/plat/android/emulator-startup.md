# Emulator Startup & Headless Hosts

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> See the [Status Glossary](../../status-glossary.md) for chip definitions.

When AutoMobile cold-starts an Android emulator (`startDevice` → `startEmulator`
in `src/utils/android-cmdline-tools/AndroidEmulatorClient.ts`), it picks the
display mode based on the host and a small set of environment variables.

## Display mode auto-detection

AutoMobile observes and streams the device screen itself, so the emulator's own
window is never the interaction surface — it only ever adds cost or crash surface.
Two hosts default to **headless** for that reason:

- **macOS** — the emulator's Qt window backing store segfaults on repaint under
  CoreAnimation (`EXC_BAD_ACCESS` in `QCALayerBackingStore::beginPaint`), which
  recurs across launches and takes the whole guest down (it reads as "input
  stuck"). Dropping the window removes the crash surface entirely.
- **Headless Linux** (a CI runner with no X server, a container, an SSH session
  with no `DISPLAY`) — a windowed launch cannot connect to the display, fails to
  load the Qt `xcb` platform plugin, and is killed by signal in a few hundred
  milliseconds. Node reports the signal death as `code: null`, which previously
  collapsed into an opaque `Emulator process exited with code: null`.

AutoMobile resolves the display mode as follows (first matching row wins):

| Condition | Mode |
|-----------|------|
| `AUTOMOBILE_EMULATOR_HEADLESS=true` | **headless** (any platform) |
| `AUTOMOBILE_EMULATOR_HEADLESS=false` | **windowed** (forced, even on macOS or a Linux host with no display) |
| macOS | **headless** (auto; opt back in with `AUTOMOBILE_EMULATOR_HEADLESS=false`) |
| Linux with no `DISPLAY` and no `WAYLAND_DISPLAY` | **headless** (auto) |
| Linux with `DISPLAY`/`WAYLAND_DISPLAY`, Windows | **windowed** |

In headless mode AutoMobile appends `-no-window -no-audio` to the `emulator`
invocation. The chosen mode and the reason are logged at `INFO`.

If a windowed launch still fails with a display / Qt-plugin error (for example
because `AUTOMOBILE_EMULATOR_HEADLESS=false` was set on a headless host),
AutoMobile detects the underlying error in the emulator output and surfaces an
actionable message instead of `code: null`, pointing you at
`AUTOMOBILE_EMULATOR_HEADLESS=true`.

## Environment variables

| Variable | Values | Effect |
|----------|--------|--------|
| `AUTOMOBILE_EMULATOR_HEADLESS` | `true` / `false` / unset | Force headless (`-no-window -no-audio`), force windowed, or auto-detect (default). |
| `AUTOMOBILE_EMULATOR_ARGS` | JSON argv array | Extra arguments appended to the `emulator` command (e.g. `["-gpu", "swiftshader_indirect"]`). Each JSON entry is one literal argument; whitespace is never shell-split. |

### Running emulators in CI

On a headless CI runner you can rely on auto-detection (no `DISPLAY`), or set it
explicitly for clarity:

```bash
export AUTOMOBILE_EMULATOR_HEADLESS=true
# optionally, for software rendering on hosts without a GPU:
export AUTOMOBILE_EMULATOR_ARGS='["-gpu", "swiftshader_indirect", "-no-snapshot"]'
```
