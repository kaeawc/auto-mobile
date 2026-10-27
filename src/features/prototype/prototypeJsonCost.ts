import contract from "../../../schemas/prototype-spec-contract.json";
import { object } from "./prototypeBindingValidation";

function bytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

// Reserve 32 bytes per finite number so lexical exponent/decimal spellings cannot
// change payload acceptance between JavaScript and JVM JSON decoders.
export function jsonCost(value: unknown, depth = 0): number {
  if (depth > contract.limits.MAX_PROTOTYPE_EMIT_PAYLOAD_DEPTH) {
    return Infinity;
  }
  if (value === null) {
    return 4;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? 32 : Infinity;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return bytes(value);
  }
  if (Array.isArray(value)) {
    return (
      2 +
      Math.max(0, value.length - 1) +
      value.reduce<number>((sum, child) => sum + jsonCost(child, depth + 1), 0)
    );
  }
  const data = object(value);
  if (!data) {
    return Infinity;
  }
  const entries = Object.entries(data);
  return (
    2 +
    Math.max(0, entries.length - 1) +
    entries.reduce((sum, [key, child]) => sum + bytes(key) + 1 + jsonCost(child, depth + 1), 0)
  );
}
