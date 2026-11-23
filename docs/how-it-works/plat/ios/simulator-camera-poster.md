# iOS Simulator camera poster

The iOS Simulator has no camera. AutoMobile injects a still-image capture pipeline into
simulator app processes for `startDevice cameraPosterPath` / `cameraPosterQr` and
`setDeviceState cameraPoster`. Source: `ios/CameraPosterInjection/`.

## Approach

AutoMobile activates the library by launching the app with
`SIMCTL_CHILD_DYLD_INSERT_LIBRARIES=<libAMCameraPoster.dylib>` and one of `SIMCTL_CHILD_AM_CAMERA_POSTER_PATH=<png|jpeg>` / `SIMCTL_CHILD_AM_CAMERA_POSTER_QR=<text>`.
The path wins when both are set; an unreadable path disables the injection rather than falling
back. With neither variable the library does nothing. The app needs no change and no SDK.
For an image poster AutoMobile supplies `SIMCTL_CHILD_AM_CAMERA_POSTER_PATH`. For a QR poster it supplies
`SIMCTL_CHILD_AM_CAMERA_POSTER_QR` with the text. The library renders the code on a white portrait
canvas with a quiet zone, whereas a host PNG is aspect-filled and loses its edges (the quiet zone)
to cropping. The `ios/CameraPosterInjection/build.sh` script also builds a fixture app for direct
validation.

## Device-wide activation

Setting a poster also turns it on for apps that `launchApp` does not start: the home screen,
XCUITest and system relaunches. `IosCameraPosterDeviceWide` runs `simctl spawn <udid> launchctl
setenv` for three variables. Every process launchd starts afterwards inherits them:

- `AM_CAMERA_POSTER_DYLIB`: the poster library.
- `AM_CAMERA_POSTER_CONFIG`: `<AutoMobile data dir>/ios-camera-poster/devices/<udid>.json`.
- `DYLD_INSERT_LIBRARIES`: the gate library, merged into any value `launchctl getenv` shows. It
  is set last, so no process loads the gate before it can find the poster library.

launchd inserts a stable copy of the gate,
`<AutoMobile data dir>/ios-camera-poster-active/libAMCameraPosterGate.dylib`, not the build cache
entry, so no cache cleanup removes a library launchd names. On an iOS 27.2 simulator a missing
inserted library does not stop a launch: dyld skips it.

The gate (`CameraPosterGate.c`) links only libSystem because every new process loads it. It loads
the poster library only into a process that meets three conditions. Its executable is a
user-installed app or extension, under the device's `data/Containers/Bundle/Application/`.
It has AVFoundation loaded. It has a poster source: the per-launch variables, or a readable
config file. System apps and daemons under the runtime root, SpringBoard included, never load
the poster.

The config file holds `{"path": …}` for an image or `{"qr": …}` for a QR. The poster library
reads it when the process starts if neither per-launch variable is set. The registry mirrors
each record into this file (`DeviceConfigMirroringIosCameraPosterRegistry`): a set writes it
atomically, and every clear removes it at once. A new poster therefore reaches the next launch
of each app without another launchd change.

### Undo

Each activation is recorded in `ios-camera-poster-active/devices/<udid>.json`
(`IosCameraPosterActivationStore`): the gate path and the `DYLD_INSERT_LIBRARIES` value before
activation. Every clear path (`setDeviceState` clear, `killDevice`, session release or rebind) goes
through the registry, which then calls `deactivate`. It removes only the gate entry from
`DYLD_INSERT_LIBRARIES`, keeping any other inserted library, or unsets the variable when nothing
else is left. It then unsets both poster variables and drops the record. `setDeviceState` clear
waits for this; the other paths finish it in the background. Daemon startup removes the
`devices` config directory and undoes every recorded activation, because the previous daemon's
posters died with its registry.

### Boots

A boot resets the launchd environment. After every boot AutoMobile verifies (`SimCtlBoot`
notifies `simulatorBootHooks`), the daemon re-activates a poster the registry still holds, or
undoes a stale record.

A simulator booted with `SIMCTL_CHILD_DYLD_INSERT_LIBRARIES` holds that value in launchd_sim's
own environment. `launchctl getenv` does not show it, and launchd keeps it over a later
`launchctl setenv` (verified on iOS 27.2). Activation reads it with `ps -E` on launchd_sim
(`SimulatorBootEnvironment`). When it names any library other than the gate, activation fails.

`setDeviceState` and `startDevice` report `deviceWide: true` when activation succeeded. A
failure is logged, the poster stays recorded for `launchApp`, and the result carries
`deviceWide: false` with a warning that only `launchApp` applies it, and why. A failed
re-activation after a boot is logged. A caller that injects its own dylib provider (a test fake)
gets activation only by also injecting an activator.

## Injected camera

The library swizzles the public AVFoundation surface:

- `AVCaptureDevice` and `AVCaptureDeviceDiscoverySession` list one back wide-angle video device;
  authorization reports authorized.
- `AVCaptureDeviceInput`, `AVCaptureSession` (add/remove inputs and outputs, start/stop, preset)
  accept the fake device and run a ~15 fps frame timer.
- `AVCaptureVideoPreviewLayer` shows the poster as layer contents while the session runs.
- `AVCaptureVideoDataOutput` delivers BGRA sample buffers of the poster.
- `AVCaptureMetadataOutput` decodes the poster with `CIDetector` and reports a QR
  `AVMetadataMachineReadableCodeObject` about every 500 ms.
- `AVCapturePhotoOutput` returns an `AVCapturePhoto` whose data is the poster as PNG
  (1080x1440 portrait canvas, aspect-fill).
- `UIImagePickerController` source availability.

Fake objects are runtime subclasses made with `class_createInstance` (the real initializers are
unavailable without hardware). Their `dealloc` is a no-op, so they leak; objects are few.

## Tool lifecycle

An injected `IosCameraPosterRegistry` stores image paths or QR text plus generated PNG paths
by simulator UDID, with an in-memory process-wide default. The `startDevice` tool records after selecting
or booting the simulator, including already-running simulators. It records only after the readiness
reservation's ownership check, so a request rejected for another client's simulator cannot
overwrite that client's poster. The `setDeviceState` tool validates host
PNG/JPG/JPEG files and records or clears the poster. Whitespace is allowed; `surface` is echoed
and ignored. Both run the dylib provider's `ensure()` before recording, so a missing compiler,
source or override fails the call that sets the poster and leaves the previous record intact;
`clear` never builds.

A record lasts until one of these happens:

- it is cleared;
- the simulator's `killDevice` completes (post-shutdown cleanup clears the UDID);
- its session is released or unbinds it (a `setActiveDevice` rebind). The session manager runs
  `registerIosCameraPosterSessionCleanup`, plus `SessionReleaseBroadcaster` with a device
  snapshot. Cleanup ignores upgrade-only re-announcements because the device may already belong to
  the next owner;
- the daemon removes the device, or the daemon restarts.

A session that reuses the simulator therefore never inherits an earlier session's poster.

`setDeviceState` returns `supported: true`, `method: "ios_simulator_dyld_injection"`, the path
and `deviceWide` when set, and `relaunchRequired: true`. It never relaunches an app automatically. A running app
takes a new process environment only on relaunch. With a registered poster, `launchApp`
forces a cold launch and returns `cameraPosterApplied: true`; after clearing, use
`launchApp coldBoot: true` to remove injection from a running app. Existing DYLD entries and
`prototype: true` injection compose: both libraries remain in the colon-separated list and the
prototype port/token environment survives. Without a registered poster, launch is unchanged.

Like `prototype: true`, injection skips `com.apple.*` bundles, because SpringBoard and system apps
cannot take injection. The launch is unchanged and reports `cameraPosterApplied: false` rather than
failing, so system apps such as Settings stay launchable while a poster is set.

Physical iOS devices return a typed unsupported result from `setDeviceState` and an
`ActionableError` from `startDevice`; tvOS, watchOS and visionOS poster starts are refused.
The camera is injected into simulator app processes, not device hardware.

## Dylib resolution

`IosCameraPosterDylibProvider` first checks `AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB`. An explicit
missing path fails instead of falling back. Otherwise it locates the committed Objective-C source
relative to the module's package/repository root or daemon launch directory, or uses
`AUTOMOBILE_IOS_CAMERA_POSTER_SOURCE`. Relative overrides resolve against the daemon launch
directory. The npm package ships `ios/CameraPosterInjection/Injection/CameraPosterInjection.m`
and `CameraPosterGate.c` beside it
(package.json `files`, required by `scripts/build/packed-runtime-assets.ts`), so an installed
package finds it from `<package>/dist/src/` by walking ancestors, with no override.

The source (about 30 KB) is built on demand rather than shipped as a prebuilt release asset;
`AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB` serves users who supply their own build.

The same provider class builds the gate from `CameraPosterGate.c` (`iosCameraPosterGateProvider`,
`-dynamiclib` only, into `libAMCameraPosterGate.dylib`); the two `AUTOMOBILE_IOS_CAMERA_POSTER_*`
overrides apply only to the poster library.

The source bytes' SHA-256 determines
`<AutoMobile data dir>/ios-camera-poster/<hash12>-sim-universal/libAMCameraPoster.dylib`; the
flavor suffix keeps an older single-slice build from being reused. The provider reuses an existing
file. Otherwise an injected host command runner invokes `xcrun --sdk iphonesimulator clang`
with `-arch arm64 -arch x86_64`, ARC, simulator minimum 17.0 and the frameworks from `build.sh`,
then ad-hoc signs with `codesign -f -s -`. The universal binary lets Intel hosts and Rosetta-run
Node on Apple silicon both match the simulator, where `process.arch` alone could name the wrong
slice. Each build writes a uniquely named partial and renames it atomically
only after signing. `SingleFlight` coalesces concurrent builds within the default provider;
separate processes can build private partials safely. The build needs no clock, sleep or device commands.

Missing Xcode/xcrun errors explain installation and the prebuilt override. Missing source errors
name the expected packaged path and the overrides. Compile/sign errors include bounded, trimmed command
stderr. Preparation failures stop `launchApp` with an `ActionableError` before app launch;
a registered poster is never silently dropped. Invalid extensions and missing images are typed
state failures and leave the prior record intact.

## Limits

- The built library targets arm64 and x86_64 iOS Simulator 17.0 and later.
- Takes effect only at launch; hardened or system apps that strip `DYLD_INSERT_LIBRARIES` are out.
- Device-wide activation reaches processes launchd starts after `launchctl setenv`. Research
  (#19047) reports that ExtensionKit processes do not inherit `launchctl setenv`; only a boot
  environment reaches them. An app that loads AVFoundation with `dlopen` after launch is not gated
  in.
- Process-wide swizzles; apps that subclass capture classes or use private camera paths may bypass it.
- Not implemented: `UIImagePickerController` presentation and capture, `AVCaptureStillImageOutput`,
  device formats, capture connection topology, camera controls, depth. Metadata geometry is synthetic.
- `VisionKit` `DataScannerViewController` reports `isSupported == false` on the simulator and is
  not changed.
- Relies on private layer state initialisation of `AVCaptureVideoPreviewLayer`; re-verify per Xcode.

## Fallback

`xcrun simctl addmedia` plus `putAppFile media_library` cover photo-picker (PHPicker) flows. They do
not cover live preview, `AVCapturePhotoOutput` or QR scanning.

## Background

- [Build the camera poster dylib on demand](../../../devlog/2026-11-11-simulator-camera-poster-on-demand-build.md)
- [Device-wide camera poster through the launchd environment](../../../devlog/2026-11-23-simulator-camera-poster-device-wide.md)
