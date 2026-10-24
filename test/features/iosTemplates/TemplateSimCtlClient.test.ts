import { getAbortSignal } from "../../../src/utils/AbortContext";
import { expect, test } from "bun:test";
import { TemplateSimCtlClient } from "../../../src/features/iosTemplates/TemplateSimCtlClient";
import { SimulatorTemplatesHarness } from "../../helpers/SimulatorTemplatesHarness";
test("template deletion verifies absence after using ordinary deletion", async () => {
  const fake = new SimulatorTemplatesHarness();
  let present = true;
  const client = new TemplateSimCtlClient({
    ...fake.client,
    listSimulators: async () => (present ? fake.client.listSimulators() : { devices: {} }),
    deleteSimulator: async (udid) => {
      fake.events.push(`delete:${udid}`);
      present = false;
    },
    bootSimulator: async () => {
      throw new Error("unused");
    },
    shutdownSimulator: async () => {},
  });
  await client.deleteSimulator("11111111-1111-1111-1111-111111111111");
  expect(fake.events).toEqual(["delete:11111111-1111-1111-1111-111111111111"]);
  await client.deleteSimulator("11111111-1111-1111-1111-111111111111");
  expect(fake.events).toHaveLength(1);
});
test("template delete does not report success when sim remains", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.client.deleteSimulator = async () => {};
  const client = new TemplateSimCtlClient({
    ...fake.client,
    bootSimulator: async () => {
      throw new Error("unused");
    },
    shutdownSimulator: async () => {},
  });
  await expect(client.deleteSimulator("11111111-1111-1111-1111-111111111111")).rejects.toThrow(
    "still exists",
  );
});
test("template boot uses coordinated SimCtlClient boot with the explicit signal", async () => {
  const fake = new SimulatorTemplatesHarness();
  const signal = new AbortController().signal;
  const client = new TemplateSimCtlClient({
    ...fake.client,
    shutdownSimulator: async () => {},
    bootSimulator: async (udid) => {
      expect(udid).toBe("template");
      expect(getAbortSignal()).toBe(signal);
      throw new Error("coordinated boot reached");
    },
  });
  await expect(client.boot("template", signal)).rejects.toThrow("coordinated boot reached");
});
