import { expect, test } from "bun:test";
import { AndroidImeCatalog } from "../../../src/features/action/AndroidImeCatalog";
import { withAndroidImeLock } from "../../../src/features/action/androidImeLock";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";

const gboard =
  "com.google.android.inputmethod.latin/com.google.android.apps.inputmethod.latin.LatinIME";
const samsung = "com.samsung.android.honeyboard/.service.HoneyBoardService";

function fixture() {
  const adb = new FakeAdbExecutor();
  adb.setCommandResponse("shell ime list -a -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n`, stderr: "" });
  adb.setCommandResponse("shell settings get secure default_input_method", {
    stdout: `${gboard}\n`,
    stderr: "",
  });
  return { adb, catalog: new AndroidImeCatalog(adb, "test-device") };
}

test("lists actual installed IMEs separately from enabled and active state", async () => {
  const { catalog } = fixture();
  expect(await catalog.list()).toEqual({
    activeImeId: gboard,
    installed: [
      { id: gboard, enabled: true, active: true },
      { id: samsung, enabled: false, active: false },
    ],
  });
});

test("select rejects an unknown or disabled IME before running ime set", async () => {
  const { adb, catalog } = fixture();
  await expect(catalog.select("com.example/.Injected;echo bad")).rejects.toThrow("not installed");
  await expect(catalog.select(samsung)).rejects.toThrow("installed but disabled");
  expect(adb.getExecutedCommands().some((command) => command.startsWith("shell ime set"))).toBe(
    false,
  );
});

test("select uses component argv and verifies the resulting active IME", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  adb.setCommandResponseSequence("shell settings get secure default_input_method", [
    { stdout: gboard, stderr: "" },
    { stdout: samsung, stderr: "" },
  ]);
  expect((await catalog.select(samsung)).activeImeId).toBe(samsung);
  expect(adb.getExecutedArgv()).toContainEqual(["shell", "ime", "set", samsung]);
  expect(
    adb.getCommandCalls().find((call) => call.command === `shell ime set ${samsung}`)
      ?.waitForProcessSettlementAfterAbort,
  ).toBe(true);
});

test("select reports a failed postcondition instead of claiming readiness", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell ime list -s", { stdout: `${gboard}\n${samsung}\n`, stderr: "" });
  await expect(catalog.select(samsung)).rejects.toThrow("did not take effect");
});

test("rejects malformed list output before it can become a selectable component", async () => {
  const { adb, catalog } = fixture();
  adb.setCommandResponse("shell ime list -a -s", {
    stdout: "Error: service not ready",
    stderr: "",
  });
  await expect(catalog.list()).rejects.toThrow("invalid IME component list");
});

test("selection waits for another IME operation on the same device", async () => {
  const { adb, catalog } = fixture();
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  const inFlight = withAndroidImeLock("test-device", () => hold);
  const selection = catalog.select(gboard);
  await Promise.resolve();
  expect(adb.getExecutedArgv()).toEqual([]);
  release();
  await inFlight;
  expect((await selection).activeImeId).toBe(gboard);
});
