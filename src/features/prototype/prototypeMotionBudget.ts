import { chargeKeyframeNode } from "./prototypeKeyframes";
import { chargeLoopNode } from "./prototypeLoops";

/** Shared by the structural walk and the repeat-expanded walk, with traversal-local counters. */
export function chargeMotionNode(
  node: Record<string, unknown>,
  counter: { keyframeNodes: number; loops?: number },
  limits: { MAX_PROTOTYPE_KEYFRAME_NODES: number },
  path: string,
) {
  return chargeKeyframeNode(node, counter, limits, path) ?? chargeLoopNode(node, counter, path);
}
