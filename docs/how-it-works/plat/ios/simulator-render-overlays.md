# iOS Simulator render overlays

`displayConfig` `renderOverlays` toggles the Core Animation debug overlays that Simulator.app's
Debug menu offers (#19016). No `simctl` subcommand reaches them, so AutoMobile calls CoreSimulator's
private `SimDevice` API. The decision is in the
[devlog entry](../../../devlog/2026-11-23-simulator-render-overlays-osascript.md).

## Bridge

`OsascriptSimulatorRenderOverlayControl` (`src/utils/ios-cmdline-tools/SimulatorRenderOverlays.ts`)
runs one `osascript -l JavaScript` process per read or write. The script:

1. loads `/Library/Developer/PrivateFrameworks/CoreSimulator.framework`;
2. gets `+[SimServiceContext sharedServiceContextForDeveloperDir:error:]` for `DEVELOPER_DIR`
   (an `Xcode.app` value resolves to `Xcode.app/Contents/Developer`), or
   `/var/db/xcode_select_link` when it is unset, then `defaultDeviceSetWithError:` and
   `devicesByUDID`;
3. reads every mapped option with `-[SimDevice getCADebugOption:]`, applies the requested
   `-[SimDevice setCADebugOption:enabled:]` writes, and reads every option again;
4. prints `{ previous, applied }` keyed by option id.

A write to a Simulator that is not booted fails with an `ActionableError` (a read works on any
state). A missing class, device or selector throws inside the script, and the TypeScript side wraps the
non-zero exit in an `ActionableError`. A CoreSimulator crash ends only that `osascript` process.

| Overlay               | Option id | Effect seen on Settings (iOS 27.2)                          |
| --------------------- | --------- | ----------------------------------------------------------- |
| `flashUpdatedRegions` | 0         | Whole screen tinted yellow on redraw                        |
| `copiedImages`        | 1         | Copied images (Settings icons) tinted cyan                  |
| `blendedLayers`       | 2         | Opaque layers green, blended layers red                     |
| `offscreenRendered`   | 17        | Off-screen rendered layers (blur materials) yellow          |
| `cacheHits`           | 19        | No change on Settings; affects rasterized layers only       |
| `misalignedImages`    | 20        | Scaled images yellow; the issue saw misaligned ones magenta |

Other ids from 0 to 24 showed no visible change on iOS 26.5 and are not exposed. The options are
per boot: a Simulator shutdown turns them all off.

## `displayConfig` contract

- A read on a Simulator adds `current.renderOverlays` (every overlay). If the bridge fails, the
  read fails with the bridge error.
- A write sends only the named overlays and reports `previous` and `applied` for every overlay. An
  overlay that does not read back as requested makes the call fail with the read-back state.
- `reset` (and `reset: "factory"`) reads the overlays after the other fields reset and writes them
  all off only when one is on. A bridge failure during a reset is logged and does not fail it.
- Android and physical iOS refuse `renderOverlays` before any command.

## Session cleanup

Release restores each overlay a session touched to the value it had before the session; it does
not force overlays off. An overlay that was already on when the session started is on again after
release, the same restore-prior contract as every other `displayConfig` setting.

On a Simulator, each named overlay journals a `device-setting` row keyed `renderOverlay:<name>`,
and reset journals all six only when one of them is on. Android and physical iOS journal no overlay row. The prior is the
boolean the bridge read before the call. The iOS keep-booted reset writes that prior back through
the same bridge, all rows of the device in one call, and fails the revert when the overlay does not read back restored. An unreadable
prior leaves the row unobservable, so the reset falls back to erase (see
[journal cleaning](../../session-broker-device-mutation-journal-cleaning.md)); the reboot leaves
every overlay off.
