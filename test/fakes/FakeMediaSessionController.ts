import type {
  MediaSessionController,
  MediaSessionDispatchResult,
  MediaSessionWaitResult,
  MediaVolumeResult,
} from "../../src/features/media/MediaSessionController";
import type { MediaSessionDump } from "../../src/features/media/MediaSessionTypes";

const EMPTY_DUMP: MediaSessionDump = { sessions: [], mediaButtonSession: null };

/** Records each request and answers with the configured result. */
export class FakeMediaSessionController implements MediaSessionController {
  readonly calls: Array<{ method: keyof MediaSessionController; request: unknown }> = [];
  dump: MediaSessionDump = EMPTY_DUMP;
  waitResult: Omit<MediaSessionWaitResult, "mediaState"> = {
    matched: true,
    waitMs: 0,
    polls: 1,
    dump: EMPTY_DUMP,
  };
  dispatchResult: Omit<MediaSessionDispatchResult, "key"> = {
    handledBy: null,
    stateChanged: false,
    dump: EMPTY_DUMP,
  };
  volumeResult: MediaVolumeResult | null = null;

  async getSessions(request: Parameters<MediaSessionController["getSessions"]>[0]) {
    this.calls.push({ method: "getSessions", request });
    return this.dump;
  }

  async waitForState(request: Parameters<MediaSessionController["waitForState"]>[0]) {
    this.calls.push({ method: "waitForState", request });
    return { ...this.waitResult, mediaState: request.mediaState };
  }

  async dispatch(request: Parameters<MediaSessionController["dispatch"]>[0]) {
    this.calls.push({ method: "dispatch", request });
    return { ...this.dispatchResult, key: request.key };
  }

  async setVolume(request: Parameters<MediaSessionController["setVolume"]>[0]) {
    this.calls.push({ method: "setVolume", request });
    if (!this.volumeResult) {
      throw new Error("FakeMediaSessionController.volumeResult is not configured");
    }
    return this.volumeResult;
  }
}
