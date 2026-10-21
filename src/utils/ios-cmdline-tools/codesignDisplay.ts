/**
 * The code-signature summary `codesign -dvvv <bundle>` prints (on stderr), one `Key=value`
 * line per field (#14099). Only the fields `inspectPackageSigning` reports are lifted.
 */
export interface CodeSignature {
  /** The signed bundle identifier (`Identifier=`). */
  identifier: string | null;
  /** e.g. "app bundle with Mach-O thin (arm64)". */
  format: string | null;
  /** `TeamIdentifier=`; null for ad-hoc and unsigned-team signatures ("not set"). */
  teamId: string | null;
  /** Certificate chain, leaf first (`Authority=` lines). Empty for ad-hoc signatures. */
  authorities: string[];
  /** The leaf signing certificate's common name, e.g. "Apple Development: Jane Doe (ABCDE12345)". */
  signingIdentity: string | null;
  /** Ad-hoc signed (`Signature=adhoc`, or the `adhoc` CodeDirectory flag). */
  adHoc: boolean;
  /** The CodeDirectory hash (`CDHash=`), lowercase hex. */
  cdHash: string | null;
  /** `Signed Time=` as printed (locale-formatted); `Timestamp=` for secure timestamps. */
  signedTime: string | null;
}

function fields(output: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const line of output.split(/\r?\n/)) {
    const separator = line.indexOf("=");
    if (separator <= 0 || /^\s/.test(line)) {
      continue;
    }
    const key = line.slice(0, separator);
    map.set(key, [...(map.get(key) ?? []), line.slice(separator + 1).trim()]);
  }
  return map;
}

/** Parse `codesign -dvvv` display output. Unknown or missing fields read as null. */
export function parseCodesignDisplay(output: string): CodeSignature {
  const map = fields(output);
  const first = (key: string) => map.get(key)?.[0] ?? null;
  const team = first("TeamIdentifier");
  const authorities = map.get("Authority") ?? [];
  const codeDirectory = first("CodeDirectory v") ?? "";
  const cdHash = first("CDHash");
  return {
    identifier: first("Identifier"),
    format: first("Format"),
    teamId: team && team !== "not set" ? team : null,
    authorities,
    signingIdentity: authorities[0] ?? null,
    adHoc: first("Signature") === "adhoc" || /flags=\S*\(([^)]*\b)?adhoc\b/.test(codeDirectory),
    cdHash: cdHash ? cdHash.toLowerCase() : null,
    signedTime: first("Signed Time") ?? first("Timestamp"),
  };
}
