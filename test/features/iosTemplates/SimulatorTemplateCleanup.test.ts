import { expect, test } from "bun:test";
import { SimulatorTemplateCleanup } from "../../../src/features/iosTemplates/SimulatorTemplateCleanup";
import { SimulatorTemplatesHarness } from "../../helpers/SimulatorTemplatesHarness";
function rig(held: boolean) {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  fake.manifest!.state = "building";
  let released = false;
  const lock = {
    acquire: async () =>
      held
        ? undefined
        : () => {
            released = true;
          },
    acquireName: async () => (held ? undefined : () => {}),
  };
  return {
    fake,
    cleanup: new SimulatorTemplateCleanup(fake.client, fake.store, lock),
    released: () => released,
  };
}
test("cleanup refuses a building manifest under a live lock", async () => {
  const { cleanup, fake } = rig(true);
  await expect(cleanup.clean({ all: true })).rejects.toThrow("live lock");
  expect(fake.events).toEqual([]);
});
test("forced cleanup deletes and removes manifests", async () => {
  const { cleanup, fake } = rig(true);
  await cleanup.clean({ key: fake.manifest!.key, force: true });
  expect(fake.events).toContain("delete:11111111-1111-1111-1111-111111111111");
  expect(fake.manifest).toBeUndefined();
});
test("key cleanup does not delete other templates", async () => {
  const { cleanup, fake, released } = rig(false);
  await cleanup.clean({ key: fake.manifest!.key });
  expect(fake.events.filter((event) => event.startsWith("delete:"))).toEqual([
    "delete:11111111-1111-1111-1111-111111111111",
  ]);
  expect(released()).toBe(true);
});
test("all cleanup removes orphan templates and preserves ordinary work sims", async () => {
  const { fake, cleanup } = rig(false);
  fake.client.listSimulators = async () => ({
    devices: {
      ios: [
        {
          name: "automobile-template-abcdef12",
          udid: "orphan",
          state: "Shutdown",
          isAvailable: true,
        },
        { name: "AutoMobile-work", udid: "work", state: "Shutdown", isAvailable: true },
      ],
    },
  });
  await cleanup.clean({ all: true });
  expect(fake.events).not.toContain("delete:11111111-1111-1111-1111-111111111111");
  expect(fake.events).toContain("delete:orphan");
  expect(fake.events).not.toContain("delete:work");
});
test("cleanup preserves a user simulator at a manifest UDID with a foreign name", async () => {
  const { fake, cleanup } = rig(false);
  const rows = await fake.client.listSimulators();
  for (const row of Object.values(rows.devices).flat()) {
    row.name = "automobile-template-mine";
  }
  fake.rows = rows;
  await cleanup.clean({ all: true });
  expect(fake.events).toEqual([]);
});
test("cleanup reports all lock refusals and continues cleaning unlocked keys", async () => {
  const { fake } = rig(false);
  if (!fake.manifest) {
    throw new Error("fixture");
  }
  const first = fake.manifest;
  const second = { ...first, key: { ...first.key, deviceType: "tablet" } };
  fake.store.list = async () => [first, second];
  const attempted: string[] = [];
  const cleanup = new SimulatorTemplateCleanup(fake.client, fake.store, {
    acquire: async (key) => {
      attempted.push(key.deviceType);
      return undefined;
    },
    acquireName: async () => undefined,
  });
  await expect(cleanup.clean({ all: true })).rejects.toThrow("live lock");
  expect(attempted).toEqual(["phone", "tablet"]);
});
test("stale cleanup selects recorded host builds that differ from the current catalog", async () => {
  const { fake } = rig(false);
  const cleanup = new SimulatorTemplateCleanup(
    fake.client,
    fake.store,
    {
      acquire: async () => () => {},
      acquireName: async () => () => {},
    },
    async (manifest) => manifest.xcodeBuild !== "X2",
  );
  await cleanup.clean({ stale: true });
  expect(fake.events).toContain("delete:11111111-1111-1111-1111-111111111111");
});
