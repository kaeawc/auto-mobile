import { describe, expect, test } from "bun:test";
import type { PrototypeEvent } from "../../../../src/features/observe/android/ctrlProxyProtocol";
import { VirtualPrototypeDevice } from "../../../../src/features/prototype/headless/VirtualPrototypeDevice";
import {
  clipUtf16,
  VirtualPrototypeInputs,
} from "../../../../src/features/prototype/headless/VirtualPrototypeInputs";
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

  test("maxLength counts UTF-16 code units and never splits a surrogate pair (#18401)", async () => {
    const { inputs, events } = await shown(
      column({ type: "textField", id: "name", label: "Name", stateKey: "name", maxLength: 3 }),
      { state: { name: "" } },
    );
    inputs.tap({ testTag: "name" });
    inputs.typeText("a\u{1F600}b", "insert");
    inputs.typeText("ab\u{1F600}", "replace");
    expect(events.map((event) => event.payload)).toEqual([
      { key: "name", value: "a\u{1F600}" },
      { key: "name", value: "ab" },
    ]);
  });

  test("clipUtf16 keeps short text and cuts at a pair boundary", () => {
    expect(clipUtf16("abc", undefined)).toBe("abc");
    expect(clipUtf16("abc", 5)).toBe("abc");
    expect(clipUtf16("\u{1F600}", 1)).toBe("");
    expect(clipUtf16("\u{1F600}x", 2)).toBe("\u{1F600}");
    expect(clipUtf16("abc", 0)).toBe("");
  });

  test("typing reads the field's maxLength as patched since focus (#18421)", async () => {
    const { inputs, events, device } = await shown(
      column({ type: "textField", id: "name", label: "Name", stateKey: "name", maxLength: 2 }),
      { state: { name: "" } },
    );
    inputs.tap({ testTag: "name" });
    const patched = await device.requestPatchPrototype({
      id: "demo",
      ops: [
        {
          op: "replaceNode",
          id: "name",
          node: { type: "textField", id: "name", label: "Name", stateKey: "name", maxLength: 4 },
        },
      ],
    });
    expect(patched.success).toBe(true);
    inputs.typeText("abcdef", "insert");
    expect(events.map((event) => event.payload)).toEqual([{ key: "name", value: "abcd" }]);
  });

  test("a large emit context is cut to the shared byte budget and flagged (#18401)", async () => {
    const { inputs, events } = await shown(
      column({
        type: "button",
        label: "Send",
        onTap: [
          {
            type: "emit",
            name: "sent",
            context: { a: { state: "small" }, b: { state: "big" }, c: { value: 1 } },
          },
        ],
      }),
      { state: { small: "ok", big: "x".repeat(5000) } },
    );
    inputs.tap({ text: "Send" });
    expect(events[0]).toMatchObject({ name: "sent", context: { a: "ok" }, contextTruncated: true });
    expect(events[0]?.context).toEqual({ a: "ok" });
  });

  test("an emit context within budget carries no truncation flag", async () => {
    const { inputs, events } = await shown(
      column({
        type: "button",
        label: "Send",
        onTap: [{ type: "emit", name: "sent", context: { a: { state: "small" } } }],
      }),
      { state: { small: "ok" } },
    );
    inputs.tap({ text: "Send" });
    expect(events[0]?.context).toEqual({ a: "ok" });
    expect(events[0]).not.toHaveProperty("contextTruncated");
  });

  test("an open dialog scopes taps to itself; background nodes are not matched (#18421)", async () => {
    const { inputs, events } = await shown(
      column(
        { type: "button", label: "Behind", onTap: [{ type: "emit", name: "behind" }] },
        {
          type: "dialog",
          openWhen: { key: "open", equals: true },
          title: "Sure?",
          confirm: { label: "Yes", onTap: [{ type: "emit", name: "yes" }] },
        },
      ),
      { state: { open: true } },
    );
    expect(inputs.tap({ text: "Behind" })).toMatchObject({
      success: false,
      error: expect.stringContaining("No visible prototype node matches"),
    });
    expect(events).toEqual([]);
    inputs.tap({ text: "Yes" });
    expect(inputs.tap({ text: "Behind" })).toMatchObject({ success: true, handled: true });
    expect(events.map((event) => event.name)).toEqual(["change", "yes", "behind"]);
  });

  test("the topmost of nested sheets takes taps, and a snackbar above stays tappable", async () => {
    const { inputs } = await shown(
      column(
        {
          type: "bottomSheet",
          openWhen: { key: "sheet", equals: true },
          detents: ["half"],
          child: column(
            { type: "button", label: "In sheet", onTap: [{ type: "emit", name: "sheet" }] },
            {
              type: "dialog",
              openWhen: { key: "dialog", equals: true },
              title: "Top",
              confirm: { label: "OK" },
            },
          ),
        },
        {
          type: "snackbar",
          openWhen: { key: "toast", equals: true },
          text: "Saved",
          action: { label: "Undo", onTap: [{ type: "emit", name: "undo" }] },
        },
      ),
      { state: { sheet: true, dialog: true, toast: true } },
    );
    expect(inputs.tap({ text: "In sheet" }).success).toBe(false);
    expect(inputs.tap({ text: "Undo" })).toMatchObject({ success: true, handled: true });
    expect(inputs.tap({ text: "OK" })).toMatchObject({ success: true, handled: true });
    expect(inputs.tap({ text: "In sheet" })).toMatchObject({ success: true, handled: true });
  });

  test("a field covered by an open dialog cannot take typing", async () => {
    const { inputs } = await shown(
      column(
        { type: "textField", id: "name", label: "Name", stateKey: "name" },
        {
          type: "button",
          label: "Ask",
          onTap: [{ type: "setState", key: "open", value: true }],
        },
        {
          type: "dialog",
          openWhen: { key: "open", equals: true },
          title: "Wait",
          confirm: { label: "OK" },
        },
      ),
      { state: { name: "", open: false } },
    );
    inputs.tap({ testTag: "name" });
    inputs.tap({ text: "Ask" });
    expect(inputs.typeText("A", "insert").success).toBe(false);
  });

  test("a snackbar's action button closes it, then runs its actions (#18421)", async () => {
    const { inputs, events } = await shown(
      column(
        { type: "text", text: "Body" },
        {
          type: "snackbar",
          openWhen: { key: "toast", equals: true },
          text: "Deleted",
          action: { label: "Undo", onTap: [{ type: "emit", name: "undo" }] },
        },
      ),
      { state: { toast: true } },
    );
    expect(inputs.tap({ text: "Undo" })).toMatchObject({
      success: true,
      target: { type: "snackbarAction" },
    });
    expect(events.map((event) => [event.name, event.payload])).toEqual([
      ["change", { key: "toast", value: false }],
      ["undo", null],
    ]);
    expect(inputs.tap({ text: "Undo" }).success).toBe(false);
  });

  test("a listItem with a trailing switch toggles it before its actions (#18421)", async () => {
    const { inputs, events } = await shown(
      column({
        type: "listItem",
        headline: "Wi-Fi",
        trailing: { type: "switch", stateKey: "wifi" },
        onTap: [{ type: "emit", name: "wifiTapped", context: { on: { state: "wifi" } } }],
      }),
      { state: { wifi: false } },
    );
    inputs.tap({ text: "Wi-Fi" });
    expect(events.map((event) => [event.name, event.payload])).toEqual([
      ["change", { key: "wifi", value: true }],
      ["wifiTapped", null],
    ]);
    expect(events[1]?.context).toEqual({ on: true });
  });

  test("a tab bar item bound to a pager moves it before the bar's actions (#18421)", async () => {
    const { inputs, events } = await shown(
      column(
        {
          type: "tabBar",
          pager: "tabs",
          items: [{ label: "Home" }, { label: "Profile" }],
          onTap: [{ type: "emit", name: "tab" }],
        },
        {
          type: "pager",
          id: "tabs",
          children: [
            { type: "text", text: "Home page" },
            { type: "text", text: "Profile page" },
          ],
        },
      ),
    );
    expect(inputs.tap({ text: "Profile" })).toMatchObject({
      success: true,
      target: { type: "tabBarItem" },
    });
    expect(events.map((event) => [event.kind, event.name, event.payload])).toEqual([
      ["page_changed", "tabs", 1],
      ["emit", "tab", null],
    ]);
  });

  test("a bottom nav item without a pager writes its index to the stateKey", async () => {
    const { inputs, events } = await shown(
      column({
        type: "bottomNav",
        stateKey: "section",
        items: [
          { label: "Feed", icon: "home" },
          { label: "Search", icon: "search" },
        ],
      }),
      { state: { section: 0 } },
    );
    inputs.tap({ text: "Search" });
    expect(events.map((event) => event.payload)).toEqual([{ key: "section", value: 1 }]);
  });

  test("a key set and restored with no event still conflicts a stale patch (#18421)", async () => {
    const { inputs, events, device } = await shown(
      column({
        type: "button",
        label: "Blink",
        onTap: [
          { type: "setState", key: "n", value: 1 },
          { type: "setState", key: "n", value: 0 },
        ],
      }),
      { state: { n: 0 } },
    );
    inputs.tap({ text: "Blink" });
    expect(events).toEqual([]);
    const stale = await device.requestPatchPrototype({
      id: "demo",
      baseRevision: 1,
      ops: [{ op: "replace", path: "/state/n", value: 5 }],
    });
    expect(stale).toMatchObject({ success: false, error: "conflict", revision: 2 });
  });

  test("a key set and restored before a dismissal still takes a revision (#18442)", async () => {
    const { inputs, events, device } = await shown(
      column({
        type: "button",
        label: "Blink",
        onTap: [
          { type: "setState", key: "n", value: 1 },
          { type: "setState", key: "n", value: 0 },
          { type: "dismiss" },
        ],
      }),
      { state: { n: 0 } },
    );
    expect(inputs.tap({ text: "Blink" })).toMatchObject({
      success: true,
      events: [{ sequence: 1, kind: "dismissed" }],
    });
    expect(events.map((event) => [event.kind, event.state])).toEqual([["dismissed", { n: 0 }]]);
    expect(device.shownIds()).toEqual([]);
    // The id's ledger outlives the dismissal: the show was revision 1, the net-zero write 2, so
    // showing it again is revision 3, as a device that stamps the write before dismissing has it.
    await device.requestShowPrototype(
      spec(column({ type: "text", text: "Back" }), { state: { n: 0 } }),
    );
    const patch = (baseRevision: number) =>
      device.requestPatchPrototype({
        id: "demo",
        baseRevision,
        ops: [{ op: "replace", path: "/state/n", value: 5 }],
      });
    expect(await patch(4)).toMatchObject({ success: false, revision: 3 });
    expect(await patch(3)).toMatchObject({ success: true, revision: 4 });
  });

  test("a later prototype shown again is the first a tap targets (#18401)", async () => {
    const timer = new FakeTimer();
    const device = new VirtualPrototypeDevice(timer);
    const names: string[] = [];
    device.onPrototypeEvent((event) => names.push(`${event.id}:${String(event.name)}`));
    const button = (id: string) =>
      prototypeSpecSchema.parse({
        id,
        window: { placement: { type: "fullscreen" } },
        root: column({ type: "button", label: "Go", onTap: [{ type: "emit", name: "go" }] }),
      });
    const keep = { replaceOthers: false };
    await device.requestShowPrototype(button("one"), undefined, undefined, keep);
    await device.requestShowPrototype(button("two"), undefined, undefined, keep);
    await device.requestShowPrototype(button("one"), undefined, undefined, keep);
    expect(new VirtualPrototypeInputs(device).tap({ text: "Go" }).prototypeId).toBe("one");
    expect(names).toEqual(["one:go"]);
  });
});
