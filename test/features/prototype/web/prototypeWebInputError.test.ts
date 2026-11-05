import { describe, expect, test } from "bun:test";
import { readPrototypeSourceResource } from "../../../../src/features/prototype/prototypeSourceResource";
import { PrototypeSpecRevisions } from "../../../../src/features/prototype/prototypeSpecRevisions";
import { deviceFrameOrThrow } from "../../../../src/features/prototype/web/deviceFrames";
import { withActionableWebInput } from "../../../../src/features/prototype/web/prototypeWebInputActionable";
import { PrototypeWebInputError } from "../../../../src/features/prototype/web/prototypeWebInputError";
import { readPrototypeWebResource } from "../../../../src/features/prototype/web/prototypeWebResource";
import { buildPrototypeWebPage } from "../../../../src/features/prototype/web/webPage";
import { stillLocale } from "../../../../src/features/prototype/web/webLocale";
import { stillTextScale } from "../../../../src/features/prototype/web/webTextScale";
import { ActionableError } from "../../../../src/models/ActionableError";
import { FakeTimer } from "../../../fakes/FakeTimer";

const spec = {
  id: "checkout",
  window: { placement: { type: "fullscreen" } },
  root: { type: "text", text: "Hi" },
};

function thrown(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

/** The renderer's own error, and what a server entry point surfaces for the same input. */
function expectSurfaced(renderer: () => unknown, entryPoint: () => unknown): void {
  const inner = thrown(renderer);
  expect(inner).toBeInstanceOf(PrototypeWebInputError);
  expect(inner).not.toBeInstanceOf(ActionableError);
  const outer = thrown(entryPoint);
  expect(outer).toBeInstanceOf(ActionableError);
  expect((outer as Error).message).toBe((inner as Error).message);
}

function revisions(): PrototypeSpecRevisions {
  const store = new PrototypeSpecRevisions(new FakeTimer());
  store.recordShow("checkout", { spec, platform: "android" });
  return store;
}

const page = (extra: Record<string, unknown>) => () =>
  buildPrototypeWebPage({
    title: "t",
    variants: [
      { id: "checkout", label: "c", revisions: [{ revision: 1, operation: "show", spec }] },
    ],
    ...extra,
  });

describe("prototype web input errors reach the client unchanged (#16811)", () => {
  test("an invalid locale keeps its BCP 47 message, reason included", () => {
    const reason = (thrown(() => Intl.getCanonicalLocales("not a locale")) as Error).message;
    expect((thrown(() => stillLocale("not a locale")) as Error).message).toBe(
      `locale "not a locale" is not a valid BCP 47 tag: ${reason}`,
    );
    expectSurfaced(() => stillLocale("not a locale"), page({ locale: "not a locale" }));
  });

  test("an invalid text scale surfaces from the page builder", () => {
    expectSurfaced(
      () => stillTextScale("android", { fontScale: 9 }),
      page({ textSize: { fontScale: 9 } }),
    );
    expectSurfaced(
      () => stillTextScale("android", { contentSize: "large" }),
      page({ textSize: { contentSize: "large" } }),
    );
  });

  test("an unknown frame surfaces from the page and both resource readers", () => {
    const unknown = () => deviceFrameOrThrow("nokia-3310");
    expectSurfaced(unknown, page({ frame: "nokia-3310" }));
    expectSurfaced(unknown, () =>
      readPrototypeWebResource(revisions(), { id: "checkout", frame: "nokia-3310" }, "v"),
    );
    for (const format of ["compose", "swiftui"] as const) {
      expectSurfaced(unknown, () =>
        readPrototypeSourceResource(
          revisions(),
          format,
          { id: "checkout", frame: "nokia-3310" },
          "v",
        ),
      );
    }
  });

  test("other errors pass through untouched", () => {
    const other = new TypeError("boom");
    expect(
      thrown(() =>
        withActionableWebInput(() => {
          throw other;
        }),
      ),
    ).toBe(other);
    expect(withActionableWebInput(() => 3)).toBe(3);
  });
});
