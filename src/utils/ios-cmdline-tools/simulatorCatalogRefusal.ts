/**
 * The refusal for a runtime or device-type identifier an Apple simulator catalog does not list
 * (#17090). It names the accepted identifiers and where to read them, and when the request is a
 * short form of a listed identifier (`Apple-TV-4K-3rd-generation-4K` for
 * `com.apple.CoreSimulator.SimDeviceType.Apple-TV-4K-3rd-generation-4K`), the full one to pass.
 */
export function unknownSimulatorIdentifierMessage(args: {
  /** What was looked up, e.g. "Apple TV device type" or "tvOS runtime". */
  kind: string;
  requested: string;
  identifiers: readonly string[];
  /** Where the caller reads the host's identifiers. */
  catalog: string;
}): string {
  const { kind, requested, identifiers, catalog } = args;
  const fullForm = fullIdentifierFor(requested, identifiers);
  return (
    `Unknown ${kind} '${requested}'.` +
    (fullForm ? ` Pass the full CoreSimulator identifier '${fullForm}'.` : "") +
    ` Available: ${listOrNone(identifiers)} (listed by ${catalog}).`
  );
}

/** The one listed identifier whose last dot-separated segment is `requested`, ignoring case. */
function fullIdentifierFor(requested: string, identifiers: readonly string[]): string | undefined {
  const wanted = requested.toLowerCase();
  const matches = identifiers.filter((identifier) =>
    identifier.toLowerCase().endsWith(`.${wanted}`),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function listOrNone(identifiers: readonly string[]): string {
  return identifiers.length > 0 ? identifiers.join(", ") : "none installed";
}
