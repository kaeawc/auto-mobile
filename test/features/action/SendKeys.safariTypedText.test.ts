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
  readIosTypedTextField({ execute: async () => observation }, new FakeTimer());

test("captured Safari native URL change verifies typing despite unchanged focused web input", async () => {
  // The before state is derived from the captured after-state, changing only the native URL value.
  const before = await read(safariObservation("previous.example"));
  const after = await read(safariObservation());
  expect(compareIosTypedText("example.com", before, after)).toEqual({ success: true });
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

test("unchanged native inputs without advertised focus still fail verification", async () => {
  const field = await read(safariObservation("example.com", false, false, false));
  expect(compareIosTypedText("example.com", field, field).success).toBe(false);
});
