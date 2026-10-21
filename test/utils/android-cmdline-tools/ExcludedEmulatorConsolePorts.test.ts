import { expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { resolveExcludedEmulatorConsolePorts } from "../../../src/utils/android-cmdline-tools/EmulatorPortReservations";

test.each([
  { env: {}, ports: [] },
  { env: { AUTOMOBILE_SESSION_BROKER_CONFIG: "  " }, ports: [] },
  { env: { AUTOMOBILE_SESSION_BROKER_CONFIG: "/private/broker.json" }, ports: [5554] },
  {
    env: {
      AUTOMOBILE_SESSION_BROKER_CONFIG: "/private/broker.json",
      AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS: " \t",
    },
    ports: [],
  },
  { env: { AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS: "" }, ports: [] },
  {
    env: {
      AUTOMOBILE_SESSION_BROKER_CONFIG: "/private/broker.json",
      AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS: "5556, emulator-5558 5560",
    },
    ports: [5556, 5558, 5560],
  },
  { env: { AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS: "5554,5554\n5682\t" }, ports: [5554, 5682] },
])("resolves exclusions from an injected environment: %j", ({ env, ports }) => {
  expect([...resolveExcludedEmulatorConsolePorts(env)]).toEqual([...ports]);
});

test.each([
  "5555",
  "5552",
  "5684",
  "garbage",
  "emulator-5555",
  "emulator-nope",
  "5556.0",
  "0x15b2",
  "5.556e3",
])("rejects invalid excluded console port %s with actionable context", (entry) => {
  const resolve = () =>
    resolveExcludedEmulatorConsolePorts({
      AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS: `5554,${entry}`,
    });
  expect(resolve).toThrow(ActionableError);
  expect(resolve).toThrow("AUTOMOBILE_EMULATOR_EXCLUDED_CONSOLE_PORTS");
  expect(resolve).toThrow(entry);
});
