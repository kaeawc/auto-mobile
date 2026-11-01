import { expect, test } from "bun:test";
import { prototypeSecureStorageRequestError } from "../../../src/features/prototype/prototypeSecureStorage";

const root = { state: { token: "" }, storage: { secure: ["state:token"] } };
const request = (fields: Record<string, unknown>) => ({
  type: "request",
  url: "https://example.com",
  ...fields,
});
const message =
  "Secure storage key state:token cannot be sent in a request without allowSecureInRequest";

test("a multipart value binding a secure key is refused", () => {
  const body = {
    multipart: [
      { name: "a", value: { value: "x" } },
      { name: "t", value: { state: "token" } },
    ],
  };
  expect(prototypeSecureStorageRequestError(request({ body }), "r", root)).toEqual({
    path: "r.body.multipart[1].value",
    message,
  });
});

test("only allowSecureInRequest: true opts in", () => {
  const headers = { Authorization: { state: "token" } };
  expect(
    prototypeSecureStorageRequestError(
      request({ headers, allowSecureInRequest: false }),
      "r",
      root,
    ),
  ).toEqual({ path: "r.headers.Authorization", message });
  expect(
    prototypeSecureStorageRequestError(request({ headers, allowSecureInRequest: true }), "r", root),
  ).toBeUndefined();
});

test("a literal value and a spec without secure keys are not leaks", () => {
  const literal = request({ body: { value: { note: "{token}" } } });
  expect(prototypeSecureStorageRequestError(literal, "r", root)).toBeUndefined();
  const plain = request({ headers: { Authorization: { state: "token" } } });
  expect(prototypeSecureStorageRequestError(plain, "r", { state: { token: "" } })).toBeUndefined();
});
