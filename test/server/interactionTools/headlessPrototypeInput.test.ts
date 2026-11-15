import { describe, expect, test } from "bun:test";
import type { PrototypeEvent } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { VirtualPrototypeDevice } from "../../../src/features/prototype/headless/VirtualPrototypeDevice";
import { VirtualPrototypeInputs } from "../../../src/features/prototype/headless/VirtualPrototypeInputs";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import {
  headlessSendKeysHandler,
  headlessTapOnHandler,
  isHeadlessInput,
} from "../../../src/server/interactionTools/headlessPrototypeInput";
import type { SendKeysArgs, TapOnArgs } from "../../../src/server/interactionToolTypes";
import { FakeTimer } from "../../fakes/FakeTimer";

async function harness() {
  const device = new VirtualPrototypeDevice(new FakeTimer());
  const events: PrototypeEvent[] = [];
  device.onPrototypeEvent((event) => events.push(event));
  await device.requestShowPrototype(
    prototypeSpecSchema.parse({
      id: "form",
      window: { placement: { type: "fullscreen" } },
      state: { email: "" },
      root: {
        type: "column",
        children: [
          { type: "textField", id: "email", label: "Email", stateKey: "email" },
          { type: "button", label: "Send", onTap: [{ type: "emit", name: "sent" }] },
        ],
      },
    }),
  );
  const inputs = new VirtualPrototypeInputs(device);
  return { events, deps: { virtualPrototypeInputs: () => inputs } };
}

const tapOn = (selector: TapOnArgs["selector"], extra: Partial<TapOnArgs> = {}): TapOnArgs => ({
  selector,
  ...extra,
});

describe("headless tapOn and sendKeys (#18360)", () => {
  test("headless mode follows AUTOMOBILE_HEADLESS", () => {
    expect(isHeadlessInput({ env: { AUTOMOBILE_HEADLESS: "1" } })).toBe(true);
    expect(isHeadlessInput({ env: {} })).toBe(false);
  });

  test("tapOn reports the raised events and marks the result virtual", async () => {
    const { deps, events } = await harness();
    const response = await headlessTapOnHandler(tapOn({ text: "Send" }), deps);
    expect(response.structuredContent).toMatchObject({
      success: true,
      prototypeId: "form",
      events: [{ kind: "emit", name: "sent", sequence: 1 }],
      virtualDevice: { deviceId: "automobile-virtual-prototype", renderer: "web" },
    });
    expect(events.map((event) => event.name)).toEqual(["sent"]);
  });

  test("tapOn tries textAny variants in order", async () => {
    const { deps } = await harness();
    const response = await headlessTapOnHandler(tapOn({ textAny: ["Submit", "Send"] }), deps);
    expect(response.structuredContent).toMatchObject({ target: { type: "button" } });
  });

  test("tapOn refuses device-only options and unmatched selectors with actionable errors", async () => {
    const { deps } = await harness();
    await expect(
      headlessTapOnHandler(tapOn({ text: "Send" }, { sibling: true }), deps),
    ).rejects.toThrow("does not support tapOn sibling");
    await expect(
      headlessTapOnHandler(tapOn({ text: "Send" }, { action: "longPress" }), deps),
    ).rejects.toThrow("tapOn action longPress");
    await expect(headlessTapOnHandler(tapOn({ text: "Nope" }), deps)).rejects.toThrow(
      "No visible prototype node matches",
    );
    await expect(
      headlessTapOnHandler(tapOn({ text: "Send" }), { virtualPrototypeInputs: () => undefined }),
    ).rejects.toThrow("call prototype show first");
  });

  test("sendKeys focuses its selector, then types and clears", async () => {
    const { deps, events } = await harness();
    const args = {
      selector: { text: "Email" },
      commands: [
        { action: "type", text: "a@b.c", operation: "insert", mode: "auto" },
        { action: "clear" },
      ],
    } as SendKeysArgs;
    const response = await headlessSendKeysHandler(args, deps);
    expect(response.structuredContent).toMatchObject({ success: true, focusedKey: "email" });
    expect(events.map((event) => event.payload)).toEqual([
      { key: "email", value: "a@b.c" },
      { key: "email", value: "" },
    ]);
  });

  test("sendKeys refuses key commands and typing with no focused field", async () => {
    const { deps } = await harness();
    const unfocused = {
      commands: [{ action: "type", text: "x", operation: "insert", mode: "auto" }],
    } as SendKeysArgs;
    await expect(headlessSendKeysHandler(unfocused, deps)).rejects.toThrow(
      "No text field has focus",
    );
    const focusedKey = {
      selector: { text: "Email" },
      commands: [{ action: "key", key: "enter" }],
    } as SendKeysArgs;
    await expect(headlessSendKeysHandler(focusedKey, deps)).rejects.toThrow(
      "does not support sendKeys key commands",
    );
  });

  test("tapOn treats a positive duration as the longPress it means on a device", async () => {
    const { deps, events } = await harness();
    await expect(
      headlessTapOnHandler(tapOn({ text: "Send" }, { duration: 500 }), deps),
    ).rejects.toThrow("tapOn action longPress");
    await expect(
      headlessTapOnHandler(tapOn({ text: "Send" }, { action: "tap", duration: 500 }), deps),
    ).rejects.toThrow("duration applies only to longPress");
    expect(events).toEqual([]);
  });

  test("sendKeys refuses unique selection rather than typing into the first match", async () => {
    const { deps, events } = await harness();
    const args = {
      selector: { text: "Email" },
      selectionStrategy: "unique",
      commands: [{ action: "type", text: "x", operation: "insert", mode: "auto" }],
    } as SendKeysArgs;
    await expect(headlessSendKeysHandler(args, deps)).rejects.toThrow(
      "does not support sendKeys selectionStrategy unique",
    );
    expect(events).toEqual([]);
  });

  test("a sendKeys selector naming a button is refused without tapping it", async () => {
    const { deps, events } = await harness();
    const focus = {
      selector: { text: "Email" },
      commands: [{ action: "clear" }],
    } as SendKeysArgs;
    await headlessSendKeysHandler(focus, deps);
    const button = {
      selector: { text: "Send" },
      commands: [{ action: "type", text: "x", operation: "insert", mode: "auto" }],
    } as SendKeysArgs;
    await expect(headlessSendKeysHandler(button, deps)).rejects.toThrow(
      "not a textField or searchBar",
    );
    expect(events).toEqual([]);
  });
});
