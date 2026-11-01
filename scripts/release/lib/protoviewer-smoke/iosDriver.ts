import { DefaultIosProtoViewerSimctl } from "../../../../src/features/prototype/protoViewer/DefaultIosProtoViewerSimctl";
import { IosProtoViewer } from "../../../../src/features/prototype/protoViewer/IosProtoViewer";
import { NodeIosProtoViewerFiles } from "../../../../src/features/prototype/protoViewer/NodeIosProtoViewerFiles";
import { PROTOVIEWER_PACKAGE } from "../../../../src/features/prototype/protoViewer/protoViewerContract";
import { SimCtlClient } from "../../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { defaultIdGenerator } from "../../../../src/utils/IdGenerator";
import { defaultTimer } from "../../../../src/utils/SystemTimer";
import { logger } from "../../../../src/utils/logger";
import type { ToolRunner } from "../artifact-policy/toolRunner";
import type { SmokeDriver } from "./flows";

/**
 * Install, version and data identity come from simctl; import and open go through the app's URL
 * and inbox path. There is no UI driver here, so the screen checks report as skipped.
 */
export function createIosDriver(udid: string, runner: ToolRunner): SmokeDriver {
  const simctl = async (args: readonly string[]): Promise<string> =>
    (await runner.run("xcrun", ["simctl", ...args])).stdout.trim();
  return {
    platform: "ios",
    async install(artifact) {
      // simctl install over an existing app keeps its data container.
      await simctl(["install", udid, artifact]);
    },
    async prepareForUrlOpen() {
      try {
        await simctl(["terminate", udid, PROTOVIEWER_PACKAGE]);
      } catch (error) {
        if (error instanceof Error && "code" in error && error.code === 3) {
          // ESRCH means ProtoViewer is already not running: the requested start state.
          logger.debug("ProtoViewer was already not running before the smoke URL check", error);
          return;
        }
        throw error;
      }
    },
    async installedApp() {
      const app = await simctl(["get_app_container", udid, PROTOVIEWER_PACKAGE, "app"]);
      const data = await simctl(["get_app_container", udid, PROTOVIEWER_PACKAGE, "data"]);
      const version = (
        await runner.run("plutil", [
          "-extract",
          "CFBundleVersion",
          "raw",
          "-o",
          "-",
          `${app}/Info.plist`,
        ])
      ).stdout.trim();
      return { version, dataIdentity: data };
    },
    viewer: new IosProtoViewer({
      deviceId: udid,
      simctl: new DefaultIosProtoViewerSimctl(new SimCtlClient()),
      files: new NodeIosProtoViewerFiles(),
      timer: defaultTimer,
      ids: defaultIdGenerator,
    }),
  };
}

/** Explicit display selection uses the same simctl client as the product. */
export function createDuoScreens(udid: string): import("./duoFlow").DuoScreens {
  const client = new SimCtlClient();
  return {
    enumerate: () => client.enumerateDisplays(udid),
    screenshot: (display) => client.screenshot(udid, display),
  };
}

export function createPostureSetter(
  command: string,
  runner: ToolRunner,
): import("./duoFlow").PostureSetter {
  return {
    async set(posture) {
      await runner.run(command, [posture]);
    },
  };
}
