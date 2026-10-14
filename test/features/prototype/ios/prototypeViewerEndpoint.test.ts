import { expect, test } from "bun:test";
import { parsePrototypeViewerEndpoint } from "../../../../src/features/prototype/ios/prototypeViewerEndpoint";
import { ActionableError } from "../../../../src/models/ActionableError";

const TOKEN = "viewer-secret-token";

test("valid endpoint and unknown fields", () => {
  expect(
    parsePrototypeViewerEndpoint(JSON.stringify({ port: 65535, token: TOKEN, extra: true })),
  ).toEqual({ port: 65535, token: TOKEN });
  expect(
    parsePrototypeViewerEndpoint(JSON.stringify({ port: 1, token: "a".repeat(256) })).port,
  ).toBe(1);
  expect(
    parsePrototypeViewerEndpoint(JSON.stringify({ port: 1, token: "a".repeat(16) })).port,
  ).toBe(1);
});

const invalid = [
  "not-json",
  `{"token":"${TOKEN}",`,
  "[]",
  "null",
  "true",
  '"text"',
  ...[undefined, 0, 65536, 1.5, "1234"].map((port) => JSON.stringify({ port, token: TOKEN })),
  ...[
    undefined,
    7,
    "short",
    "a".repeat(257),
    `${TOKEN} `,
    `${TOKEN}\n`,
    `${TOKEN}\t`,
    `${TOKEN}\0`,
    `${TOKEN}\u007f`,
    `${TOKEN}\u0085`,
  ].map((token) => JSON.stringify({ port: 1234, token })),
];
for (const [index, text] of invalid.entries()) {
  test(`invalid endpoint ${index} is actionable and never exposes the token`, () => {
    expect(() => parsePrototypeViewerEndpoint(text)).toThrow(ActionableError);
    try {
      parsePrototypeViewerEndpoint(text);
    } catch (error) {
      expect(error).toBeInstanceOf(ActionableError);
      if (!(error instanceof Error)) {
        throw error;
      }
      expect(error.message).toContain("viewer wrote an invalid endpoint file");
      expect(error.message).not.toContain(TOKEN);
      expect(error.cause).toBeUndefined();
    }
  });
}
