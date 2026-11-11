# iOS Simulator camera poster

The iOS Simulator has no camera. AutoMobile injects a still-image capture pipeline into
simulator app processes for `startDevice cameraPosterPath` / `cameraPosterQr` and
`setDeviceState cameraPoster`. Source: `ios/CameraPosterInjection/`.

## Approach

The library is activated by launching the app with
`SIMCTL_CHILD_DYLD_INSERT_LIBRARIES=<libAMCameraPoster.dylib>` and one of `SIMCTL_CHILD_AM_CAMERA_POSTER_PATH=<png|jpeg>` / `SIMCTL_CHILD_AM_CAMERA_POSTER_QR=<text>`.
The path wins when both are set; an unreadable path disables the injection rather than falling
back. With neither variable the library does nothing. No app change or SDK is needed.
AutoMobile generates QR PNGs through the shared QR writer and always supplies
`SIMCTL_CHILD_AM_CAMERA_POSTER_PATH`; QR text remains in the registry for reporting.
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
or booting the simulator, including already-running simulators. `setDeviceState` validates host
PNG/JPG/JPEG files and records or clears the poster. Whitespace is allowed; `surface` is echoed
and ignored. State is write-only and lasts until cleared or daemon restart, independently of app
and session lifetime.

`setDeviceState` returns `supported: true`, `method: "ios_simulator_dyld_injection"`, the path
when set, and `relaunchRequired: true`. It never relaunches an app automatically. Every running
app must be relaunched to change its process environment. `launchApp` with a registered poster
forces a cold launch and returns `cameraPosterApplied: true`; after clearing, use
`launchApp coldBoot: true` to remove injection from a running app. Existing DYLD entries and
`prototype: true` injection compose: both libraries remain in the colon-separated list and the
prototype port/token environment is preserved. Without a registered poster, launch is unchanged.

Physical iOS devices return a typed unsupported result from `setDeviceState` and an
`ActionableError` from `startDevice`; tvOS, watchOS and visionOS poster starts are refused.
The camera is injected into simulator app processes, not device hardware.

## Dylib resolution

`IosCameraPosterDylibProvider` first checks `AUTOMOBILE_IOS_CAMERA_POSTER_DYLIB`. An explicit
missing path fails instead of falling back. Otherwise it locates the committed Objective-C source
relative to the module's package/repository root or daemon launch directory, or uses
`AUTOMOBILE_IOS_CAMERA_POSTER_SOURCE`. Relative overrides resolve against the daemon launch
directory. Published npm packages omit `ios/`, so use a repository checkout or either override.

The source bytes' SHA-256 determines
`<AutoMobile data dir>/ios-camera-poster/<hash12>/libAMCameraPoster.dylib`. An existing file is
reused; otherwise an injected host command runner invokes `xcrun --sdk iphonesimulator clang`
with arm64, ARC, simulator minimum 17.0 and the frameworks from `build.sh`, then ad-hoc signs
with `codesign -f -s -`. Each build writes a uniquely named partial and renames it atomically
only after signing. `SingleFlight` coalesces concurrent builds within the default provider;
separate processes can build private partials safely. No clock, sleep or device commands are needed.

Missing Xcode/xcrun errors explain installation and the prebuilt override. Missing source errors
explain the npm limitation and overrides. Compile/sign errors include bounded, trimmed command
stderr. Preparation failures stop `launchApp` with an `ActionableError` before app launch;
a registered poster is never silently dropped. Invalid extensions and missing images are typed
state failures and leave the prior record intact.

## Limits

- The built library targets arm64 iOS Simulator 17.0 and later.

- Takes effect only at launch; hardened or system apps that strip `DYLD_INSERT_LIBRARIES` are out.
- Process-wide swizzles; apps that subclass capture classes or use private camera paths may bypass it.
- Not implemented: `UIImagePickerController` presentation and capture, `AVCaptureStillImageOutput`,
  device formats, capture connection topology, camera controls, depth. Metadata geometry is synthetic.
- `VisionKit` `DataScannerViewController` reports `isSupported == false` on the simulator and is
  not changed.
- Relies on private layer state initialisation of `AVCaptureVideoPreviewLayer`; re-verify per Xcode.

## Fallback

`xcrun simctl addmedia` plus `putAppFile media_library` cover photo-picker (PHPicker) flows. They do
not cover live preview, `AVCapturePhotoOutput` or QR scanning. For apps that link the AutoMobile
SDK, a debug-only frame source is the next candidate when injection is unavailable.
