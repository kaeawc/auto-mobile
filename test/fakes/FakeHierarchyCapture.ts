import type { ViewHierarchyResult } from "../../src/models";
import {
  DefaultHierarchyCapture,
  type HierarchyCapture,
  type HierarchyCaptureReader,
  type HierarchyCaptureRequest,
  type HierarchySnapshot,
} from "../../src/features/observe/HierarchyCapture";
import { CountingIdGenerator, type IdGenerator } from "../../src/utils/IdGenerator";
import type { Timer } from "../../src/utils/SystemTimer";
import { FakeTimer } from "./FakeTimer";

/**
 * Scripted HierarchyCapture: the device read is the injected `read`, and every capture rule
 * (abort, device-reported errors, the minTimestamp floor, one snapshot identity per source object,
 * provenance for getHierarchySnapshot) is DefaultHierarchyCapture's own, over a reader that serves
 * `read` for every freshness. Pinned by test/contracts/hierarchyCapture.test.ts.
 */
export class FakeHierarchyCapture implements HierarchyCapture {
  readonly requests: HierarchyCaptureRequest[] = [];
  private readonly delegate: DefaultHierarchyCapture;
  constructor(
    read: () => ViewHierarchyResult | Promise<ViewHierarchyResult>,
    platform: "android" | "ios" = "android",
    timer: Timer = new FakeTimer(),
    ids: IdGenerator = new CountingIdGenerator("fake"),
  ) {
    const reader: HierarchyCaptureReader = {
      readCached: async () => await read(),
      readFresh: async () => await read(),
      readSettled: async () => await read(),
      projectVisible: (hierarchy) => ({ ...hierarchy }),
    };
    this.delegate = new DefaultHierarchyCapture(platform, reader, timer, ids);
  }

  async capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot> {
    this.requests.push(request);
    return await this.delegate.capture(request);
  }
}
