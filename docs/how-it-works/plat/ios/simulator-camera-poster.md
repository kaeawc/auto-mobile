# iOS Simulator camera poster

The iOS Simulator has no camera. AutoMobile injects a still-image capture pipeline into
simulator app processes for `startDevice cameraPosterPath` / `cameraPosterQr` and
`setDeviceState cameraPoster`. Source: `ios/CameraPosterInjection/`.

## Approach

The library is activated by launching the app with
`SIMCTL_CHILD_DYLD_INSERT_LIBRARIES=<libAMCameraPoster.dylib>` and one of `SIMCTL_CHILD_AM_CAMERA_POSTER_PATH=<png|jpeg>` / `SIMCTL_CHILD_AM_CAMERA_POSTER_QR=<text>`.
The path wins when both are set; an unreadable path disables the injection rather than falling
back. With neither variable the library does nothing. No app change or SDK is needed.
For an image poster AutoMobile supplies `SIMCTL_CHILD_AM_CAMERA_POSTER_PATH`. For a QR poster it supplies
`SIMCTL_CHILD_AM_CAMERA_POSTER_QR` with the text: the library renders the code on a white portrait canvas
with a quiet zone, whereas a host PNG is aspect-filled and its edges (the quiet zone) are cropped.
`ios/CameraPosterInjection/build.sh` also builds a fixture app for direct validation.

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
by simulator UDID, with an in-memory process-wide default. `startDevice` records after selecting
or booting the simulator, including already-running simulators, and only after the readiness
reservation's ownership check, so a request rejected for another client's simulator cannot
overwrite that client's poster. `setDeviceState` validates host
PNG/JPG/JPEG files and records or clears the poster. Whitespace is allowed; `surface` is echoed
and ignored. Both run the dylib provider's `ensure()` before recording, so a missing compiler,
source or override fails the call that sets the poster and leaves the previous record intact;
`clear` never builds. A record lasts until cleared, the simulator's `killDevice` completes
(post-shutdown cleanup clears the UDID), its session is released or unbinds it (a
`setActiveDevice` rebind; `registerIosCameraPosterSessionCleanup` on the session manager, plus
`SessionReleaseBroadcaster` with a device snapshot; upgrade-only re-announcements are ignored
because the device may already belong to the next owner), the daemon removes the device, or the
daemon restarts. A session that
reuses the simulator therefore never inherits an earlier session's poster.

`setDeviceState` returns `supported: true`, `method: "ios_simulator_dyld_injection"`, the path
when set, and `relaunchRequired: true`. It never relaunches an app automatically. Every running
app must be relaunched to change its process environment. `launchApp` with a registered poster
forces a cold launch and returns `cameraPosterApplied: true`; after clearing, use
`launchApp coldBoot: true` to remove injection from a running app. Existing DYLD entries and
`prototype: true` injection compose: both libraries remain in the colon-separated list and the
prototype port/token environment is preserved. Without a registered poster, launch is unchanged.
Like `prototype: true`, injection skips `com.apple.*` bundles (SpringBoard and system apps cannot
be injected): the launch is unchanged and reports `cameraPosterApplied: false` rather than
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
(package.json `files`, required by `scripts/build/packed-runtime-assets.ts`), so an installed
package finds it from `<package>/dist/src/` by walking ancestors, with no override.

The source (about 30 KB) is built on demand rather than shipped as a prebuilt release asset;
`AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB` serves users who supply their own build.

The source bytes' SHA-256 determines
`<AutoMobile data dir>/ios-camera-poster/<hash12>-sim-universal/libAMCameraPoster.dylib`; the
flavor suffix keeps an older single-slice build from being reused. An existing file is
reused; otherwise an injected host command runner invokes `xcrun --sdk iphonesimulator clang`
with `-arch arm64 -arch x86_64` (a universal binary, so Intel hosts and Rosetta-run Node on Apple
silicon both match the simulator, where `process.arch` alone could name the wrong slice), ARC,
simulator minimum 17.0 and the frameworks from `build.sh`, then ad-hoc signs
with `codesign -f -s -`. Each build writes a uniquely named partial and renames it atomically
only after signing. `SingleFlight` coalesces concurrent builds within the default provider;
separate processes can build private partials safely. No clock, sleep or device commands are needed.

Missing Xcode/xcrun errors explain installation and the prebuilt override. Missing source errors
name the expected packaged path and the overrides. Compile/sign errors include bounded, trimmed command
stderr. Preparation failures stop `launchApp` with an `ActionableError` before app launch;
a registered poster is never silently dropped. Invalid extensions and missing images are typed
state failures and leave the prior record intact.

## Limits

- The built library targets arm64 and x86_64 iOS Simulator 17.0 and later.
- Takes effect only at launch; hardened or system apps that strip `DYLD_INSERT_LIBRARIES` are out.
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
