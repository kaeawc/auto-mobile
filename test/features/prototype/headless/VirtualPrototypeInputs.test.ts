import { describe, expect, test } from "bun:test";
import type { PrototypeEvent } from "../../../../src/features/observe/android/ctrlProxyProtocol";
import { VirtualPrototypeDevice } from "../../../../src/features/prototype/headless/VirtualPrototypeDevice";
import { VirtualPrototypeInputs } from "../../../../src/features/prototype/headless/VirtualPrototypeInputs";
import { PrototypeEventCoordinator } from "../../../../src/features/prototype/PrototypeEventCoordinator";
import { InMemoryPrototypeStatusStore } from "../../../../src/features/prototype/PrototypeStatusStore";
import {
  prototypeSpecSchema,
  type PrototypeSpec,
} from "../../../../src/features/prototype/prototypeSpec";
import { FakeTimer } from "../../../fakes/FakeTimer";

const spec = (root: Record<string, unknown>, extra: Record<string, unknown> = {}): PrototypeSpec =>
  prototypeSpecSchema.parse({
    id: "demo",
    window: { placement: { type: "fullscreen" } },
    root,
    ...extra,
  });

async function shown(root: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const timer = new FakeTimer();
  timer.setCurrentTime(1000);
  const device = new VirtualPrototypeDevice(timer);
  const events: PrototypeEvent[] = [];
  device.onPrototypeEvent((event) => events.push(event));
  await device.requestShowPrototype(spec(root, extra));
  return { timer, device, events, inputs: new VirtualPrototypeInputs(device) };
}

const column = (...children: Record<string, unknown>[]) => ({ type: "column", children });

describe("VirtualPrototypeInputs (#18360)", () => {
  test("a tap on a button's label runs its emit and awaitEvent returns it", async () => {
    const { timer, device } = await shown(
      column({
        type: "button",
        id: "save",
        label: "Save",
        onTap: [{ type: "emit", name: "saved", payload: { ok: true } }],
      }),
    );
    const store = new InMemoryPrototypeStatusStore(timer);
    const coordinator = new PrototypeEventCoordinator(timer, store);
    const scope = { deviceId: "virtual" };
    try {
      coordinator.show(scope, "demo", device);
      const waiting = coordinator.awaitEvent(scope, "demo", device, { eventName: "saved" });
      const outcome = new VirtualPrototypeInputs(device).tap({ text: "save" });
      expect(outcome).toMatchObject({
        success: true,
        prototypeId: "demo",
        target: { type: "button", id: "save" },
        handled: true,
        events: [{ sequence: 1, kind: "emit", name: "saved" }],
      });
      expect((await waiting).event).toMatchObject({
        kind: "emit",
        name: "saved",
        payload: { ok: true },
        sequence: 1,
      });
    } finally {
      coordinator.dispose();
    }
  });

  test("state writes land before a later emit and one trailing change names them", async () => {
    const { inputs, events } = await shown(
      column({
        type: "button",
        label: "Add",
        onTap: [
          { type: "increment", key: "count", by: 2 },
          { type: "emit", name: "added", context: { count: { state: "count" }, v: { value: 3 } } },
          { type: "toggle", key: "on" },
        ],
      }),
      { state: { count: 1, on: false } },
    );
    inputs.tap({ text: "Add" });
    expect(events.map((event) => [event.kind, event.name, event.payload])).toEqual([
      ["emit", "added", null],
      ["emit", "change", { keys: ["count", "on"], values: { count: 3, on: true } }],
    ]);
    expect(events[0]).toMatchObject({
      state: { count: 3, on: false },
      context: { count: 3, v: 3 },
    });
    expect(events[1]?.state).toEqual({ count: 3, on: true });
  });

  test("a text node inside a card reaches the card's handler; a dead tap raises nothing", async () => {
    const { inputs, events } = await shown(
      column(
        {
          type: "card",
          onTap: [{ type: "emit", name: "opened" }],
          children: [{ type: "text", text: "Inbox" }],
        },
        { type: "text", text: "Footer" },
      ),
    );
    expect(inputs.tap({ text: "Inbox" })).toMatchObject({
      target: { type: "text" },
      handled: true,
    });
    expect(inputs.tap({ text: "Footer" })).toMatchObject({ success: true, handled: false });
    expect(events.map((event) => event.name)).toEqual(["opened"]);
  });

  test("a switch toggles its key and reports change before its own actions", async () => {
    const { inputs, events } = await shown(
      column({
        type: "switch",
        id: "wifi",
        label: "Wi-Fi",
        stateKey: "wifi",
        onTap: [{ type: "emit", name: "flipped" }],
      }),
      { state: { wifi: false } },
    );
    inputs.tap({ elementId: "wifi" });
    expect(events.map((event) => [event.name, event.payload])).toEqual([
      ["change", { key: "wifi", value: true }],
      ["flipped", null],
    ]);
  });

  test("hidden, closed and disabled nodes are not tapped", async () => {
    const { inputs, events } = await shown(
      column(
        {
          type: "button",
          label: "Secret",
          visibleWhen: { key: "show", equals: true },
          onTap: [{ type: "emit", name: "x" }],
        },
        {
          type: "button",
          label: "Off",
          enabledWhen: { key: "show", equals: true },
          onTap: [{ type: "emit", name: "y" }],
        },
      ),
      { state: { show: false } },
    );
    expect(inputs.tap({ text: "Secret", exactText: true }).success).toBe(false);
    expect(inputs.tap({ text: "Off" })).toMatchObject({ success: true, handled: false });
    expect(events).toEqual([]);
  });

  test("a dialog button closes the dialog, then runs its actions", async () => {
    const { inputs, events } = await shown(
      column({
        type: "dialog",
        openWhen: { key: "open", equals: true },
        title: "Delete?",
        confirm: { label: "Delete", onTap: [{ type: "emit", name: "deleted" }] },
      }),
      { state: { open: true } },
    );
    inputs.tap({ text: "Delete" });
    expect(events.map((event) => [event.name, event.payload])).toEqual([
      ["change", { key: "open", value: false }],
      ["deleted", null],
    ]);
    expect(inputs.tap({ text: "Delete" }).success).toBe(false);
  });

  test("setPage moves the pager and only the current page is tappable", async () => {
    const page = (label: string) => ({
      type: "button",
      label,
      onTap: [{ type: "setPage", pager: "p", page: "next" }],
    });
    const { inputs, events, device } = await shown(
      { type: "pager", id: "p", stateKey: "page", children: [page("One"), page("Two")] },
      { state: { page: 0 } },
    );
    expect(inputs.tap({ text: "Two" }).success).toBe(false);
    inputs.tap({ text: "One" });
    expect(events.map((event) => [event.kind, event.name, event.payload])).toEqual([
      ["page_changed", "p", 1],
      ["emit", "change", { key: "page", value: 1 }],
    ]);
    expect(device.snapshots()[0]?.snapshot.pages).toEqual({ p: 1 });
    expect(inputs.tap({ text: "Two" }).success).toBe(true);
  });

  test("push and pop change the stack and raise screen_changed", async () => {
    const { inputs, events } = await shown({
      type: "stack",
      id: "nav",
      start: "home",
      screens: {
        home: {
          type: "button",
          label: "Open",
          onTap: [{ type: "push", stack: "nav", screen: "detail" }],
        },
        detail: { type: "button", label: "Back", onTap: [{ type: "pop", stack: "nav" }] },
      },
    });
    inputs.tap({ text: "Open" });
    inputs.tap({ text: "Back" });
    expect(events.map((event) => [event.kind, event.payload, event.stacks?.nav?.depth])).toEqual([
      ["screen_changed", { screen: "detail", depth: 2 }, 2],
      ["screen_changed", { screen: "home", depth: 1 }, 1],
    ]);
  });

  test("dismiss raises dismissed and removes the prototype without a trailing change", async () => {
    const { inputs, events, device } = await shown(
      column({
        type: "button",
        label: "Close",
        onTap: [{ type: "toggle", key: "a" }, { type: "dismiss" }],
      }),
      { state: { a: false } },
    );
    inputs.tap({ text: "Close" });
    expect(events.map((event) => [event.kind, event.payload])).toEqual([
      ["dismissed", { reason: "user" }],
    ]);
    expect(device.shownIds()).toEqual([]);
  });

  test("an action the virtual device cannot run is refused before anything changes", async () => {
    const { inputs, events } = await shown(
      column({
        type: "button",
        label: "Load",
        onTap: [
          { type: "toggle", key: "a" },
          { type: "request", url: "https://example.com/feed", into: "/data/feed" },
        ],
      }),
      { state: { a: false }, data: { feed: {} } },
    );
    expect(inputs.tap({ text: "Load" })).toMatchObject({
      success: false,
      error: expect.stringContaining("cannot run request"),
    });
    expect(events).toEqual([]);
  });

  test("typing goes to the field a tap focused, honouring maxLength and replace", async () => {
    const { inputs, events } = await shown(
      column({ type: "textField", id: "name", label: "Name", stateKey: "name", maxLength: 5 }),
      { state: { name: "" } },
    );
    expect(inputs.typeText("Ada", "insert").success).toBe(false);
    expect(inputs.tap({ testTag: "name" })).toMatchObject({ focusedKey: "name", events: [] });
    inputs.typeText("Ada", "insert");
    inputs.typeText("Lovelace", "insert");
    inputs.typeText("Bo", "replace");
    inputs.clearText();
    expect(events.map((event) => event.payload)).toEqual([
      { key: "name", value: "Ada" },
      { key: "name", value: "AdaLo" },
      { key: "name", value: "Bo" },
      { key: "name", value: "" },
    ]);
  });

  test("with nothing shown a tap says to show a prototype", () => {
    const inputs = new VirtualPrototypeInputs(new VirtualPrototypeDevice(new FakeTimer()));
    expect(inputs.tap({ text: "Save" }).error).toContain("prototype show first");
  });

  test("string conditions decide visibleWhen and enabledWhen instead of failing open", async () => {
    const { inputs, events } = await shown(
      column(
        {
          type: "button",
          label: "Send",
          enabledWhen: { key: "email", contains: "@" },
          onTap: [{ type: "emit", name: "sent" }],
        },
        {
          type: "button",
          label: "Hint",
          visibleWhen: { key: "email", lengthGt: 20 },
          onTap: [{ type: "emit", name: "hint" }],
        },
      ),
      { state: { email: "invalid" } },
    );
    expect(inputs.tap({ text: "Send" })).toMatchObject({ success: true, handled: false });
    expect(inputs.tap({ text: "Hint", exactText: true }).success).toBe(false);
    expect(events).toEqual([]);
  });

  test("a condition the virtual device cannot decide refuses the tap", async () => {
    const { inputs, events } = await shown(
      column({
        type: "button",
        label: "Go",
        enabledWhen: { data: "/data/ready", equals: true },
        onTap: [{ type: "emit", name: "go" }],
      }),
      { data: { ready: false } },
    );
    expect(inputs.tap({ text: "Go" })).toMatchObject({
      success: false,
      error: expect.stringContaining("cannot decide the enabledWhen"),
    });
    expect(events).toEqual([]);
  });

  test("a state write to a pager's stateKey moves the pager to that page", async () => {
    const { inputs, device } = await shown(
      column(
        { type: "button", label: "Jump", onTap: [{ type: "setState", key: "page", value: 5 }] },
        {
          type: "pager",
          id: "p",
          stateKey: "page",
          children: [
            { type: "text", text: "First" },
            { type: "button", label: "Second", onTap: [{ type: "emit", name: "second" }] },
          ],
        },
      ),
      { state: { page: 0 } },
    );
    inputs.tap({ text: "Jump" });
    expect(device.snapshots()[0]?.snapshot).toMatchObject({ state: { page: 1 }, pages: { p: 1 } });
    expect(inputs.tap({ text: "Second" })).toMatchObject({ success: true, handled: true });
  });

  test("typing fails once the focused field is hidden", async () => {
    const { inputs, events } = await shown(
      column(
        {
          type: "textField",
          id: "name",
          label: "Name",
          stateKey: "name",
          visibleWhen: { key: "editing", equals: true },
        },
        {
          type: "button",
          label: "Done",
          onTap: [{ type: "setState", key: "editing", value: false }],
        },
      ),
      { state: { name: "", editing: true } },
    );
    inputs.tap({ testTag: "name" });
    inputs.tap({ text: "Done" });
    expect(inputs.typeText("Ada", "insert")).toMatchObject({
      success: false,
      error: expect.stringContaining("No text field has focus"),
    });
    expect(events.map((event) => event.payload)).toEqual([{ key: "editing", value: false }]);
  });

  test("a key restored after an intermediate emit ends restored on the device", async () => {
    const { inputs, events, device } = await shown(
      column({
        type: "button",
        label: "Blink",
        onTap: [
          { type: "setState", key: "n", value: 1 },
          { type: "emit", name: "middle" },
          { type: "setState", key: "n", value: 0 },
        ],
      }),
      { state: { n: 0 } },
    );
    inputs.tap({ text: "Blink" });
    expect(events.map((event) => [event.name, event.state])).toEqual([["middle", { n: 1 }]]);
    expect(device.snapshots()[0]?.snapshot.state).toEqual({ n: 0 });
  });

  test("a write the validator rejects is refused before any event or state lands", async () => {
    const { inputs, events, device } = await shown(
      column(
        { type: "textField", id: "q", label: "Query", stateKey: "query" },
        {
          type: "button",
          label: "Break",
          onTap: [
            { type: "emit", name: "before" },
            { type: "setState", key: "query", value: 1 },
          ],
        },
      ),
      { state: { query: "" } },
    );
    expect(inputs.tap({ text: "Break" })).toMatchObject({
      success: false,
      error: expect.stringContaining("rejects writing query"),
    });
    expect(events).toEqual([]);
    expect(device.snapshots()[0]?.snapshot.state).toEqual({ query: "" });
  });

  test("a collapsed search bar's results are not tappable", async () => {
    const { inputs, events } = await shown(
      column(
        {
          type: "searchBar",
          id: "search",
          stateKey: "q",
          activeKey: "active",
          placeholder: "Search",
          child: {
            type: "button",
            label: "Hidden result",
            onTap: [{ type: "emit", name: "picked" }],
          },
        },
        { type: "button", label: "Expand", onTap: [{ type: "toggle", key: "active" }] },
      ),
      { state: { q: "", active: false } },
    );
    expect(inputs.tap({ text: "Hidden result" }).success).toBe(false);
    inputs.tap({ text: "Expand" });
    expect(inputs.tap({ text: "Hidden result" })).toMatchObject({ success: true, handled: true });
    expect(events.at(-1)?.name).toBe("picked");
  });

  test("text selectors match interpolated text and a field's current value", async () => {
    const { inputs } = await shown(
      column(
        { type: "text", text: "Hello {name}" },
        { type: "textField", id: "city", label: "City", stateKey: "city" },
      ),
      { state: { name: "Ada", city: "Paris" } },
    );
    expect(inputs.tap({ text: "Hello Ada", exactText: true })).toMatchObject({
      target: { type: "text" },
    });
    expect(inputs.tap({ text: "Hello {name}", exactText: true }).success).toBe(false);
    expect(inputs.tap({ text: "Paris", exactText: true })).toMatchObject({
      target: { type: "textField", id: "city" },
      focusedKey: "city",
    });
  });

  test("focusOn focuses a field without running handlers and refuses a button", async () => {
    const { inputs, events } = await shown(
      column(
        {
          type: "textField",
          id: "email",
          label: "Email",
          stateKey: "email",
          onTap: [{ type: "emit", name: "tapped" }],
        },
        { type: "button", label: "Send", onTap: [{ type: "emit", name: "sent" }] },
      ),
      { state: { email: "" } },
    );
    expect(inputs.focusOn({ text: "Email" })).toMatchObject({ success: true, focusedKey: "email" });
    expect(inputs.focusOn({ text: "Send" })).toMatchObject({
      success: false,
      error: expect.stringContaining("matched a button, not a textField"),
    });
    expect(events).toEqual([]);
  });
});
