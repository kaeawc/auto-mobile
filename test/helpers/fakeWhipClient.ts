import type { WhipSession, WhipSignalingClient } from "../../src/features/webrtc/WhipClient";

/** Test fakes may omit `etag` from a published session; the publisher treats it as absent. */
type LooseWhipSession = Omit<WhipSession, "etag"> & { etag?: WhipSession["etag"] };

type FakeWhipOverrides = Omit<Partial<WhipSignalingClient>, "publish"> & {
  publish?: (offerSdp: string, signal?: AbortSignal) => Promise<LooseWhipSession>;
};

/**
 * Build a {@link WhipSignalingClient} from the operations a test cares about.
 * Operations left out throw a TypeError when called, like the absent methods of
 * the partial objects this replaces.
 */
export function fakeWhipClient(overrides: FakeWhipOverrides = {}): WhipSignalingClient {
  const notStubbed = (name: string) => (): never => {
    throw new TypeError(`fakeWhipClient.${name} is not stubbed`);
  };
  return {
    publish: notStubbed("publish"),
    patchCandidate: notStubbed("patchCandidate"),
    delete: notStubbed("delete"),
    ...overrides,
  } as WhipSignalingClient;
}
