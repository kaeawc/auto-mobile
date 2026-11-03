import type { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import {
  resolveOwnAppDataContainer,
  SimulatorContainerUnresolvedError,
} from "../../../utils/ios-cmdline-tools/simulatorOwnContainer";
import { logger } from "../../../utils/logger";
import {
  PROTOVIEWER_PACKAGE,
  preferredProtoViewerPackage,
  type ProtoViewerPackage,
} from "./protoViewerContract";
import type { IosProtoViewerSimctl } from "./IosProtoViewer";
export class DefaultIosProtoViewerSimctl implements IosProtoViewerSimctl {
  /** The build (store or `.dev`) `installed` found on each simulator. */
  private readonly bundleIds = new Map<string, ProtoViewerPackage>();

  constructor(
    private readonly client: Pick<SimCtlClient, "listAppsOrThrow" | "executeCommandArgs">,
  ) {}
  async installed(udid: string, signal?: AbortSignal): Promise<boolean> {
    const apps = await this.client.listAppsOrThrow(udid, { signal });
    const bundleId = preferredProtoViewerPackage((id) => apps.some((app) => app.bundleId === id));
    if (bundleId === undefined) {
      this.bundleIds.delete(udid);
      return false;
    }
    this.bundleIds.set(udid, bundleId);
    return true;
  }
  async dataContainer(udid: string, signal?: AbortSignal): Promise<string> {
    try {
      return await resolveOwnAppDataContainer({
        deviceId: udid,
        bundleId: this.bundleId(udid),
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
    await this.client.executeCommandArgs(["launch", udid, this.bundleId(udid)], timeoutMs, signal);
  }
  /** Callers check `installed` first; before that, the store ID is the only safe guess. */
  private bundleId(udid: string): ProtoViewerPackage {
    return this.bundleIds.get(udid) ?? PROTOVIEWER_PACKAGE;
  }
}
