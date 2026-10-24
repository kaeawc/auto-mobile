import {
  templateName,
  templateKeyHash,
} from "../../src/utils/ios-cmdline-tools/SimulatorTemplateKey";
import type { TemplateCreationDependencies } from "../../src/features/iosTemplates/SimulatorCreationService";
import { SimulatorCreationService } from "../../src/features/iosTemplates/SimulatorCreationService";
import type { SimulatorTemplateManifest } from "../../src/features/iosTemplates/SimulatorTemplateManifestStore";
import type {
  SimulatorList,
  AppleDeviceRuntime,
} from "../../src/utils/ios-cmdline-tools/SimCtlSupport";
import { FakeTimer } from "../fakes/FakeTimer";
export class SimulatorTemplatesHarness {
  events: string[] = [];
  builds = 0;
  xcode = "X1";
  cloneFails = false;
  manifest?: SimulatorTemplateManifest;
  request = { name: "work", deviceType: "phone", runtime: "ios" };
  timer = new FakeTimer();
  rows?: SimulatorList;
  deleted = new Set<string>();
  finishBuild = () => {};
  client: TemplateCreationDependencies["client"] = {
    createSimulator: async (name) => {
      this.events.push(`create:${name}`);
      return "created";
    },
    cloneSimulator: async (udid, name) => {
      this.events.push(`clone:${udid}:${name}`);
      if (this.cloneFails) {
        throw new Error("vanished");
      }
      return "cloned";
    },
    listSimulators: async (): Promise<SimulatorList> =>
      this.rows ?? {
        devices: {
          ios: this.deleted.has("11111111-1111-1111-1111-111111111111")
            ? []
            : [
                {
                  udid: "11111111-1111-1111-1111-111111111111",
                  name: templateName({
                    runtime: "ios",
                    runtimeBuild: "R1",
                    xcodeBuild: "X1",
                    deviceType: "phone",
                    profile: "none",
                  }),
                  state: "Shutdown",
                  isAvailable: true,
                },
              ],
        },
      },
    getCatalogChecked: async () => ({
      deviceTypes: [],
      runtimes: [
        {
          bundlePath: "",
          runtimeRoot: "",
          identifier: "ios",
          buildversion: "R1",
          name: "iOS",
          version: "27",
          isAvailable: true,
        },
      ] satisfies AppleDeviceRuntime[],
    }),
    deleteSimulator: async (udid) => {
      this.events.push(`delete:${udid}`);
      this.deleted.add(udid);
    },
  };
  store: TemplateCreationDependencies["store"] = {
    read: async (key) =>
      this.manifest && templateKeyHash(key) === templateKeyHash(this.manifest.key)
        ? this.manifest
        : undefined,
    write: async (value) => {
      this.manifest = value;
    },
    remove: async () => {
      this.manifest = undefined;
    },
    list: async () => (this.manifest ? [this.manifest] : []),
  };
  ready(): void {
    this.manifest = {
      key: {
        runtime: "ios",
        runtimeBuild: "R1",
        xcodeBuild: "X1",
        deviceType: "phone",
        profile: "none",
      },
      udid: "11111111-1111-1111-1111-111111111111",
      state: "ready",
      xcodeBuild: "X1",
      runtimeBuild: "R1",
      builtAtMs: 0,
    };
  }
  service(): SimulatorCreationService {
    return new SimulatorCreationService(
      this.client,
      () => true,
      () => ({
        client: this.client,
        store: this.store,
        lock: {
          acquire: async () => () => {},
          acquireName: async () => () => {},
        },
        timer: this.timer,
        profile: () => "none",
        xcode: { readBuild: async () => this.xcode },
        builder: {
          build: async () => {
            this.builds++;
            await new Promise<void>((resolve) => {
              this.finishBuild = resolve;
            });
          },
        },
      }),
    );
  }
}
