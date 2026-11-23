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

/** A tap changes the screen, so the effect poll settles on its first read instead of waiting out its budget. */
export class FakeScreenChangingAfterTapWatchRunner
  extends FakeWatchRunnerClient
  implements WatchRunnerClient
{
  private taps = 0;
  override async request(...args: Parameters<FakeWatchRunnerClient["request"]>): Promise<unknown> {
    if (args[0].type === "tap") {
      this.taps++;
    }
    return super.request(...args);
  }
  override async hierarchy(signal?: AbortSignal) {
    const tree = await super.hierarchy(signal);
    return { ...tree, root: { ...tree.root, accessibilityLabel: `after ${this.taps} taps` } };
  }
}

/**
 * Replays captured hierarchies in order, repeating the last, and after a tap answers every
 * hierarchy read with `afterTap` (a tree, or an error such as `app_not_foreground`).
 */
export class FakeSequencedWatchRunner extends FakeWatchRunnerClient implements WatchRunnerClient {
  private reads = 0;
  private tapped = false;
  private readonly trees: WatchHierarchy[];
  constructor(
    trees: readonly unknown[],
    private readonly afterTap?: unknown,
  ) {
    super(trees[0]);
    this.trees = trees.map((tree) => {
      if (!isWatchHierarchy(tree)) {
        throw new Error("Invalid captured watch fixture");
      }
      return tree;
    });
  }
  override async request(...args: Parameters<FakeWatchRunnerClient["request"]>): Promise<unknown> {
    if (args[0].type === "tap") {
      this.tapped = true;
    }
    return super.request(...args);
  }
  override async hierarchy(signal?: AbortSignal): Promise<WatchHierarchy> {
    await super.hierarchy(signal);
    if (this.tapped && this.afterTap !== undefined) {
      if (this.afterTap instanceof Error) {
        throw this.afterTap;
      }
      if (!isWatchHierarchy(this.afterTap)) {
        throw new Error("Invalid captured watch fixture");
      }
      return this.afterTap;
    }
    return this.trees[Math.min(this.reads++, this.trees.length - 1)]!;
  }
}
