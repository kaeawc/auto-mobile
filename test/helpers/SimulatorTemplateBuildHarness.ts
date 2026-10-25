import type { TemplateBuildDependencies } from "../../src/features/iosTemplates/SimulatorTemplateBuilder";
import type { SimulatorTemplateManifest } from "../../src/features/iosTemplates/SimulatorTemplateManifestStore";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import { SimulatorTemplatesHarness } from "./SimulatorTemplatesHarness";
import { FakeTimer } from "../fakes/FakeTimer";
export class SimulatorTemplateBuildHarness {
  events: string[] = [];
  manifest?: SimulatorTemplateManifest;
  locked = false;
  refuse = false;
  settleFails = false;
  afterCreate = () => {};
  present = false;
  name = "";
  dependencies(): TemplateBuildDependencies {
    const client = new SimulatorTemplatesHarness().client;
    return {
      timer: new FakeTimer(),
      xcode: { readBuild: async () => "X1" },
      lock: {
        acquire: async () => {
          this.events.push("lock");
          return this.locked
            ? undefined
            : () => {
                this.events.push("release");
              };
        },
        acquireName: async () => undefined,
      },
      store: {
        read: async () => this.manifest,
        write: async (manifest) => {
          this.manifest = { ...manifest };
          this.events.push(manifest.state);
        },
        remove: async () => {},
        list: async () => [],
      },
      client: {
        ...client,
        createSimulator: async (name) => {
          this.name = name;
          this.present = true;
          this.events.push("create");
          this.afterCreate();
          return "11111111-1111-1111-1111-111111111111";
        },
        deleteSimulator: async () => {
          this.present = false;
          this.events.push("delete");
        },
        boot: async () => {
          this.events.push("boot");
        },
        shutdownSimulator: async () => {
          this.events.push("shutdown");
        },
        listSimulators: async () => {
          this.events.push("verify");
          const list = await client.listSimulators();
          if (!this.present) {
            return { devices: {} };
          }
          for (const row of Object.values(list.devices).flat()) {
            row.name = this.name;
          }
          return list;
        },
      },
      profile: () => ({
        apply: async () => {
          this.events.push("apply");
          return { applied: true, resources: [], labels: [] };
        },
      }),
      instrumentation: {
        run: async (request, boot) => {
          this.events.push(`admit:${request.reason}`);
          if (this.refuse) {
            throw new BootCapacityExhaustedError(
              { platform: "ios", retryAfterMs: 60_000, limit: 1, booted: 1 },
              "full",
            );
          }
          return boot(request.timeoutMs);
        },
      },
      settle: {
        waitUntilSettled: async () => {
          this.events.push("settle");
          if (this.settleFails) {
            throw new Error("settle timeout");
          }
        },
      },
    };
  }
}
