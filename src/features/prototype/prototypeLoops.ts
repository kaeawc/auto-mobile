import { z } from "zod";
import contract from "../../../schemas/prototype-spec-contract.json";
import { walkPrototypeNodes } from "./prototypeNodeChildren";
import { record, type Raw } from "./prototypeTemplate";

export const MAX_PROTOTYPE_LOOPS = contract.limits.MAX_PROTOTYPE_LOOPS;
export { PROTOTYPE_LOOPS_CAPABILITY } from "../observe/android/ctrlProxyProtocol/capabilities";
export const prototypeLoopSchema = z
  .object({
    effect: z.enum(["pulse", "spin"]),
    periodMs: z.number().finite().int().min(400).max(4000),
    iterations: z
      .union([z.literal("infinite"), z.number().finite().int().min(1).max(20)])
      .optional(),
  })
  .strict();

/** Counts authored attention loops, excluding shimmer, with the same budget on repeat expansion. */
export function chargeLoopNode(node: Raw, counter: { loops?: number }, path: string) {
  if (node.loop === undefined) {
    return undefined;
  }
  counter.loops = (counter.loops ?? 0) + 1;
  return counter.loops > MAX_PROTOTYPE_LOOPS
    ? { path: `${path}.loop`, message: "Loop node limit exceeded" }
    : undefined;
}

/** An authored transform must not displace the loop's identity rest pose. */
export function prototypeLoopsError(nodes: readonly { value: Raw; path: string }[]) {
  for (const { value, path } of nodes) {
    const effect = record(value.loop)?.effect;
    if (effect !== "pulse" && effect !== "spin") {
      continue;
    }
    const field = effect === "pulse" ? "scale" : "rotation";
    const styles = [
      value.style,
      ...(Array.isArray(value.styleWhen)
        ? value.styleWhen.map((entry) => record(entry)?.style)
        : []),
    ];
    if (styles.some((style) => record(style)?.[field] !== undefined)) {
      return { path: `${path}.loop`, message: `${effect} loop cannot set style.${field}` };
    }
  }
  return undefined;
}
export function prototypeLoopFields(spec: unknown): string[] {
  const fields: string[] = [];
  walkPrototypeNodes(spec, (node, path) => {
    if (node.loop !== undefined) {
      fields.push(`${path}.loop`);
    }
  });
  return fields;
}
export function prototypeLoopsUnsupportedMessage(
  fields: readonly string[],
  platform: "android" | "ios",
): string {
  return `The connected ${platform === "ios" ? "iOS prototype agent" : "CtrlProxy"} does not advertise prototype_loops_v1, required by ${fields[0]}. Nothing was shown. Attention loops currently require an updated Android CtrlProxy.`;
}
