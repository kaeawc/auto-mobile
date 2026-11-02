import { expect, test } from "bun:test";
import captured from "../../fixtures/ios-safari-url-field/hierarchy-after-typing.json";
import { buildObserveResult, viewHierarchyFromFixture } from "../../helpers/observeFixture";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import {
  compareIosTypedText,
  readIosTypedTextField,
} from "../../../src/features/action/iosTypedTextVerification";
import { FakeTimer } from "../../fakes/FakeTimer";
import { typedObservation } from "./IosTypedTextTestHarness";
import { createSendKeysHarness, ios } from "./SendKeysTestHarness";

function safariObservation(
  value = "example.com",
  secure = false,
  nativeFocused = false,
  webFocused = true,
) {
  const hierarchy = viewHierarchyFromFixture(structuredClone(captured));
  const parser = new DefaultElementParser();
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node) => {
      const attributes = nodeAttributes(node);
      if (!webFocused) {
        delete attributes.focused;
      }
      if (attributes["view-id"] !== "URL") {
        return;
      }
      attributes.value = value;
      if (nativeFocused) {
        attributes.focused = "true";
      }
      if (secure) {
        attributes.password = true;
        Object.defineProperty(attributes, "value", {
          get() {
            throw new Error("Secure value read");
          },
        });
      }
    });
  }
  return buildObserveResult({
    updatedAt: 1,
    screenSize: { width: 402, height: 874 },
    systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
    viewHierarchy: hierarchy,
  });
}

const read = (observation: ReturnType<typeof safariObservation>) =>
  readIosTypedTextField({
    observer: { execute: async () => observation },
    timer: new FakeTimer(),
  });

test("captured Safari native URL change verifies typing despite unchanged focused web input", async () => {
  // The before state is derived from the captured after-state, changing only the native URL value.
  const before = await read(safariObservation("previous.example"));
  const after = await read(safariObservation());
  expect(compareIosTypedText("example.com", before, after)).toEqual({ success: true });
});

test("captured Safari native URL accepts 1500 code points in two verified chunks", async () => {
  let value = "previous.example";
  const h = createSendKeysHarness(ios, { execute: async () => safariObservation(value) });
  const insert = h.client.insert;
  h.client.insert = async (text, options) => {
    value += text;
    return insert(text, options);
  };
  const text = "a".repeat(1000) + "b".repeat(500);
  expect(await h.executor.type({ action: "type", text })).toMatchObject({ success: true });
  expect(h.inserted.map((chunk) => chunk.length)).toEqual([1000, 500]);
  expect(value).toBe(`previous.example${text}`);
});

test("chunk verification accepts a native URL insertion at the caret despite stale web focus", async () => {
  const before = await read(safariObservation("prefixSUFFIX"));
  const after = await read(safariObservation("prefixabcSUFFIX"));
  expect(compareIosTypedText("abc", before, after, true)).toEqual({ success: true });
});

test.each([
  { label: "partial repeated chunk", append: "a".repeat(500) },
  { label: "different chunk", append: "b".repeat(1000) },
  { label: "extra growth", append: "a".repeat(1001) },
])("chunk verification rejects native URL changes with $label", async ({ append }) => {
  const before = await read(safariObservation("a".repeat(1000)));
  const after = await read(safariObservation("a".repeat(1000) + append));
  expect(compareIosTypedText("a".repeat(1000), before, after, true).success).toBe(false);
  // Ordinary verification retains its existing changed-native-value contract.
  expect(compareIosTypedText("a".repeat(1000), before, after)).toEqual({ success: true });
});

test("chunk verification requires a shared native identity for the insertion fallback", () => {
  expect(
    compareIosTypedText(
      "abc",
      { secure: false, value: "web", nativeEditableValues: { first: "prefix" } },
      { secure: false, value: "web", nativeEditableValues: { second: "prefixabc" } },
      true,
    ).success,
  ).toBe(false);
});

test("captured Safari unchanged native and web inputs still fail typing verification", async () => {
  const field = await read(safariObservation());
  expect(compareIosTypedText("example.com", field, field)).toMatchObject({ success: false });
});

test("native inputs verify typing when no field advertises focus", async () => {
  expect(
    compareIosTypedText(
      "example.com",
      await read(safariObservation("", false, false, false)),
      await read(safariObservation("example.com", false, false, false)),
    ),
  ).toEqual({ success: true });
});

test("native focused search input retains the existing snapshot shape", async () => {
  const before = await read(typedObservation(""));
  const after = await read(typedObservation("example.com"));
  expect(after).toEqual({ value: "example.com", secure: false });
  expect(compareIosTypedText("example.com", before, after)).toEqual({ success: true });
});

test("unfocused secure native input values are never read or captured", async () => {
  const field = await read(safariObservation("secret", true));
  expect(JSON.stringify(field)).not.toContain("secret");
  expect(compareIosTypedText("secret", field, field)).toMatchObject({ success: false });
});

test("focused secure native input keeps secure verification skip without reading values", async () => {
  const field = await read(safariObservation("secret", true, true));
  expect(field?.secure).toBe(true);
  expect(JSON.stringify(field)).not.toContain("secret");
  expect(compareIosTypedText("secret", field, field).warning).toContain("skipped");
});

test.each(["role", "action", "class"])(
  "native fallback recognizes %s inputs and falls back to resource-id identity",
  async (signal) => {
    const observation = safariObservation();
    const parser = new DefaultElementParser();
    for (const root of parser.extractRootNodes(observation.viewHierarchy!)) {
      parser.traverseNode(root, (node) => {
        const attributes = nodeAttributes(node);
        if (attributes["view-id"] !== "URL") {
          return;
        }
        delete attributes["view-id"];
        attributes.class = signal === "class" ? "UITextView" : "UIView";
        if (signal !== "role") {
          delete attributes.role;
        }
        if (signal !== "action") {
          delete attributes.actions;
        }
      });
    }
    expect((await read(observation))?.nativeEditableValues).toEqual({ URL: "example.com" });
  },
);

test("unchanged native inputs without a readable focused value stay unverified, not failed", async () => {
  // Typing into web content whose value the runner does not expose must not read as "nothing typed".
  const field = await read(safariObservation("example.com", false, false, false));
  expect(compareIosTypedText("example.com", field, field)).toMatchObject({
    success: true,
    warning: expect.stringContaining("not verified"),
  });
});
