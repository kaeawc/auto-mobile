import contract from "../../../schemas/prototype-spec-contract.json";
import { isPrototypeDataPointer, prototypeDataPointerTokens } from "./prototypeData";
import type { PrototypeJson } from "./prototypeSpec";
import { record, STATE_KEY, type Raw } from "./prototypeTemplate";
import type { PrototypeValidationError } from "./prototypeValidation";

export const { MAX_PROTOTYPE_PATCH_OPS } = contract.limits;

export type PrototypePatchOp =
  | { op: "add" | "replace" | "test"; path: string; value: PrototypeJson }
  | { op: "remove"; path: string }
  | { op: "replaceNode"; id: string; node: Record<string, unknown> };

export interface PrototypePatchOptions {
  /** `skip`: a `/state` test checks structure and key existence only (host copy is not authoritative). */
  stateTests?: "evaluate" | "skip";
}

export type PrototypePatchResult =
  | { success: true; spec: Record<string, unknown> }
  | { success: false; error: PrototypeValidationError };

type Error = PrototypeValidationError | undefined;
type DataOp = Exclude<PrototypePatchOp, { op: "replaceNode" }>;

function own(object: Raw, key: string): unknown {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

function put(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    value: structuredClone(value),
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function error(path: string, message: string): PrototypeValidationError {
  return { path, message };
}

/** JSON equality ignores object order and compares numbers by value, including negative zero. */
function equal(left: unknown, right: unknown): boolean {
  if (left === right) {
    return true;
  }
  if (Array.isArray(left)) {
    return (
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => equal(value, right[index]))
    );
  }
  const a = record(left);
  const b = record(right);
  return (
    !!a &&
    !!b &&
    Object.keys(a).length === Object.keys(b).length &&
    Object.keys(a).every((key) => Object.hasOwn(b, key) && equal(own(a, key), own(b, key)))
  );
}

function opShape(value: unknown, path: string): Error {
  const object = record(value);
  if (!object) {
    return error(path, "Expected object");
  }
  const name = own(object, "op");
  if (
    typeof name !== "string" ||
    !["add", "replace", "remove", "test", "replaceNode"].includes(name)
  ) {
    return error(`${path}.op`, "Unknown or missing op");
  }
  const required =
    name === "replaceNode" ? ["id", "node"] : name === "remove" ? ["path"] : ["path", "value"];
  const unknown = Object.keys(object)
    .filter((key) => !["op", ...required].includes(key))
    .sort(compareMemberNames)[0];
  if (unknown !== undefined) {
    return error(`${path}.${unknown}`, "Unknown property");
  }
  const missing = required.find((key) => !Object.hasOwn(object, key));
  if (missing !== undefined) {
    return error(`${path}.${missing}`, "Required property");
  }
  return opTypes(object, path);
}

/** Compare Unicode code points rather than UTF-16 code units for cross-language ordering. */
function compareMemberNames(a: string, b: string): number {
  const left = Array.from(a, (char) => char.codePointAt(0) ?? 0);
  const right = Array.from(b, (char) => char.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) {
      return left[i] - right[i];
    }
  }
  return left.length - right.length;
}

function opTypes(op: Raw, path: string): Error {
  if (own(op, "op") !== "replaceNode") {
    return typeof own(op, "path") === "string"
      ? undefined
      : error(`${path}.path`, "Expected string");
  }
  const id = own(op, "id");
  if (typeof id !== "string" || id === "") {
    return error(`${path}.id`, "Expected string");
  }
  return record(own(op, "node")) ? undefined : error(`${path}.node`, "Expected object");
}

function pathError(path: string, at: string): Error {
  const prefix = path.split("/")[1];
  if (["root", "window", "theme"].includes(prefix) && path.startsWith("/")) {
    return error(
      `${at}.path`,
      "Not patchable: use show for window, theme and root changes, or replaceNode for one node",
    );
  }
  const suffix = path.slice(prefix === "data" ? 5 : 6);
  if (
    (prefix === "data" || prefix === "state") &&
    (suffix === "" || isPrototypeDataPointer(suffix)) &&
    path.startsWith("/")
  ) {
    return;
  }
  return error(`${at}.path`, "Patch paths start with /data or /state");
}

function scalar(value: unknown): boolean {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

/** A bound page write clamps before control validation; ordinary state writes are unchanged. */
function pagerStateValue(spec: Raw, key: string, value: unknown): unknown {
  const root = record(spec.root);
  if (!root || typeof value !== "number" || !Number.isInteger(value)) {
    return value;
  }
  for (const { node } of tree({
    node: root,
    path: "root",
    parent: spec,
    key: "root",
    insideRepeat: false,
  })) {
    if (
      node.type === "pager" &&
      node.stateKey === key &&
      Array.isArray(node.children) &&
      node.children.length
    ) {
      return Math.min(Math.max(value, 0), node.children.length - 1);
    }
  }
  return value;
}

function applyState(spec: Raw, op: DataOp, at: string, skip: boolean): Error {
  const tokens = prototypeDataPointerTokens(op.path.slice(6));
  if (tokens.length !== 1) {
    return error(`${at}.path`, "State patches address one key: /state/<key>");
  }
  const key = tokens[0];
  if (!STATE_KEY.test(key)) {
    return error(`${at}.path`, "Invalid state key");
  }
  if (op.op !== "remove" && !scalar(op.value)) {
    return error(`${at}.value`, "Invalid scalar value");
  }
  const state = record(own(spec, "state")) ?? {};
  if (op.op !== "add" && !Object.hasOwn(state, key)) {
    return error(`${at}.path`, "Path does not exist");
  }
  if (op.op === "test") {
    return skip || equal(own(state, key), op.value)
      ? undefined
      : error(`${at}.value`, "Test failed");
  }
  if (op.op === "remove") {
    delete state[key];
  } else {
    put(state, key, pagerStateValue(spec, key, op.value));
  }
  // The key was written into the working copy; retain the state object even when empty.
  Object.defineProperty(spec, "state", {
    value: state,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

function index(token: string, length: number, add: boolean): number | undefined {
  if (add && token === "-") {
    return length;
  }
  if (!/^(?:0|[1-9][0-9]*)$/.test(token)) {
    return;
  }
  const number = Number(token);
  return number < length || (add && number === length) ? number : undefined;
}

function descend(value: unknown, token: string): unknown {
  if (Array.isArray(value)) {
    const i = index(token, value.length, false);
    return i === undefined ? undefined : value[i];
  }
  const object = record(value);
  return object ? own(object, token) : undefined;
}

function applyMember(parent: Raw, key: string, op: DataOp, at: string): Error {
  if (op.op !== "add" && !Object.hasOwn(parent, key)) {
    return error(`${at}.path`, "Path does not exist");
  }
  if (op.op === "test") {
    return equal(own(parent, key), op.value) ? undefined : error(`${at}.value`, "Test failed");
  }
  if (op.op === "remove") {
    delete parent[key];
  } else {
    put(parent, key, op.value);
  }
}

function applyArray(parent: unknown[], token: string, op: DataOp, at: string): Error {
  const i = index(token, parent.length, op.op === "add");
  if (i === undefined) {
    return error(`${at}.path`, "Path does not exist");
  }
  switch (op.op) {
    case "test":
      return equal(parent[i], op.value) ? undefined : error(`${at}.value`, "Test failed");
    case "add":
      parent.splice(i, 0, structuredClone(op.value));
      break;
    case "replace":
      put(parent, String(i), op.value);
      break;
    case "remove":
      parent.splice(i, 1);
      break;
  }
}

function applyData(spec: Raw, op: DataOp, at: string): Error {
  const tokens = prototypeDataPointerTokens(op.path.slice(5));
  if (!tokens.length) {
    return applyMember(spec, "data", op, at);
  }
  let parent = own(spec, "data");
  for (const token of tokens.slice(0, -1)) {
    parent = descend(parent, token);
  }
  const key = tokens[tokens.length - 1];
  if (Array.isArray(parent)) {
    return applyArray(parent, key, op, at);
  }
  const object = record(parent);
  return object ? applyMember(object, key, op, at) : error(`${at}.path`, "Path does not exist");
}

interface TreeNode {
  node: Raw;
  path: string;
  parent: Raw | unknown[];
  key: string;
  insideRepeat: boolean;
}

function adaptiveTreeEntries(current: TreeNode, insideRepeat: boolean): TreeNode[] {
  if (current.node.type !== "adaptive") {
    return [];
  }
  return ["list", "detail", "content", "main", "supporting"].flatMap((key) => {
    const node = record(own(current.node, key));
    return node
      ? [{ node, path: `${current.path}.${key}`, parent: current.node, key, insideRepeat }]
      : [];
  });
}

function* tree(entry: TreeNode): Generator<TreeNode> {
  const stack = [entry];
  while (stack.length) {
    const current = stack.pop()!;
    yield current;
    const insideRepeat = current.insideRepeat || Object.hasOwn(current.node, "repeat");
    const childrenValue = own(current.node, "children");
    const children = Array.isArray(childrenValue) ? childrenValue : [];
    for (let i = children.length - 1; i >= 0; i--) {
      const node = record(children[i]);
      if (node) {
        stack.push({
          node,
          path: `${current.path}.children[${i}]`,
          parent: children,
          key: String(i),
          insideRepeat,
        });
      }
    }
    const screens = record(own(current.node, "screens"));
    for (const [key, value] of Object.entries(screens ?? {}).reverse()) {
      const node = record(value);
      if (node && screens) {
        stack.push({
          node,
          path: `${current.path}.screens[${JSON.stringify(key)}]`,
          parent: screens,
          key,
          insideRepeat,
        });
      }
    }
    stack.push(...adaptiveTreeEntries(current, insideRepeat));
    const child = record(own(current.node, "child"));
    if (child) {
      stack.push({
        node: child,
        path: `${current.path}.child`,
        parent: current.node,
        key: "child",
        insideRepeat,
      });
    }
  }
}

function replacementError(op: Extract<PrototypePatchOp, { op: "replaceNode" }>, at: string): Error {
  if (own(op.node, "id") !== op.id) {
    return error(`${at}.node.id`, "Replacement must keep the same id");
  }
  for (const { node, path } of tree({
    node: op.node,
    path: `${at}.node`,
    parent: {},
    key: "node",
    insideRepeat: false,
  })) {
    if (own(node, "type") === "use") {
      return error(
        `${path}.type`,
        "Components are not expanded in a patch: inline the node or use show",
      );
    }
    const anchor = record(own(node, "anchor"));
    if (anchor && own(anchor, "type") === "element") {
      return error(
        `${path}.anchor.type`,
        "Element anchors are resolved by show: use a bounds anchor or use show",
      );
    }
  }
}

function replaceNode(
  spec: Raw,
  op: Extract<PrototypePatchOp, { op: "replaceNode" }>,
  at: string,
): Error {
  const invalid = replacementError(op, at);
  if (invalid) {
    return invalid;
  }
  const root = record(own(spec, "root"));
  const nodes = root
    ? [...tree({ node: root, path: "root", parent: spec, key: "root", insideRepeat: false })]
    : [];
  const matches = nodes.filter(({ node }) => own(node, "id") === op.id);
  if (!matches.length) {
    return error(`${at}.id`, "Unknown node id");
  }
  if (matches.length > 1) {
    return error(`${at}.id`, "Node id is not unique");
  }
  const match = matches[0];
  if (match.node === root) {
    return error(`${at}.id`, "The root cannot be replaced: use show");
  }
  if (match.insideRepeat) {
    return error(
      `${at}.id`,
      "A node inside a repeat cannot be replaced: replace the repeating node",
    );
  }
  put(match.parent, match.key, op.node);
}

/** Pure: never mutates `spec` or `ops`; the first error in op order wins and nothing is applied. */
export function applyPrototypePatch(
  spec: unknown,
  ops: unknown,
  options?: PrototypePatchOptions,
): PrototypePatchResult {
  const object = record(spec);
  if (!object) {
    return { success: false, error: error("$", "Expected object") };
  }
  if (!Array.isArray(ops)) {
    return { success: false, error: error("ops", "Expected array") };
  }
  if (!ops.length || ops.length > MAX_PROTOTYPE_PATCH_OPS) {
    return { success: false, error: error("ops", "Array length out of range") };
  }
  const copy = structuredClone(object);
  for (let i = 0; i < ops.length; i++) {
    const at = `ops[${i}]`;
    const shape = opShape(ops[i], at);
    if (shape) {
      return { success: false, error: shape };
    }
    // Shape validation above checks every member required by this discriminated union.
    const op = ops[i] as PrototypePatchOp;
    const invalid = applyOp(copy, op, at, options?.stateTests === "skip");
    if (invalid) {
      return { success: false, error: invalid };
    }
  }
  return { success: true, spec: copy };
}

function applyOp(spec: Raw, op: PrototypePatchOp, at: string, skip: boolean): Error {
  if (op.op === "replaceNode") {
    return replaceNode(spec, op, at);
  }
  const invalid = pathError(op.path, at);
  if (invalid) {
    return invalid;
  }
  return op.path.startsWith("/state") ? applyState(spec, op, at, skip) : applyData(spec, op, at);
}

/** True when any op addresses `/state`; callers require `baseRevision` then. */
export function prototypePatchTouchesState(ops: unknown): boolean {
  return (
    Array.isArray(ops) &&
    ops.some((value) => {
      const op = record(value);
      const path = op ? own(op, "path") : undefined;
      return typeof path === "string" && (path === "/state" || path.startsWith("/state/"));
    })
  );
}

/** The `/data` paths the ops address; `replaceNode` and `/state` ops touch none. */
export function prototypePatchDataPaths(ops: unknown): string[] {
  return Array.isArray(ops)
    ? ops.flatMap((value) => {
        const op = record(value);
        const path = op ? own(op, "path") : undefined;
        return typeof path === "string" && (path === "/data" || path.startsWith("/data/"))
          ? [path]
          : [];
      })
    : [];
}
