# Android XR headset: host input interface

The stock Android Emulator takes XR headset hand, eye and head input only over gRPC. No emulator
console (`adb emu`) command and no adb `input` command carries it. This page gives the exact host
interface, so another emulator (for example emu-rs) can accept the same messages and
`xrHeadsetInput` can drive it. The user-facing tool is in
[Android XR emulators](../../../using/android-xr.md#hand-and-eye-input-on-a-headset). The decision
behind it is in the [devlog entry](../../../devlog/2026-11-23-xr-headset-hand-and-eye-input.md).

## Sources

- `emulator_controller.proto`, package `android.emulation.control`. The live copy is in
  `platform/hardware/google/aemu` at `protos/services/emulator-controller/` (branch `emu-main-dev`,
  commit `36815ef3`). Releases up to 35.6 keep it in `platform/external/qemu` at
  `android/android-grpc/services/emulator-controller/proto/`. The XR fields first appear in
  `emu-35-4-release`; `emu-35-3-release` has none.
- `EmulatorService.cpp` (`platform/external/qemu`, `emu-main-dev`, commit `5e512028`) turns each XR
  field into an `xr_service::send*` call.
- `android/android-emu/android/xr/XrService.cpp` and `android/emu/protos/xr_emulator_conn.proto`
  carry those calls to the guest.
- Android Studio's embedded emulator (`platform/tools/adt/idea`,
  `streaming/.../emulator/EmulatorView.kt` and `xr/EmulatorXrInputController.kt`) is the reference
  client.

## RPC

```proto
service EmulatorController {
  rpc streamInputEvent(stream InputEvent) returns (google.protobuf.Empty) {}
}
```

The gRPC path is `/android.emulation.control.EmulatorController/streamInputEvent`. The server runs
XR events asynchronously on its main looper. An emulator that is not configured for XR logs and
drops them without ending the stream, and the RPC has no per-event reply. A client cannot tell from
the RPC whether the guest acted on an event.

## Messages

```proto
message InputEvent {
  oneof type {
    KeyboardEvent key_event = 1;
    TouchEvent touch_event = 2;
    MouseEvent mouse_event = 3;
    AndroidEvent android_event = 4 [deprecated = true];
    PenEvent pen_event = 5;
    WheelEvent wheel_event = 6;
    MouseEvent xr_hand_event = 7;
    MouseEvent xr_eye_event = 8;
    XrCommand xr_command = 9;
    RotationRadian xr_head_rotation_event = 10;
    Translation xr_head_movement_event = 11;
    AngularVelocity xr_head_angular_velocity_event = 12;
    Velocity xr_head_velocity_event = 13;
    TouchpadEvent touchpad_event = 14; // emu-main-dev only
  }
}

message MouseEvent {
  int32 x = 1;       // display pixels, natural (unrotated) frame, 0 = left
  int32 y = 2;       // 0 = top
  int32 buttons = 3; // bit 0 primary, bit 1 secondary, bit 2 middle
  int32 display = 4; // XR AVDs always route to display 0
}

message XrCommand {
  enum Action { RECENTER = 0; }
  Action action = 1;
}

message RotationRadian  { float x = 1; float y = 2; float z = 3; }                   // radians, relative
message Translation     { float delta_x = 1; float delta_y = 2; float delta_z = 3; } // meters, relative
message AngularVelocity { float omega_x = 1; float omega_y = 2; float omega_z = 3; } // rad/s
message Velocity        { float x = 1; float y = 2; float z = 3; }                   // m/s
```

## Hand and eye semantics

`xr_hand_event` and `xr_eye_event` reuse `MouseEvent`. Studio sends every mouse event of a gesture
on one of them, chosen by its toolbar input mode:

| Gesture             | Events                                                                |
| ------------------- | --------------------------------------------------------------------- |
| Aim or hover        | `buttons = 0` at the point                                            |
| Pinch or gaze click | `buttons = 1` at the point, then `buttons = 0` to release             |
| Pinch-drag (hand)   | `buttons = 1` at the start, `buttons = 1` moves, `buttons = 0` at end |

Hand events aim a right-hand ray at the display point; holding bit 0 pinches. Eye events move the
gaze point; bit 0 clicks the focused element. Coordinates are display pixels, not window or panel
space. No field carries hand joints, handedness, gesture type or a gaze ray.

`xrHeadsetInput` sends exactly these sequences. It pauses 50 ms after aiming, holds a select for
`holdMs` (default 100 ms), and splits a drag into 10 held moves over `durationMs` (default 300 ms).
Each call opens one `streamInputEvent` stream, writes its events and half-closes. A final status
other than `OK` is an error.

Studio offers hand and eye mode only when the system image's `advancedFeatures.ini` sets
`XrHandAndEyePointers = on`. The emulator does not check this flag for gRPC events.

## Guest pipe

The emulator forwards each event over the qemud service `xr_service` as a proto2
`xr_emulator_proto.EmulatorRequest`: `xr_hand_event` becomes `MSG_TYPE_SET_HAND_EVENT` (12) with
field 11, `xr_eye_event` becomes `MSG_TYPE_SET_EYE_EVENT` (13) with field 12, and
`RECENTER` becomes `MSG_TYPE_RECENTER_SCREEN` (3). The receiver is in the XR system image.

## Not reachable from the host API

- `MSG_TYPE_SET_INPUT_MODE` (mouse/keyboard, hand raycast, eye tracking) and
  `MSG_TYPE_SET_VIEWPORT_CONTROL` are sent only by the emulator's Qt toolbar.
- `MSG_TYPE_SET_HAND_GESTURE` (left or right pinch, grab, poke) is sent only by Qt toolbar buttons
  that appear with the `-hands-in-space` flag. The emulator docs list only right-hand pinch as
  supported.
- Console commands: none. The console refuses rotation and multi-display on XR devices.

## Emulator support checklist

An emulator that matches the stock interface:

1. Advertises its gRPC port and auth in `avd/running/pid_<pid>.ini` (`grpc.port`, and `grpc.token`
   or `grpc.jwks` with `grpc.jwk_active`), as for audio injection.
2. Serves `EmulatorController/streamInputEvent` and accepts `InputEvent` fields 7 and 8.
3. Treats `buttons` bit 0 on field 7 as a right-hand pinch at display point (`x`, `y`) and on
   field 8 as a gaze click. `buttons = 0` aims, hovers or releases.
4. Ends the stream with status `OK` after the client half-closes.
