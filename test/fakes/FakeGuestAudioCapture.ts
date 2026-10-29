import type { GuestAudioCapture } from "../../src/features/audio/GuestAudioCapture";

/** A verified capture lease, with no device I/O. */
export class FakeGuestAudioCapture implements GuestAudioCapture {
  opened: string[] = [];
  closed: string[] = [];
  failure?: Error;
  onOpen?: () => Promise<void>;
  onClose?: () => void;

  async open(deviceId: string): Promise<{ close(): Promise<void> }> {
    this.opened.push(deviceId);
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
