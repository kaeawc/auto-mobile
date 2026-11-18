import type { PrototypeAgentSocket } from "../../src/features/prototype/ios/prototypeAgentClient";
import type { AdbExecutor } from "../../src/utils/android-cmdline-tools/interfaces/AdbExecutor";
import { FakeAdbExecutor } from "./FakeAdbExecutor";
import { FakePrototypeAgentSocket } from "./FakePrototypeAgentSocket";

/** A deterministic endpoint that flushes replay in the hello reply's socket chunk. */
export class FakeDisposableAppSocket
  extends FakePrototypeAgentSocket
  implements PrototypeAgentSocket
{
  capabilities = [
    "get_prototype_status",
    "patch_prototype",
    "prototype_patch_v1",
    "prototype_inspect_v1",
    "prototype_persistence_replay_v1",
  ];
  replay: Record<string, unknown>[] = [];
  override write(data: string): void {
    super.write(data);
    const frame = JSON.parse(data) as Record<string, unknown>;
    if (frame.type === "hello") {
      this.pushRaw(
        [
          JSON.stringify({
            type: "hello_result",
            success: true,
            agentVersion: "app",
            protocolVersion: 1,
            capabilities: this.capabilities,
          }),
          ...this.replay.map((event) => JSON.stringify(event)),
        ].join("\n") + "\n",
      );
    }
  }
}

export class FakeDisposableAppAdb extends FakeAdbExecutor implements AdbExecutor {
  portOutput = "12345\n";
  override async execute(args: string[], options?: Parameters<FakeAdbExecutor["execute"]>[1]) {
    const result = super.execute(args, options);
    await result;
    return this.createExecResult(args.includes("tcp:0") ? this.portOutput : "", "");
  }
}
