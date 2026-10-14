import {
  MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES,
  type PrototypeEmitContextBinding,
  type PrototypeJson,
} from "./prototypeSpec";
import { resolvePrototypeDataPointer } from "./prototypeData";
import { expandPrototypeComponents } from "./prototypeComponents";
import { mapBindableFields, record } from "./prototypeTemplate";
import { PROTOTYPE_EMIT_CONTEXT_CAPABILITY } from "../observe/android/ctrlProxyProtocol";

/** Existing actionable refusal shared by show and patch capability checks. */
export function prototypeEmitContextUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  const more = fields.length > 1 ? ` (and ${fields.length - 1} more)` : "";
  return `The ${device} does not advertise ${PROTOTYPE_EMIT_CONTEXT_CAPABILITY}, so it cannot resolve emit.context at ${fields[0]}${more}. Nothing was shown. ${update}, or omit emit.context.`;
}

/** Runtime inputs are read at the emit action, after preceding actions have committed. */
export interface PrototypeEmitContextInputs {
  state: Readonly<Record<string, PrototypeJson>>;
  pages: Readonly<Record<string, number>>;
  data?: PrototypeJson;
}
export interface ResolvedEmitContext {
  context: Record<string, PrototypeJson>;
  contextTruncated?: true;
}
type RuntimeBinding = Exclude<PrototypeEmitContextBinding, { item: string } | { index: true }>;

/** Executable reference for device runtimes. Repeat bindings must first be expanded. */
export function resolveEmitContext(
  bindings: Readonly<Record<string, RuntimeBinding>>,
  inputs: PrototypeEmitContextInputs,
): ResolvedEmitContext {
  const entries = Object.entries(bindings).map(([name, binding]): [string, PrototypeJson] => {
    const value =
      "state" in binding
        ? Object.hasOwn(inputs.state, binding.state)
          ? inputs.state[binding.state]
          : null
        : "page" in binding
          ? Object.hasOwn(inputs.pages, binding.page)
            ? inputs.pages[binding.page]
            : null
          : "data" in binding
            ? resolvePrototypeDataPointer(inputs.data, binding.data)
            : binding.value;
    return [name, (value ?? null) as PrototypeJson];
  });
  const context = Object.fromEntries(entries);
  if (Buffer.byteLength(JSON.stringify(context), "utf8") <= MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES) {
    return { context };
  }
  // Stop at the first overflowing entry, even if a later entry would fit.
  const prefix: [string, PrototypeJson][] = [];
  for (const entry of entries.sort(([left], [right]) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
  )) {
    prefix.push(entry);
    if (
      Buffer.byteLength(JSON.stringify(Object.fromEntries(prefix)), "utf8") >
      MAX_PROTOTYPE_EMIT_PAYLOAD_BYTES
    ) {
      prefix.pop();
      break;
    }
  }
  return { context: Object.fromEntries(prefix), contextTruncated: true };
}

/** Uses the shared action visitor, including actions on dialog/app-bar parts. */
export function prototypeEmitContextFields(spec: unknown): string[] {
  const expansion = expandPrototypeComponents(spec);
  if (!expansion.success) {
    return [];
  }
  const fields: string[] = [];
  function walk(value: unknown, path: string): void {
    const node = record(value);
    if (!node) {
      return;
    }
    mapBindableFields(node, path, (entry, at, kind) => {
      if (kind === "emitContext") {
        fields.push(at);
      }
      return entry;
    });
    for (const [key, child] of Object.entries(node)) {
      if (key === "child") {
        walk(child, `${path}.child`);
      }
      if (key === "children" && Array.isArray(child)) {
        child.forEach((entry, index) => walk(entry, `${path}.children[${index}]`));
      }
    }
  }
  walk(record(expansion.spec)?.root, "root");
  return fields.map(expansion.locate);
}
