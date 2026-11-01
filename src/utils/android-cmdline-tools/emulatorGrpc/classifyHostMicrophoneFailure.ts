/** Known host microphone voice failures, distinct from guest AudioRecord failures. */
export function classifyHostMicrophoneFailure(text: string): boolean {
  return /Failed to create voice\s+['"]?virtio-snd-mic0\b|Could not initialize record\b|kAudioHardwareIllegalOperation/i.test(
    text,
  );
}
