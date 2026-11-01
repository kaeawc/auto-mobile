import type {
  GuestAudioCapture,
  GuestAudioCaptureOpenOptions,
} from "../../src/features/audio/GuestAudioCapture";

/** A verified capture lease, with no device I/O. */
export class FakeGuestAudioCapture implements GuestAudioCapture {
  opened: string[] = [];
  openOptions: GuestAudioCaptureOpenOptions[] = [];
  closed: string[] = [];
  failure?: Error;
  onOpen?: () => Promise<void>;
  onClose?: () => void;

  async open(
    deviceId: string,
    options: GuestAudioCaptureOpenOptions,
  ): Promise<{ close(): Promise<void> }> {
    this.opened.push(deviceId);
    this.openOptions.push(options);
    if (this.failure) {
      throw this.failure;
    }
    await this.onOpen?.();
    return {
      close: async () => {
        this.closed.push(deviceId);
        this.onClose?.();
      },
    };
  }
}
