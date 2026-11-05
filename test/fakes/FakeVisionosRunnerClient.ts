import type {
  VisionosRunnerClient,
  VisionosCommand,
} from "../../src/features/visionos/VisionosRunnerClient";
import type { VisionosHierarchy } from "../../src/features/visionos/VisionosHierarchy";
import capture from "../fixtures/visionos-xcuitest/probe-capture.json";

/** Project the verbatim probe's flat snapshots into the runner's existing hierarchy wire model. */
export function visionosProbeHierarchy(snapshots = capture.snapshotBefore): VisionosHierarchy {
  const nodes = snapshots.map((node) => ({
    className: String(node.type),
    "resource-id": node.id,
    text: node.label,
    bounds: {
      left: node.frame[0],
      top: node.frame[1],
      right: node.frame[0] + node.frame[2],
      bottom: node.frame[1] + node.frame[3],
    },
    enabled: String(node.enabled),
    focused: String(node.hasFocus),
  }));
  return {
    hierarchy: { ...nodes[0], node: nodes.slice(1) },
    updatedAt: 1,
    packageName: snapshots[0].id,
    screenWidth: capture.windowFrame[2],
    screenHeight: capture.windowFrame[3],
  };
}

export class FakeVisionosRunnerClient implements VisionosRunnerClient {
  readonly commands: VisionosCommand[] = [];
  closed = false;
  failure?: Error;
  constructor(readonly tree = visionosProbeHierarchy()) {}
  isUsable(): boolean {
    return !this.closed && !this.failure;
  }
  async request(command: VisionosCommand, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    this.commands.push(command);
    if (this.failure) {
      throw this.failure;
    }
    return command.type === "request_hierarchy" ? this.tree : undefined;
  }
  async hierarchy(signal?: AbortSignal): Promise<VisionosHierarchy> {
    await this.request({ type: "request_hierarchy" }, signal);
    return this.tree;
  }
  close(): void {
    this.closed = true;
  }
}
