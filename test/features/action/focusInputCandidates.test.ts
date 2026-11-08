import { describe, expect, test } from "bun:test";
import {
  describeInputCandidates,
  onScreenInputCandidates,
} from "../../../src/features/action/focusInputCandidates";
import { TapOnElement } from "../../../src/features/action/TapOnElement";
import { TapTargetUnavailableError } from "../../../src/features/action/tapTargetSupport";
import { createHierarchyForTest } from "../observe/observeScreenTestBuilders";
import { buildObserveResult } from "../../helpers/observeFixture";
import { FakeAdbClient } from "../../fakes/FakeAdbClient";
import { FakeTimer } from "../../fakes/FakeTimer";
import { contactsCreateContactHierarchy } from "../../fixtures/observe/android-contacts-create-contact";

const viewport = { width: 1080, height: 2400 };

describe("on-screen input candidates (#17463)", () => {
  test("lists the form's inputs as observe names them, top to bottom", () => {
    expect(onScreenInputCandidates(contactsCreateContactHierarchy(), viewport)).toEqual([
      { elementId: "first_name", label: "Ada", sublabel: "First name" },
      { elementId: "last_name", label: "Lovelace", sublabel: "Last name" },
      { label: "+1", sublabel: "Phone (Mobile)" },
    ]);
  });

  test("an empty field is labelled by its hint, and off-screen fields are left out", () => {
    const capture = createHierarchyForTest({
      hierarchy: {
        node: {
          bounds: { left: 0, top: 0, right: 1080, bottom: 2400 },
          node: [
            {
              bounds: { left: 0, top: 100, right: 500, bottom: 200 },
              class: "android.widget.EditText",
              "hint-text": "Email",
              focusable: true,
            },
            {
              bounds: { left: 0, top: 2600, right: 500, bottom: 2700 },
              class: "android.widget.EditText",
              "hint-text": "Notes",
              focusable: true,
            },
            { bounds: { left: 0, top: 300, right: 500, bottom: 400 }, text: "Name" },
          ],
        },
      },
    });
    expect(onScreenInputCandidates(capture, viewport)).toEqual([{ label: "Email" }]);
  });

  test("lists at most three and describes them for the client", () => {
    const fields = Array.from({ length: 5 }, (_, i) => ({
      bounds: { left: 0, top: i * 100, right: 500, bottom: i * 100 + 80 },
      class: "android.widget.EditText",
      "resource-id": `f${i}`,
      focusable: true,
    }));
    const listed = onScreenInputCandidates(
      createHierarchyForTest({ hierarchy: { node: { node: fields } } }),
      viewport,
    );
    expect(listed.map((row) => row.elementId)).toEqual(["f0", "f1", "f2"]);
    expect(
      describeInputCandidates([{ elementId: "a", label: "+1", sublabel: "Phone (Mobile)" }]),
    ).toBe(
      'On-screen inputs: {elementId "a", label "+1", sublabel "Phone (Mobile)"}. Select one by its elementId or label.',
    );
  });

  test("no hierarchy, no candidates", () => {
    expect(onScreenInputCandidates(undefined)).toEqual([]);
  });
});

describe("focus not-found error names on-screen inputs (#17463)", () => {
  const tapOn = () =>
    new TapOnElement(
      { name: "test-device", platform: "android", deviceId: "emulator-5554" },
      new FakeAdbClient(),
      { timer: new FakeTimer() },
    );
  const observation = (viewHierarchy = contactsCreateContactHierarchy()) =>
    buildObserveResult({
      screenSize: viewport,
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
      viewHierarchy,
      updatedAt: 0,
    });

  async function notFound(
    action: "focus" | "tap",
    observeResult = observation(),
  ): Promise<TapTargetUnavailableError> {
    try {
      await tapOn()["handleElementNotFound"]({ action, text: "Mobile phone" }, { observeResult });
    } catch (error) {
      if (error instanceof TapTargetUnavailableError) {
        return error;
      }
      throw error;
    }
    throw new Error("expected handleElementNotFound to throw");
  }

  test("a focus miss lists the inputs and is marked as not a scroll problem", async () => {
    const error = await notFound("focus");
    expect(error.reason).toBe("not-found-inputs-listed");
    expect(error.message).toBe(
      "Element not found with provided text 'Mobile phone'. On-screen inputs: " +
        '{elementId "first_name", label "Ada", sublabel "First name"}; ' +
        '{elementId "last_name", label "Lovelace", sublabel "Last name"}; ' +
        '{label "+1", sublabel "Phone (Mobile)"}. Select one by its elementId or label.',
    );
  });

  test("a focus miss on a screen without inputs keeps the plain not-found reason", async () => {
    const error = await notFound(
      "focus",
      observation(
        createHierarchyForTest({
          hierarchy: { node: { bounds: { left: 0, top: 0, right: 10, bottom: 10 }, text: "Hi" } },
        }),
      ),
    );
    expect(error.reason).toBe("not-found");
    expect(error.message).toBe("Element not found with provided text 'Mobile phone'");
  });

  test("a tap miss is unchanged", async () => {
    const error = await notFound("tap");
    expect(error.reason).toBe("not-found");
    expect(error.message).toBe("Element not found with provided text 'Mobile phone'");
  });
});
