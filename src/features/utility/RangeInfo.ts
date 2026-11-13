import type { RangeValue } from "../../models/RangeValue";

/** Parse Android's flat `current:X,min:Y,max:Z` accessibility attribute. */
export function parseRangeInfo(value: unknown): RangeValue | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const fields = new Map<string, number>();
  for (const token of value.split(",")) {
    const parts = token.split(":").map((part) => part.trim());
    const [key, raw] = parts;
    if (parts.length !== 2 || !["current", "min", "max"].includes(key) || !raw || fields.has(key)) {
      return undefined;
    }
    const number = Number(raw);
    if (!Number.isFinite(number)) {
      return undefined;
    }
    fields.set(key, number);
  }
  if (fields.size !== 3) {
    return undefined;
  }
  const current = fields.get("current")!;
  const min = fields.get("min")!;
  const max = fields.get("max")!;
  if (min > current || current > max) {
    return undefined;
  }
  return { current, min, max };
}

/** A SeekBar stays adjustable even when its capture omits numeric state. */
export function isRangeWidget(properties: Readonly<Record<string, unknown>>): boolean {
  return (
    parseRangeInfo(properties["range-info"]) !== undefined ||
    [properties.class, properties.className].includes("android.widget.SeekBar")
  );
}
