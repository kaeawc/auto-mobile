import { version } from "../../../../../package.json";
import { PROTOTYPE_EMBED_FORMAT, PROTOTYPE_EMBED_VERSION } from "../prototypeEmbedFormat";
import { PROTOTYPE_WEB_CAPABILITIES } from "./prototypeWebCapabilities.generated";
import { prototypeWebBareSpecRequires } from "./prototypeWebBareSpec";
import {
  PROTOTYPE_LARGE_BUDGET_CAPABILITY,
  PROTOTYPE_REMOTE_IMAGE_CAPABILITY,
} from "../../../observe/android/ctrlProxyProtocol";

/** The web library's version, in lockstep with `@kaeawc/auto-mobile` (#16453). */
export const PROTOTYPE_WEB_LIBRARY_VERSION: string = version;

/**
 * Why the library drew an error view instead of the prototype:
 * - `unknownVersion`: an embed envelope version this release does not know;
 * - `missingCapabilities`: the envelope `requires`, or a bare spec needs, a capability this release
 *   cannot draw;
 * - `invalidInput`: the spec or envelope is not an object of the expected shape;
 * - `invalidOption`: an option the renderer refuses (an unknown frame, orientation or locale).
 */
export type PrototypeWebErrorCode =
  | "unknownVersion"
  | "missingCapabilities"
  | "invalidInput"
  | "invalidOption";

export interface PrototypeWebError {
  readonly code: PrototypeWebErrorCode;
  readonly message: string;
  /** For `missingCapabilities`: the required capabilities this release lacks, sorted. */
  readonly missing: readonly string[];
  readonly libraryVersion: string;
}

/** Thrown by `renderPrototype` when it refuses its input; `mount` draws it as an error view. */
export class PrototypeWebRefusal extends Error {
  readonly error: PrototypeWebError;

  constructor(code: PrototypeWebErrorCode, message: string, missing: readonly string[] = []) {
    super(message);
    this.name = "PrototypeWebRefusal";
    this.error = { code, message, missing, libraryVersion: PROTOTYPE_WEB_LIBRARY_VERSION };
  }
}

/** A spec the library will draw, plus the glyph markup its envelope shipped. */
export interface PrototypeWebSpecInput {
  readonly spec: Readonly<Record<string, unknown>>;
  readonly glyphs?: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string")
    ? value
    : undefined;
}

function glyphTable(value: unknown): Readonly<Record<string, string>> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!isRecord(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
    throw new PrototypeWebRefusal("invalidInput", "Embed envelope glyphs must map keys to markup.");
  }
  return value as Readonly<Record<string, string>>;
}

function missingFrom(requires: readonly string[], advertised: ReadonlySet<string>): string[] {
  return [...new Set(requires.filter((name) => !advertised.has(name)))].sort();
}

/** What to change for each capability no release of the library draws. */
const UNDRAWABLE_HINTS: Readonly<Record<string, string>> = {
  [PROTOTYPE_REMOTE_IMAGE_CAPABILITY]:
    "Replace remote images (url, placeholder, error, crossfade, via) with bundled assets.",
  [PROTOTYPE_LARGE_BUDGET_CAPABILITY]: "Keep the spec and its data within the base runtime budget.",
};

/** A bare spec is refused like an envelope whose `requires` it would carry (#16453). */
function readBareSpec(
  spec: Readonly<Record<string, unknown>>,
  advertised: ReadonlySet<string>,
): PrototypeWebSpecInput {
  const missing = missingFrom(prototypeWebBareSpecRequires(spec), advertised);
  if (missing.length > 0) {
    const hints = missing.map((name) => UNDRAWABLE_HINTS[name]).filter(Boolean);
    const update = missing.some((name) => UNDRAWABLE_HINTS[name] === undefined)
      ? ["Update the library."]
      : [];
    throw new PrototypeWebRefusal(
      "missingCapabilities",
      [
        `prototype-web ${PROTOTYPE_WEB_LIBRARY_VERSION} cannot draw this spec: it needs ${missing.join(", ")}.`,
        ...hints,
        ...update,
      ].join(" "),
      missing,
    );
  }
  return { spec };
}

function readEnvelope(
  envelope: Readonly<Record<string, unknown>>,
  advertised: ReadonlySet<string>,
): PrototypeWebSpecInput {
  if (envelope.version !== PROTOTYPE_EMBED_VERSION) {
    throw new PrototypeWebRefusal(
      "unknownVersion",
      `Embed envelope version ${JSON.stringify(envelope.version)} is not supported by prototype-web ${PROTOTYPE_WEB_LIBRARY_VERSION}, which reads version ${PROTOTYPE_EMBED_VERSION}.`,
    );
  }
  const requires = stringList(envelope.requires);
  if (!requires || !isRecord(envelope.spec)) {
    throw new PrototypeWebRefusal(
      "invalidInput",
      "An embed envelope needs a string array `requires` and an object `spec`.",
    );
  }
  const missing = missingFrom(requires, advertised);
  if (missing.length > 0) {
    throw new PrototypeWebRefusal(
      "missingCapabilities",
      `prototype-web ${PROTOTYPE_WEB_LIBRARY_VERSION} cannot draw this prototype: it needs ${missing.join(", ")}. Update the library.`,
      missing,
    );
  }
  const glyphs = glyphTable(envelope.glyphs);
  return { spec: envelope.spec, ...(glyphs ? { glyphs } : {}) };
}

/**
 * Reads the `spec` option: an embed envelope is checked against the capabilities this release
 * draws and refused whole when it needs more; anything else is a bare spec, refused the same way
 * for the capabilities it needs.
 */
export function readPrototypeWebInput(
  value: unknown,
  advertised: ReadonlySet<string> = new Set(PROTOTYPE_WEB_CAPABILITIES),
): PrototypeWebSpecInput {
  if (!isRecord(value)) {
    throw new PrototypeWebRefusal(
      "invalidInput",
      "The spec option must be a prototype spec or an embed envelope object.",
    );
  }
  return value.format === PROTOTYPE_EMBED_FORMAT
    ? readEnvelope(value, advertised)
    : readBareSpec(value, advertised);
}
