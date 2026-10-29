import type { Rule } from "./prototypeBindingValidation";
import { prototypeContractPatterns } from "./prototypeContractPatterns";
import {
  prototypeDataPathPointer,
  prototypeDataPointerTokens,
  resolvePrototypeDataPointer,
} from "./prototypeData";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import type { PrototypePlatformError, PrototypePlatformValueCheck } from "./prototypePlatform";
import { record, type Raw } from "./prototypeTemplate";

/**
 * Rules for `videoPlayer.captions` (#14259) that the contract cannot express: track ids are unique
 * per player and never use the `hls:` prefix in-band tracks own, and `/data` cues point at a
 * declared array of `mediaCaptionCue` objects that each end after they start.
 */

const CUE_RULE: Rule = { kind: "ref", name: "mediaCaptionCue" };

function keyPath(path: string, key: string): string {
  return prototypeContractPatterns.pathKey.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/** The first caption rule a spec's `videoPlayer` nodes break. */
export function prototypeMediaCaptionsError(
  root: Raw,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  let found: PrototypePlatformError | undefined;
  walkPrototypeNodes(root, (node, path) => {
    if (!found && node.type === "videoPlayer" && Array.isArray(node.captions)) {
      found = playerError(root, node.captions, `${path}.captions`, check);
    }
  });
  return found;
}

function playerError(
  root: Raw,
  captions: unknown[],
  path: string,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  const seen = new Set<unknown>();
  for (const [index, raw] of captions.entries()) {
    const caption = record(raw) ?? {};
    const at = `${path}[${index}]`;
    if (typeof caption.id === "string" && caption.id.startsWith("hls:")) {
      return { path: `${at}.id`, message: "Caption ids starting with hls: are reserved" };
    }
    if (seen.has(caption.id)) {
      return { path: `${at}.id`, message: "Duplicate caption id" };
    }
    seen.add(caption.id);
    const data = record(caption.source)?.data;
    const error =
      data === undefined ? undefined : cuesError(root, data, `${at}.source.data`, check);
    if (error) {
      return error;
    }
  }
  return undefined;
}

function cuesError(
  root: Raw,
  data: unknown,
  path: string,
  check: PrototypePlatformValueCheck,
): PrototypePlatformError | undefined {
  const pointer = prototypeDataPathPointer(data);
  const cues = pointer === undefined ? undefined : resolvePrototypeDataPointer(root.data, pointer);
  if (pointer === undefined || !Array.isArray(cues)) {
    return { path, message: "Caption data must point to a /data array" };
  }
  const base = prototypeDataPointerTokens(pointer).reduce(keyPath, "data");
  for (const [index, cue] of cues.entries()) {
    const at = `${base}[${index}]`;
    const error = check(cue, CUE_RULE, at);
    if (error) {
      return error;
    }
    const { startMs, endMs } = record(cue) ?? {};
    if (typeof startMs === "number" && typeof endMs === "number" && endMs <= startMs) {
      return { path: `${at}.endMs`, message: "A caption cue must end after it starts" };
    }
  }
  return undefined;
}
