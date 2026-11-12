import { z } from "zod/v4";

const assertionSchema = z
  .strictObject({
    contains: z.string().min(1).optional(),
    notContains: z.string().min(1).optional(),
  })
  .refine((value) => value.contains !== undefined || value.notContains !== undefined);

function logAssertionText(
  payload: object,
  checkAbsence: boolean,
): { text: string } | { error: string } {
  if (!("lines" in payload) || !Array.isArray(payload.lines)) {
    return { error: "Result assertion failed: getLogs returned no lines array" };
  }
  if (
    payload.lines.some(
      (line: unknown) =>
        !line ||
        typeof line !== "object" ||
        !("message" in line) ||
        typeof line.message !== "string",
    )
  ) {
    return { error: "Result assertion failed: getLogs returned an invalid log line" };
  }
  if (checkAbsence && "truncated" in payload && payload.truncated === true) {
    return {
      error:
        "Result assertion notContains failed: getLogs output was truncated; absence cannot be verified",
    };
  }
  return { text: payload.lines.map((line: { message: string }) => line.message).join("\n") };
}

/** Check the original payload before plan-result trimming. Never asserts on envelope metadata. */
export function stepResultAssertionError(
  tool: string,
  assertion: unknown,
  payload: unknown,
): string | undefined {
  const parsed = assertionSchema.safeParse(assertion);
  if (!parsed.success) {
    return "Result assertion failed: expect requires contains and/or notContains as non-empty strings";
  }
  if (!payload || typeof payload !== "object") {
    return "Result assertion failed: the tool returned no structured payload";
  }
  const output =
    tool === "getLogs"
      ? logAssertionText(payload, parsed.data.notContains !== undefined)
      : { text: JSON.stringify(payload) };
  if ("error" in output) {
    return output.error;
  }
  const { text } = output;
  if (parsed.data.contains !== undefined && !text.includes(parsed.data.contains)) {
    return `Result assertion contains failed: ${JSON.stringify(parsed.data.contains)}`;
  }
  if (parsed.data.notContains !== undefined && text.includes(parsed.data.notContains)) {
    return `Result assertion notContains failed: ${JSON.stringify(parsed.data.notContains)}`;
  }
  return undefined;
}
