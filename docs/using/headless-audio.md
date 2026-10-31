# Headless host audio setup

Audio tests need the host set up for them: a CI Mac usually has no microphone, and a Linux host
often runs the emulator with audio off. This page covers what each platform needs, how to check
it, and the known limits. The audio tools themselves are described in
[Emulator and simulator audio](emulator-audio.md).

## Check what a device can do

Each device in `listDevices` carries a `capabilityInventory`. Its audio entries say whether audio
works on that device and, when it does not, why:

| Entry                                  | Available when                                                                      |
| -------------------------------------- | ----------------------------------------------------------------------------------- |
| `ios.simulator.audioInput`             | The Mac has a default input device.                                                 |
| `ios.simulator.audioOutput`            | The Mac has a default output device.                                                |
| `ios.simulator.audioOutputCapture`     | The Mac's default output is a loopback device, so its signal can be read back.      |
| `android.emulator.audioInput`          | The AVD has `hw.audioInput=yes` and the emulator is not launched with `-no-audio`.  |
| `android.emulator.audioOutput`         | The AVD has `hw.audioOutput=yes` and the emulator is not launched with `-no-audio`. |
| `android.emulator.audioInputInjection` | The emulator's gRPC endpoint is reachable.                                          |
| `android.emulator.audioOutputCapture`  | The emulator's gRPC endpoint is reachable.                                          |

The two Android gRPC entries appear only when a probe result is supplied. They are `available`
when reachable, `unavailable` when unreachable, and `unsupported` when no emulator gRPC port is
configured. Non-available entries include a reason. `-no-audio` does not affect these two entries.

When a device cannot record, observations and `setAppPermissions` report `audio_input_unavailable`:
recordings on that device will contain no audio, and retrying will not change that.

## macOS (iOS Simulator)

A simulator records from the Mac's default input device and plays to its default output device.
A Mac with no input device gives every simulator a silent microphone.

### Install a loopback device

A loopback device plays back into itself: audio sent to its output side can be read from its
input side. BlackHole is one such driver.

1. Stop running tests on the host first: installing a driver restarts the audio system.
2. Install the driver, for example `brew install blackhole-2ch`. It goes into
   `/Library/Audio/Plug-Ins/HAL`.
3. Restart the audio system with `sudo killall coreaudiod`, or reboot.
4. Check that the device is listed: `system_profiler SPAudioDataType`.

### Set the default devices

Set the defaults as the user that runs AutoMobile, without a GUI, with `SwitchAudioSource`
(`brew install switchaudio-osx`):

```bash
SwitchAudioSource -t input -s "BlackHole 2ch"
```

```bash
SwitchAudioSource -t output -s "BlackHole 2ch"
```

```bash
SwitchAudioSource -c -t input
```

The last command prints the current default input. `system_profiler SPAudioDataType` also marks
each default with `Default Input Device: Yes` or `Default Output Device: Yes`.

One loopback device as both default input and output lets a test check a round trip, but a
simulator's own playback then also reaches its microphone. To inject and capture independently,
use two loopback devices: one as the default input and one as the default output.

### Microphone permission

- The simulator's microphone permission for an app (`setAppPermissions` with `microphone`) is
  separate from the Mac's own Microphone permission.
- On a desktop Mac the Simulator asks once for Mac microphone access. A headless host has no one to
  answer that prompt.
- An MDM privacy (PPPC) profile can deny Microphone access but cannot grant it in advance.
- `captureAudio` on a simulator reads the loopback device's input side, which needs Microphone
  permission for the process that runs AutoMobile.

### Simulator audio tools

`injectAudioInput` and `captureAudio` on a simulator also need the audio-loopback helper: set
`AUTOMOBILE_IOS_AUDIO_LOOPBACK_HELPER` to its path. The loopback devices are shared by every
simulator on the Mac, so run audio tests on one simulator at a time.

## Linux (Android emulator)

`injectAudioInput` and `captureAudio` stream audio through each emulator's own gRPC audio API.
They need no sound server, microphone or speaker on the host, and they work the same in a
container.

- `-no-audio` (`AUTOMOBILE_EMULATOR_AUDIO=false`) does not prevent gRPC injection or capture.
- Keep `hw.audioInput=yes` and `hw.audioOutput=yes` in the AVD's `config.ini`.
- Run the emulator on the same host as AutoMobile, so its gRPC endpoint can be found.

## Troubleshooting

| Symptom                                                                 | Cause and fix                                                                                                        |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `audio_input_unavailable` in an observation                             | The device has no audio input: on a Mac, no default input device; on an emulator, `-no-audio` or `hw.audioInput=no`. |
| `audio_injection_unsupported` on a simulator                            | The Mac's default input is not a loopback device, or no helper is configured. Follow the macOS steps above.          |
| `audio_capture_unsupported` on a simulator                              | The Mac's default output is not a loopback device. Make a loopback device the default output.                        |
| `audio_injection_unsupported` or `audio_capture_unsupported` on Android | The emulator is not local or does not advertise gRPC audio. Use a recent emulator on the same host.                  |
| `audio_injection_busy`                                                  | Another injection holds the microphone; on a Mac, any simulator's injection. Stop it with `stopAudioInput`.          |
| `audio_loopback_failed`                                                 | The Mac's audio system refused the device, often for lack of Microphone permission. The message carries the detail.  |
| `captureAudio` returns `silent: true` while the app plays sound         | On a Mac, the default output is not the device being read back; on an emulator, check `hw.audioOutput`.              |
