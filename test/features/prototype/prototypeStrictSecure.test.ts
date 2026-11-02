import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import secureChannel from "../../fixtures/prototype-spec/invalid/strict-library-secure-channel-platform-args.json";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const fixtures = join(import.meta.dir, "../../fixtures/prototype-spec");

test("library secure fields allow unbound values and opaque literals", () => {
  const spec = readFileSync(join(fixtures, "valid/strict-library-secure-unbound.json"), "utf8");
  expect(validatePrototypeSpec(spec, { library: true }).success).toBe(true);
});

test("library channel onOpen rejects secure realtime.send body bindings", () => {
  expect(validatePrototypeSpec(secureChannel.spec, { library: true })).toEqual({
    success: false,
    error: {
      path: "channels.chat.onOpen[0].args.body.state",
      message: "Secure value cannot be bound into an action payload",
    },
  });

  const publicChannel = structuredClone(secureChannel.spec);
  publicChannel.channels.chat.onOpen[0].args.body.state = "public";
  expect(validatePrototypeSpec(publicChannel, { library: true }).success).toBe(true);
});

for (const name of readdirSync(join(fixtures, "invalid"))
  .filter((name) => name.startsWith("strict-library-secure-"))
  .sort()) {
  const fixture = JSON.parse(readFileSync(join(fixtures, "invalid", name), "utf8")) as {
    spec: unknown;
    expectedPath: string;
    expectedMessage: string;
  };
  test(`${name} rejects only in library mode at its authored path`, () => {
    expect(validatePrototypeSpec(fixture.spec).success).toBe(true);
    expect(validatePrototypeSpec(fixture.spec, { library: true })).toEqual({
      success: false,
      error: {
        path: fixture.expectedPath,
        message: fixture.expectedMessage,
      },
    });
  });
}
