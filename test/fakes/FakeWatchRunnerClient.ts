import type { WatchRunnerClient, WatchCommand } from "../../src/features/watch/WatchRunnerClient";
import { isWatchHierarchy, type WatchHierarchy } from "../../src/features/watch/WatchHierarchy";
import hierarchy from "../fixtures/watchos-xcuitest/sdk-hierarchy-live.json";

export class FakeWatchRunnerClient implements WatchRunnerClient {
  readonly commands: WatchCommand[] = [];
  readonly requestOptions: Parameters<WatchRunnerClient["request"]>[2][] = [];
  closed = false;
  failure?: Error;
  readonly tree: WatchHierarchy;
  constructor(tree: unknown = hierarchy) {
    if (!isWatchHierarchy(tree)) {
      throw new Error("Invalid captured watch fixture");
    }
    this.tree = tree;
  }
  isUsable(): boolean {
    return !this.closed && !this.failure;
  }
  async request(
    command: WatchCommand,
    signal?: AbortSignal,
    options?: Parameters<WatchRunnerClient["request"]>[2],
  ): Promise<unknown> {
    signal?.throwIfAborted();
    this.commands.push(command);
    this.requestOptions.push(options);
    if (this.failure) {
      throw this.failure;
    }
    return command.type === "hierarchy" ? this.tree : undefined;
  }
  async hierarchy(signal?: AbortSignal): Promise<WatchHierarchy> {
    await this.request({ type: "hierarchy" }, signal);
    return this.tree;
  }
  close(): void {
    this.closed = true;
  }
}
