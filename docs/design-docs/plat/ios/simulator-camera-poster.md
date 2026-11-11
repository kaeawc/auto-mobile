# iOS Simulator camera poster

The iOS Simulator has no camera. A proof-of-concept injection library supplies a simulator app
with a fake capture pipeline fed from a still image or a generated QR code. It is the planned
parity target for Android's `cameraPosterPath` / `cameraPosterQr` / `setDeviceState cameraPoster`
(#6844, #10784). Tracking issue: #17982. Source: `ios/CameraPosterInjection/`.

## Approach

The library is activated by launching the app with
`SIMCTL_CHILD_DYLD_INSERT_LIBRARIES=<libAMCameraPoster.dylib>` and one of `SIMCTL_CHILD_AM_CAMERA_POSTER_PATH=<png|jpeg>` / `SIMCTL_CHILD_AM_CAMERA_POSTER_QR=<text>`.
The path wins when both are set; an unreadable path disables the injection rather than falling
back. With neither variable the library does nothing. No app change or SDK is needed.
`ios/CameraPosterInjection/build.sh` builds the library and a fixture app; today the variables
are set by hand (`xcrun simctl launch`). `launchApp` does not add them yet.

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

## Planned tool surface

Not wired yet: `startDevice`, `setDeviceState` and `launchApp` do not accept or apply a camera
poster on iOS today. The plan is the same surface as Android: `startDevice cameraPosterPath` /
`cameraPosterQr` and `setDeviceState cameraPoster`. On iOS Simulator the values would be stored on
the session and applied at the next `launchApp` (environment is fixed at process start, so changing
the poster would need an app relaunch; Android changes it live). Physical iOS devices and a launch
that did not pass the injection would return a typed unsupported error.

## Limits

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
