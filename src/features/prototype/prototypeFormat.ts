import { logger } from "../../utils/logger";
import { resolvePrototypeDataPointer } from "./prototypeData";
import type {
  PrototypeFormat,
  PrototypeDerivedEntry,
  PrototypeRepeatDerivedEntry,
} from "./prototypeFormatSchema";

/** Caller supplies device defaults and a clock snapshot; no ambient clock is read. */
export interface PrototypeFormatEnvironment {
  locale: string;
  timeZone: string;
  nowMs: number;
}

/** Fixed elapsed-time units, not calendar arithmetic: 30-day months and 365-day years. */
const relativeUnits = [
  [31536000000, "year"],
  [2592000000, "month"],
  [86400000, "day"],
  [3600000, "hour"],
  [60000, "minute"],
  [1000, "second"],
] as const;

function epoch(input: unknown): number | undefined {
  if (typeof input === "number") {
    return Number.isFinite(input) && Number.isInteger(input) && Math.abs(input) <= 8640000000000000
      ? input
      : undefined;
  }
  if (
    typeof input !== "string" ||
    !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(
      input,
    )
  ) {
    return undefined;
  }
  const date = input.slice(0, 10);
  const calendar = Date.parse(`${date}T00:00:00Z`);
  if (!Number.isFinite(calendar) || new Date(calendar).toISOString().slice(0, 10) !== date) {
    return undefined;
  }
  const ms = Date.parse(input);
  return Number.isFinite(ms) ? ms : undefined;
}

function fractionOptions(options: {
  minFraction?: number;
  maxFraction?: number;
}): Intl.NumberFormatOptions {
  return { minimumFractionDigits: options.minFraction, maximumFractionDigits: options.maxFraction };
}

function numeric(format: PrototypeFormat, input: unknown, locale: string): string | undefined {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return undefined;
  }
  let options: Intl.NumberFormatOptions;
  if ("number" in format) {
    options = {
      ...fractionOptions(format.number),
      useGrouping: format.number.grouping === false ? false : "auto",
    };
  } else if ("compact" in format) {
    options = {
      notation: "compact",
      compactDisplay: format.compact.style ?? "short",
      useGrouping: "auto",
    };
  } else if ("currency" in format) {
    options = { style: "currency", currency: format.currency.code, useGrouping: "auto" };
  } else if ("percent" in format) {
    options = { style: "percent", ...fractionOptions(format.percent), useGrouping: "auto" };
  } else {
    return undefined;
  }
  return new Intl.NumberFormat(locale, options).format(input);
}

function relative(
  ms: number,
  style: Intl.RelativeTimeFormatStyle,
  formatting: PrototypeFormatEnvironment,
): string | undefined {
  if (!Number.isFinite(formatting.nowMs)) {
    return undefined;
  }
  const diff = ms - formatting.nowMs;
  const formatter = new Intl.RelativeTimeFormat(formatting.locale, {
    style,
    numeric: Math.abs(diff) < 1000 ? "auto" : "always",
  });
  const [size, unit] = relativeUnits.find(([size]) => Math.abs(diff) >= size) ?? relativeUnits[5];
  return formatter.format(Math.trunc(diff / size) || 0, unit);
}

function temporal(
  format: PrototypeFormat,
  input: unknown,
  formatting: PrototypeFormatEnvironment,
): string | undefined {
  const ms = epoch(input);
  if (ms === undefined) {
    return undefined;
  }
  if ("relative" in format) {
    return relative(ms, format.relative.style ?? "long", formatting);
  }
  const options: Intl.DateTimeFormatOptions =
    "date" in format
      ? { dateStyle: format.date.style ?? "medium" }
      : "time" in format
        ? { timeStyle: format.time.style ?? "short" }
        : {};
  return new Intl.DateTimeFormat(formatting.locale, {
    ...options,
    timeZone: formatting.timeZone,
  }).format(ms);
}

export function formatPrototypeValue(
  format: PrototypeFormat,
  input: unknown,
  formatting: PrototypeFormatEnvironment,
): string | undefined {
  try {
    return "date" in format || "time" in format || "relative" in format
      ? temporal(format, input, formatting)
      : numeric(format, input, formatting.locale);
  } catch (error) {
    // Invalid Intl locales, zones and option combinations are expected authored-input failures.
    logger.debug(`Prototype formatter rejected input: ${String(error)}`);
    return undefined;
  }
}

function environment(
  entry: { locale?: string; timeZone?: string },
  formatting: PrototypeFormatEnvironment,
): PrototypeFormatEnvironment {
  return {
    ...formatting,
    locale: entry.locale ?? formatting.locale,
    timeZone: entry.timeZone ?? formatting.timeZone,
  };
}

export function resolvePrototypeDerived(
  spec: { derive?: Record<string, PrototypeDerivedEntry> },
  name: string,
  context: { data?: unknown; state?: Record<string, unknown>; env: PrototypeFormatEnvironment },
): string {
  const entry = spec.derive && Object.hasOwn(spec.derive, name) ? spec.derive[name] : undefined;
  if (!entry) {
    return "";
  }
  const input =
    "value" in entry.of
      ? entry.of.value
      : "data" in entry.of
        ? resolvePrototypeDataPointer(context.data, entry.of.data)
        : context.state && Object.hasOwn(context.state, entry.of.state)
          ? context.state[entry.of.state]
          : undefined;
  return formatPrototypeValue(entry.format, input, environment(entry, context.env)) ?? "";
}

/** Derived fields read only the original item, never another derived field. */
export function projectPrototypeDerivedItem(
  derive: Record<string, PrototypeRepeatDerivedEntry>,
  item: Record<string, unknown>,
  formatting: PrototypeFormatEnvironment,
): Record<string, unknown> {
  const projected = { ...item };
  for (const [name, entry] of Object.entries(derive)) {
    const input =
      "value" in entry.of
        ? entry.of.value
        : Object.hasOwn(item, entry.of.item)
          ? item[entry.of.item]
          : undefined;
    Object.defineProperty(projected, name, {
      value: formatPrototypeValue(entry.format, input, environment(entry, formatting)) ?? "",
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return projected;
}
