import type { WatchRunnerClient, WatchCommand } from "../../src/features/watch/WatchRunnerClient";
import { isWatchHierarchy, type WatchHierarchyNode } from "../../src/features/watch/WatchHierarchy";
import hierarchy from "../fixtures/watchos-xcuitest/hierarchy.json";

export class FakeWatchRunnerClient implements WatchRunnerClient {
  readonly commands: WatchCommand[] = [];
  closed = false;
  failure?: Error;
  readonly tree: WatchHierarchyNode;
  constructor(tree: unknown = hierarchy) {
    if (!isWatchHierarchy(tree)) {
      throw new Error("Invalid captured watch fixture");
    }
    this.tree = tree;
  }
  async request(command: WatchCommand, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    this.commands.push(command);
    if (this.failure) {
      throw this.failure;
    }
    return command.type === "hierarchy" ? this.tree : undefined;
  }
  async hierarchy(signal?: AbortSignal): Promise<WatchHierarchyNode> {
    await this.request({ type: "hierarchy" }, signal);
    return this.tree;
  }
  close(): void {
    this.closed = true;
  }
}
