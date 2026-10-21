import { ActionableError } from "../../../models/ActionableError";

export const PROTOTYPE_VIEWER_ENDPOINT_RELATIVE_PATH = "Library/AutoMobile/prototype-endpoint.json";

function isPlainEndpoint(value: unknown): value is { port?: unknown; token?: unknown } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Validate untrusted endpoint JSON without exposing its authentication token in errors. */
export function parsePrototypeViewerEndpoint(text: string): { port: number; token: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // JSON.parse errors can quote the input, so deliberately omit that cause.
    throw new ActionableError("The viewer wrote an invalid endpoint file: expected JSON.");
  }
  if (!isPlainEndpoint(value)) {
    throw new ActionableError(
      "The viewer wrote an invalid endpoint file: expected a plain object.",
    );
  }
  if (
    typeof value.port !== "number" ||
    !Number.isInteger(value.port) ||
    value.port < 1 ||
    value.port > 65535
  ) {
    throw new ActionableError(
      "The viewer wrote an invalid endpoint file: port must be an integer in 1..65535.",
    );
  }
  if (
    typeof value.token !== "string" ||
    value.token.length < 16 ||
    value.token.length > 256 ||
    /[\s\p{Cc}]/u.test(value.token)
  ) {
    throw new ActionableError(
      "The viewer wrote an invalid endpoint file: token must contain 16..256 characters without whitespace or control characters.",
    );
  }
  return { port: value.port, token: value.token };
}
