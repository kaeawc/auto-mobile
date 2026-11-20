import type {
  GuestAudioCapture,
  GuestAudioCaptureHandle,
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
  /** Recorder rechecks made immediately before a stream opens. */
  runningChecks: string[] = [];
  /** When set, the recorder is gone by the time the stream would open. */
  stoppedBeforeStream?: Error;

  async open(
    deviceId: string,
    options: GuestAudioCaptureOpenOptions,
  ): Promise<GuestAudioCaptureHandle> {
    this.opened.push(deviceId);
    this.openOptions.push(options);
    if (this.failure) {
      throw this.failure;
    }
    await this.onOpen?.();
    return {
      assertRunning: async () => {
        this.runningChecks.push(deviceId);
        if (this.stoppedBeforeStream) {
          throw this.stoppedBeforeStream;
        }
      },
      close: async () => {
        this.closed.push(deviceId);
        this.onClose?.();
      },
    };
  }
}
