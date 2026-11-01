import { expect, test } from "bun:test";
import { classifyHostMicrophoneFailure } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/classifyHostMicrophoneFailure";

for (const line of [
  "Failed to create voice virtio-snd-mic0",
  "WARNING | Failed to create voice 'virtio-snd-mic0'",
  "coreaudio: Could not initialize record",
  "coreaudio: Reason: kAudioHardwareIllegalOperationError",
  "coreaudio: Reason: kAudioHardwareIllegalOperation",
  "COREAUDIO: COULD NOT INITIALIZE RECORD",
]) {
  test(`recognizes host mic failure: ${line}`, () => {
    expect(classifyHostMicrophoneFailure(`startup\n${line}\nother output`)).toBe(true);
  });
}

for (const line of [
  "",
  "INFO | boot completed",
  "AudioRecord failed in guest",
  "Failed to create voice virtio-snd-speaker0",
  "Could not initialize playback",
]) {
  test(`does not classify unrelated output: ${line}`, () => {
    expect(classifyHostMicrophoneFailure(line)).toBe(false);
  });
}
