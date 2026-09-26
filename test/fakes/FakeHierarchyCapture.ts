import type { ViewHierarchyResult } from "../../src/models";
import type {
  HierarchyCapture,
  HierarchyCaptureRequest,
  HierarchySnapshot,
} from "../../src/features/observe/HierarchyCapture";
import { SearchableHierarchy } from "../../src/features/utility/SearchableNode";

export class FakeHierarchyCapture implements HierarchyCapture {
  readonly requests: HierarchyCaptureRequest[] = [];
  private readonly searchable = new SearchableHierarchy();
  constructor(
    private readonly read: () => ViewHierarchyResult | Promise<ViewHierarchyResult>,
    private readonly platform: "android" | "ios" = "android",
  ) {}
  async capture(request: HierarchyCaptureRequest): Promise<HierarchySnapshot> {
    this.requests.push(request);
    const hierarchy = await this.read();
    return {
      captureId: `fake-${this.requests.length}`,
      hierarchy,
      nodes: this.searchable.project(hierarchy),
      platform: this.platform,
      receivedAt: 0,
      requestedFreshness: request.freshness,
    };
  }
}
