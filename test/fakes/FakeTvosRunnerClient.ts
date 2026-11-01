import type { TvosRunnerClient, TvosCommand } from "../../src/features/tvos/TvosRunnerClient";
import { isTvosHierarchy, type TvosHierarchy } from "../../src/features/tvos/TvosHierarchy";
import capture from "../fixtures/tvos-xcuitest/tvos-runner-hierarchy-focus-b01.json";

export class FakeTvosRunnerClient implements TvosRunnerClient {
  readonly commands: TvosCommand[] = [];
  readonly requestOptions: Parameters<TvosRunnerClient["request"]>[2][] = [];
  closed = false;
  screenshotData?: string;
  failure?: Error;
  readonly tree: TvosHierarchy;
  constructor(tree: unknown = capture.data) {
    if (!isTvosHierarchy(tree)) {
      throw new Error("Invalid captured tvos fixture");
    }
    this.tree = tree;
  }
  async request(
    command: TvosCommand,
    signal?: AbortSignal,
    options?: Parameters<TvosRunnerClient["request"]>[2],
  ): Promise<unknown> {
    signal?.throwIfAborted();
    this.commands.push(command);
    this.requestOptions.push(options);
    if (this.failure) {
      throw this.failure;
    }
    return command.type === "request_hierarchy"
      ? this.tree
      : command.type === "request_screenshot"
        ? this.screenshotData
        : undefined;
  }
  async hierarchy(signal?: AbortSignal): Promise<TvosHierarchy> {
    await this.request({ type: "request_hierarchy" }, signal);
    return this.tree;
  }
  close(): void {
    this.closed = true;
  }
}
