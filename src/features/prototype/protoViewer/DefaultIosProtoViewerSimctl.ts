import type { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import {
  resolveOwnAppDataContainer,
  SimulatorContainerUnresolvedError,
} from "../../../utils/ios-cmdline-tools/simulatorOwnContainer";
import { logger } from "../../../utils/logger";
import { PROTOVIEWER_PACKAGE } from "./protoViewerContract";
import type { IosProtoViewerSimctl } from "./IosProtoViewer";
export class DefaultIosProtoViewerSimctl implements IosProtoViewerSimctl {
  constructor(
    private readonly client: Pick<SimCtlClient, "listAppsOrThrow" | "executeCommandArgs">,
  ) {}
  async installed(udid: string, signal?: AbortSignal): Promise<boolean> {
    return (await this.client.listAppsOrThrow(udid, { signal })).some(
      (app) => app.bundleId === PROTOVIEWER_PACKAGE,
    );
  }
  async dataContainer(udid: string, signal?: AbortSignal): Promise<string> {
    try {
      return await resolveOwnAppDataContainer({
        deviceId: udid,
        bundleId: PROTOVIEWER_PACKAGE,
        run: (args) => this.client.executeCommandArgs(args, undefined, signal),
      });
    } catch (error) {
      if (error instanceof SimulatorContainerUnresolvedError) {
        logger.debug("ProtoViewer data container unresolved");
        return "";
      }
      throw error;
    }
  }
  async launch(udid: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.client.executeCommandArgs(["launch", udid, PROTOVIEWER_PACKAGE], timeoutMs, signal);
  }
  async openurl(args: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<void> {
    await this.client.executeCommandArgs([...args], timeoutMs, signal);
  }
}
