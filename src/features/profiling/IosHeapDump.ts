import { ActionableError, toActionableError, type BootedDevice } from "../../models";
import { commandFailureDetails } from "../../utils/CommandError";
import type { HostCommandExecutor } from "../../utils/HostCommandExecutor";
import type { IdGenerator } from "../../utils/IdGenerator";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { logger } from "../../utils/logger";
import { throwIfAborted } from "../../utils/toolUtils";
import type { IosAppPidResolver } from "../performanceTrace/XctraceRecorder";
import { MemgraphNotInspectableError } from "./MemgraphNotInspectableError";
import type { ProfilingArtifactStore } from "./ProfilingArtifactStore";

export interface IosHeapDumpDependencies {
  host: HostCommandExecutor;
  resolvePid: IosAppPidResolver;
  idGenerator: IdGenerator;
  store: ProfilingArtifactStore;
}

interface IosHeapDumpRequest {
  device: BootedDevice;
  appId: string;
  native?: boolean;
  signal?: AbortSignal;
}

interface IosHeapDumpResult {
  path: string;
  sizeBytes: number;
  format: "memgraph";
  pid: number;
}

const DUMP_TIMEOUT_MS = 180_000;

function appNotRunning({ appId, device }: IosHeapDumpRequest, cause?: unknown): ActionableError {
  return new ActionableError(`${appId} is not running on ${device.deviceId}; launch it first.`, {
    cause,
  });
}

function checkLeaksOutput(request: IosHeapDumpRequest, output: string, cause?: unknown): void {
  if (/no longer appears to be running/i.test(output)) {
    throw appNotRunning(request, cause);
  }
  if (/do not have appropriate privileges/i.test(output)) {
    throw new MemgraphNotInspectableError(request.appId, { cause });
  }
  if (/\[fatal\]|cannot examine process .* because/i.test(output)) {
    throw new ActionableError(`Failed to inspect ${request.appId}: ${output.trim()}`, { cause });
  }
}

/** Dump a Simulator app's heap with the macOS `leaks` tool. */
export class IosHeapDump {
  constructor(private readonly deps: IosHeapDumpDependencies) {}

  async dump(request: IosHeapDumpRequest): Promise<IosHeapDumpResult> {
    const { device, appId, native, signal } = request;
    const { idGenerator, resolvePid, store } = this.deps;
    if (resolveIosDeviceKind(device) !== "simulator") {
      throw new ActionableError(
        "heapDump on a physical iPhone is unsupported. Use the Allocations template in Instruments (xctrace) and attach to the running app.",
      );
    }
    if (native) {
      throw new ActionableError("heapDump native=true is only supported on Android.");
    }
    const pid = await resolvePid(device, appId, signal);
    if (pid === undefined) {
      throw appNotRunning(request);
    }
    const path = await store.allocatePath("heapDump", idGenerator.next(), "memgraph");
    try {
      await this.writeGraph(request, pid, path);
      const sizeBytes = await store.sizeOf(path);
      throwIfAborted(signal);
      if (sizeBytes === 0) {
        throw new ActionableError(`No non-empty heap dump was written for ${appId} at ${path}.`);
      }
      return { path, sizeBytes, format: "memgraph", pid };
    } catch (error) {
      await store.remove(path);
      throw toActionableError(error, `Failed to dump the heap of ${appId}`);
    }
  }

  private async writeGraph(request: IosHeapDumpRequest, pid: number, path: string): Promise<void> {
    const { signal } = request;
    throwIfAborted(signal);
    let result;
    try {
      result = await this.deps.host.executeCommand(
        "leaks",
        [String(pid), `--outputGraph=${path}`],
        {
          timeoutMs: DUMP_TIMEOUT_MS,
          signal,
        },
      );
    } catch (error) {
      throwIfAborted(signal);
      const { stdout, stderr, exitCode } = commandFailureDetails(error);
      checkLeaksOutput(request, `${stdout}\n${stderr}`, error);
      if (exitCode !== 1) {
        throw toActionableError(error, `Failed to inspect ${request.appId} with leaks`);
      }
      // Exit 1 reports detected leaks. The caller still verifies that the graph was written.
      logger.debug(`[heapDump] leaks detected in ${request.appId}`, error);
      return;
    }
    checkLeaksOutput(request, `${result.stdout}\n${result.stderr}`);
  }
}
