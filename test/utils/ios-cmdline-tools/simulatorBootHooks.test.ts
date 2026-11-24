import { expect, test } from "bun:test";
import { DefaultSimulatorBootHooks } from "../../../src/utils/ios-cmdline-tools/simulatorBootHooks";

test("every listener hears a boot, a failing one does not stop the others, and unsubscribe works", async () => {
  const hooks = new DefaultSimulatorBootHooks();
  const heard: string[] = [];
  hooks.onBooted(async () => {
    throw new Error("launchctl refused");
  });
  const stop = hooks.onBooted((udid) => void heard.push(udid));
  expect(() => hooks.notifyBooted("SIM-1")).not.toThrow();
  await Promise.resolve();
  stop();
  hooks.notifyBooted("SIM-2");
  await Promise.resolve();
  expect(heard).toEqual(["SIM-1"]);
});
