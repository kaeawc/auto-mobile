import type {
  CtrlProxyNode,
  IosRunnerWireHierarchy,
  IosRunnerWireNode,
  XCTestHierarchy,
} from "../../src/features/observe/ios/types";

function decodeNode(wire: IosRunnerWireNode): CtrlProxyNode {
  const {
    bounds,
    node,
    "content-desc": contentDesc,
    "resource-id": resourceId,
    "view-id": viewId,
    "test-tag": testTag,
    "accessibility-focused": accessibilityFocused,
    "long-clickable": longClickable,
    "state-description": stateDescription,
    "error-message": errorMessage,
    "hint-text": hintText,
    ...rest
  } = wire;
  const children = node === undefined ? undefined : [node].flat().map(decodeNode);
  return {
    ...rest,
    bounds: bounds && { left: bounds[0], top: bounds[1], right: bounds[2], bottom: bounds[3] },
    contentDesc,
    resourceId,
    viewId,
    testTag,
    accessibilityFocused,
    longClickable,
    stateDescription,
    errorMessage,
    hintText,
    node: Array.isArray(node) ? children : children?.[0],
  };
}

/** Decodes the runner's wire spelling (dashed keys, tuple bounds) into the in-memory model. */
export function decodeRunnerWireHierarchy(wire: IosRunnerWireHierarchy): XCTestHierarchy {
  return { ...wire, hierarchy: decodeNode(wire.hierarchy) };
}
