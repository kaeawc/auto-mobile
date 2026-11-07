import { chargeKeyframeNode } from "./prototypeKeyframes";
import { chargeLoopNode } from "./prototypeLoops";
import { chargeVideoNode } from "./prototypeMediaSchema";

/** Shared by the structural walk and the repeat-expanded walk, with traversal-local counters. */
export function chargeMotionNode(
  node: Record<string, unknown>,
  counter: { keyframeNodes: number; videoNodes: number; loops?: number },
  limits: { MAX_PROTOTYPE_KEYFRAME_NODES: number },
  path: string,
) {
  return (
    chargeKeyframeNode(node, counter, limits, path) ??
    chargeLoopNode(node, counter, path) ??
    chargeVideoNode(node, counter, path)
  );
}
