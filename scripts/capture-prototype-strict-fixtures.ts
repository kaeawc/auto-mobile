import { applyPrototypeDataWrite } from "../src/features/prototype/prototypeDataWrite";
/** Capture strict differential fixtures from the real TS validator, never hand-authored paths. */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import contract from "../schemas/prototype-spec-contract.json";
import { object, type Rule } from "../src/features/prototype/prototypeBindingValidation";
import { requiredPrototypeCapabilities } from "../src/features/prototype/prototypeCapabilityGates";
import {
  validatePrototypeSpec,
  validatePrototypeSpecBytes,
} from "../src/features/prototype/prototypeValidation";
import type { PrototypeStrictOptions } from "../src/features/prototype/prototypeStrictPolicy";

const directory = join(import.meta.dir, "../test/fixtures/prototype-spec");
const definitions: Record<string, Rule> = contract.definitions;
const base = () => ({
  id: "strict",
  window: { placement: { type: "fullscreen" } },
  root: { type: "spacer" },
});
const save = (kind: string, name: string, value: unknown) =>
  writeFileSync(join(directory, kind, name + ".json"), JSON.stringify(value, null, 2) + "\n");
function capture(name: string, spec: unknown, options?: PrototypeStrictOptions): void {
  const result = validatePrototypeSpec(spec, options);
  if (result.success) {
    if (options) {
      throw new Error(`Expected policy rejection: ${name}`);
    }
    save("valid", name, spec);
  } else {
    save("invalid", name, {
      spec,
      ...(options ? { options } : {}),
      expectedPath: result.error.path,
    });
  }
}
function raw(name: string, rawJson: string): void {
  const result = validatePrototypeSpec(rawJson);
  if (result.success) {
    writeFileSync(join(directory, "valid", name + ".json"), rawJson + "\n");
  } else {
    save("invalid", name, { rawJson, expectedPath: result.error.path });
  }
}
function bytes(name: string, value: Uint8Array): void {
  const result = validatePrototypeSpecBytes(value);
  if (result.success) {
    throw new Error(`Expected invalid bytes: ${name}`);
  }
  save("invalid", name, {
    rawBytesBase64: Buffer.from(value).toString("base64"),
    expectedPath: result.error.path,
  });
}
const withRoot = (root: unknown) => ({ ...base(), root });
const request = (url: string, extra = {}) =>
  withRoot({ type: "button", label: "Go", onTap: [{ type: "request", url, ...extra }] });
for (const [name, token] of Object.entries({
  nan: "NaN",
  infinity: "Infinity",
  negativeInfinity: "-Infinity",
  overflow: "1e400",
  minusZero: "-0",
  unsafeInteger: "9007199254740993",
})) {
  raw(
    `strict-number-${name}`,
    JSON.stringify({ ...base(), state: { n: 0 } }).replace('"n":0', `"n":${token}`),
  );
}
raw("strict-lone-high-surrogate", JSON.stringify(base()).replace('"strict"', '"\\ud800"'));
raw("strict-lone-low-surrogate", JSON.stringify(base()).replace('"strict"', '"\\udfff"'));
raw("strict-literal-nul", JSON.stringify(base()).replace('"strict"', '"bad\0id"'));
raw("strict-deep-10000", "[".repeat(10000) + "0" + "]".repeat(10000));
raw("strict-bom", "\uFEFF" + JSON.stringify(base()));
raw(
  "strict-duplicate-envelope",
  JSON.stringify(base()).replace('"id":"strict"', '"id":"first","id":"strict"'),
);
raw(
  "strict-duplicate-escaped-key",
  JSON.stringify(base()).replace('"id":"strict"', '"id":"first","\\u0069d":"strict"'),
);
raw(
  "strict-duplicate-opaque",
  JSON.stringify({
    ...base(),
    root: { type: "spacer", onTap: [{ type: "emit", name: "a", payload: { k: 1 } }] },
  }).replace('"k":1', '"k":0,"k":1'),
);
for (const [name, value] of Object.entries({
  continuation: [0x80],
  overlong: [0xc0, 0x80],
  truncated: [0xe2, 0x82],
  surrogate: [0xed, 0xa0, 0x80],
})) {
  const json = JSON.stringify(base()),
    at = json.indexOf("strict");
  bytes(
    `strict-utf8-${name}`,
    new Uint8Array([
      ...Buffer.from(json.slice(0, at)),
      ...value,
      ...Buffer.from(json.slice(at + "strict".length)),
    ]),
  );
}
const surrogate = JSON.parse(
  readFileSync(join(directory, "invalid/surrogate-key.json"), "utf8"),
) as { spec?: unknown; rawJson?: string };
const surrogateJson = surrogate.rawJson ?? JSON.stringify(surrogate.spec);
const surrogateResult = validatePrototypeSpec(surrogateJson);
if (surrogateResult.success) {
  throw new Error("Accepted lone-surrogate key");
}
save("invalid", "surrogate-key", {
  rawJson: surrogateJson,
  expectedPath: surrogateResult.error.path,
});
for (const [name, id] of Object.entries({
  empty: "",
  max: "x".repeat(256),
  over: "x".repeat(257),
  nfc: "é",
  nfd: "e\u0301",
  bidi: "a\u202Eb",
  control: "a\u0001b",
  nul: "a\0b",
})) {
  capture(`strict-id-${name}`, { ...base(), id });
}
for (const key of ["__proto__", "constructor"]) {
  raw(`strict-reserved-top-${key}`, JSON.stringify(base()).replace('"id":', `"${key}":true,"id":`));
  raw(
    `strict-reserved-data-${key}`,
    JSON.stringify({ ...base(), data: JSON.parse(`{"${key}":"kept"}`) }),
  );
}
for (const [name, url] of Object.entries({
  userinfo: "https://user:pass@example.com/x",
  ipv6: "http://[::1]/",
  alternateIpv4: "http://0177.1/",
  uppercase: "HTTPS://example.com/",
  whitespace: " \thttps://example.com/\n",
  backslash: "https:\\\\example.com/x",
  templatedHost: "https://{host}/",
  invalid: "https://[::1",
  noAuthority: "https:///",
  javascript: "javascript:alert(1)",
})) {
  capture(`strict-url-${name}`, request(url));
}
for (const header of [
  "Host",
  "Connection",
  "Upgrade",
  "Transfer-Encoding",
  "Content-Length",
  "TE",
  "Trailer",
  "Keep-Alive",
  "Cookie",
  "Origin",
  "Expect",
  "Proxy-Authorization",
]) {
  capture(
    `strict-header-${header.toLowerCase()}`,
    request("https://example.com/", { headers: { [header]: "x" } }),
  );
}
for (const [name, value] of Object.entries({ cr: "a\rb", lf: "a\nb", crlf: "a\r\nb" })) {
  capture(
    `strict-header-${name}`,
    request("https://example.com/", { headers: { "X-Test": value } }),
  );
  capture(
    `strict-header-bound-${name}`,
    request("https://example.com/", { headers: { "X-Test": { value } } }),
  );
}
capture(
  "strict-library-system",
  { ...base(), window: { ...base().window, layer: "system" } },
  { library: true },
);
capture(
  "strict-library-persistent",
  { ...base(), window: { ...base().window, persistence: "device" } },
  { library: true },
);
for (const storage of [
  { version: 0, keys: [] },
  { version: "1", keys: [] },
  { version: 1, keys: "x" },
  { version: 1, keys: ["state:missing"] },
  { version: 1, keys: ["data:/a", "data:/a/b"] },
  { version: 2, keys: [] },
]) {
  capture(`strict-storage-${JSON.stringify(storage).replace(/[^a-zA-Z0-9]/g, "-")}`, {
    ...base(),
    storage,
  });
}

// The before/after specs are captured from an actual TS data write, which passes the data budget
// but makes repeat expansion exceed the node budget. Native runners consume the same result.
const rows = Array.from({ length: 127 }, (_, index) => ({ id: index }));
const beforeWrite = {
  ...base(),
  data: { rows },
  root: {
    type: "column",
    children: [
      {
        type: "column",
        repeat: { items: { path: "/rows" }, as: "row" },
        children: Array.from({ length: 15 }, () => ({ type: "spacer" })),
      },
      ...Array.from({ length: 93 }, () => ({ type: "spacer" })),
    ],
  },
};
capture("strict-data-write-node-boundary", beforeWrite);
const written = applyPrototypeDataWrite(beforeWrite.data, {
  op: "append",
  path: "/data/rows",
  value: { id: 127 },
});
if (!written.success) {
  throw new Error("Data write failed before tree validation");
}
capture("strict-data-write-node-plus-one", { ...beforeWrite, data: written.data });
for (const count of [64, 65]) {
  capture(`strict-storage-keys-${count}`, {
    ...base(),
    state: Object.fromEntries(Array.from({ length: count }, (_, index) => ["s" + index, false])),
    storage: { version: 1, keys: Array.from({ length: count }, (_, index) => "state:s" + index) },
  });
}
for (const plus of [0, 1]) {
  capture(`strict-storage-bytes-${plus ? "plus-one" : "boundary"}`, {
    ...base(),
    state: { a: "x".repeat(262144 - "state:a".length - 2 + plus) },
    storage: { version: 1, keys: ["state:a"] },
  });
  capture(`strict-storage-version-${plus ? "plus-one" : "boundary"}`, {
    ...base(),
    state: { a: false },
    storage: { version: 2147483647 + plus, keys: ["state:a"] },
  });
}

capture("strict-replacement-scalar", { ...base(), id: "�" });
capture("strict-storage-unknown", {
  ...base(),
  state: { a: false },
  storage: { version: 1, keys: ["state:a"], extra: true },
});
for (const plus of [0, 1]) {
  capture(`strict-data-bytes-${plus ? "plus-one" : "boundary"}`, {
    ...base(),
    data: { x: "x".repeat(262144 - 8 + plus) },
  });
  capture(
    `strict-payload-bytes-${plus ? "plus-one" : "boundary"}`,
    withRoot({
      type: "spacer",
      onTap: [{ type: "emit", name: "a", payload: "x".repeat(4096 - 2 + plus) }],
    }),
  );
  capture(`strict-data-array-${plus ? "plus-one" : "boundary"}`, {
    ...base(),
    data: { x: Array.from({ length: 500 + plus }, () => false) },
  });
  let condition: unknown = { key: "x", equals: true };
  for (let index = 1; index < 8 + plus; index++) {
    condition = { not: condition };
  }
  capture(`strict-condition-depth-${plus ? "plus-one" : "boundary"}`, {
    ...base(),
    state: { x: true },
    root: { type: "spacer", visibleWhen: condition },
  });
  let action: unknown = { type: "request", url: "https://example.com/" };
  for (let index = 1; index < 4 + plus; index++) {
    action = { type: "request", url: "https://example.com/", onSuccess: [action] };
  }
  capture(
    `strict-action-depth-${plus ? "plus-one" : "boundary"}`,
    withRoot({ type: "spacer", onTap: [action] }),
  );
}
const byteSpec = { ...base(), state: { x: "" } };
byteSpec.state.x = "x".repeat(
  1048576 - Buffer.byteLength(JSON.stringify(byteSpec, null, 2) + "\n"),
);
capture("strict-spec-bytes-boundary", byteSpec);
raw("strict-spec-bytes-plus-one", JSON.stringify(byteSpec, null, 2) + "\n ");

capture("strict-capabilities-opaque-sentinels", {
  ...base(),
  id: "{data:/ghost}",
  root: {
    type: "spacer",
    id: "{data:/ghost}",
    onTap: [
      {
        type: "emit",
        name: "{data:/ghost}",
        payload: { type: "chart", data: "/ghost", shimmer: true },
      },
    ],
  },
});
capture(
  "strict-capabilities-data-binding",
  withRoot({
    type: "spacer",
    onTap: [{ type: "setData", path: "/data/x", value: { data: "/y" } }],
  }),
);
capture(
  "strict-capabilities-malformed-placeholder",
  withRoot({ type: "text", text: "{data:not-a-pointer}" }),
);

// Cover every observed strict object rule and each primitive/collection bound from the contract.
// Edits are made on validated copies and their actual verdict determines the fixture directory.
type Step = string | number;
function at(root: unknown, path: Step[]): unknown {
  let value = root;
  for (const key of path) {
    value =
      typeof key === "number" && Array.isArray(value) ? value[key] : object(value)?.[String(key)];
  }
  return value;
}
function replace(root: unknown, path: Step[], value: unknown): unknown {
  if (!path.length) {
    return value;
  }
  const copy: unknown = structuredClone(root),
    parent = at(copy, path.slice(0, -1)),
    key = path.at(-1)!;
  if (typeof key === "number" && Array.isArray(parent)) {
    parent[key] = value;
  } else {
    const fields = object(parent);
    if (!fields) {
      throw new Error("Invalid path");
    }
    fields[String(key)] = value;
  }
  return copy;
}
const seenObjects = new Set<string>(),
  seenBounds = new Set<string>();
let objectIndex = 0,
  boundIndex = 0;
function walk(spec: unknown, value: unknown, rule: Rule, path: Step[], name: string): void {
  if (rule.kind === "ref") {
    walk(spec, value, definitions[rule.name ?? ""], path, rule.name ?? name);
    return;
  }
  if (rule.kind === "tagged") {
    const type = object(value)?.type;
    if (typeof type === "string" && rule.variants?.[type]) {
      walk(spec, value, rule.variants[type], path, `${name}-${type}`);
    }
    return;
  }
  const fields = object(value);
  if (rule.kind === "object" && fields) {
    const signature = JSON.stringify(rule);
    if (!seenObjects.has(signature)) {
      seenObjects.add(signature);
      capture(
        `strict-unknown-${String(++objectIndex).padStart(3, "0")}-${name}`,
        replace(spec, path, { ...fields, zzzUnknown: true }),
      );
    }
    for (const [key, field] of Object.entries(rule.fields ?? {})) {
      if (field && Object.hasOwn(fields, key)) {
        walk(spec, fields[key], field.rule, [...path, key], name + "-" + key);
      }
    }
  } else if (rule.kind === "array" && Array.isArray(value)) {
    for (const [index, child] of value.entries()) {
      walk(spec, child, rule.item ?? { kind: "json" }, [...path, index], name);
    }
  } else if (["map", "screenMap", "record"].includes(rule.kind) && fields) {
    for (const [key, child] of Object.entries(fields)) {
      walk(spec, child, rule.item ?? { kind: "json" }, [...path, key], name);
    }
  } else if (rule.kind === "choice") {
    for (const option of rule.options ?? []) {
      if (
        (option.kind === "object" && fields) ||
        (option.kind === "array" && Array.isArray(value)) ||
        (option.kind === "string" && typeof value === "string") ||
        (option.kind === "number" && typeof value === "number")
      ) {
        walk(spec, value, option, path, name);
        break;
      }
    }
  }
  if (rule.max !== undefined && ["number", "string", "array"].includes(rule.kind)) {
    const signature = `${rule.kind}-${rule.min}-${rule.max}-${rule.integer}`;
    if (seenBounds.has(signature)) {
      return;
    }
    seenBounds.add(signature);
    const index = ++boundIndex;
    for (const plus of [0, 1]) {
      const count = rule.max + plus;
      if (count > 300000) {
        continue;
      }
      const modified =
        rule.kind === "number"
          ? count
          : rule.kind === "string"
            ? "x".repeat(count)
            : Array.from({ length: count }, () =>
                Array.isArray(value) && value.length ? value[0] : "x",
              );
      capture(
        `strict-bound-${String(index).padStart(3, "0")}-${name}-${plus ? "plus-one" : "boundary"}`,
        replace(spec, path, modified),
      );
    }
  }
}
const originalValid = readdirSync(join(directory, "valid"))
  .filter((name) => name.endsWith(".json") && !name.startsWith("strict-"))
  .sort();
for (const name of originalValid) {
  const result = validatePrototypeSpec(readFileSync(join(directory, "valid", name), "utf8"));
  if (!result.success) {
    throw new Error(name);
  }
  walk(result.data, result.data, definitions.spec, [], "spec");
}
const capabilityExamples = new Map<string, unknown>();
for (const name of readdirSync(join(directory, "valid"))
  .filter((file) => file.endsWith(".json"))
  .sort()) {
  const spec: unknown = JSON.parse(
    readFileSync(join(directory, "valid", name), "utf8").replace(/^\uFEFF/, ""),
  );
  for (const capability of requiredPrototypeCapabilities(spec)) {
    if (!capabilityExamples.has(capability)) {
      capabilityExamples.set(capability, spec);
    }
  }
}
for (const [capability, spec] of capabilityExamples) {
  capture(`strict-gate-${capability}`, spec, {
    supportedCapabilities: requiredPrototypeCapabilities(spec).filter(
      (name) => name !== capability,
    ),
  });
}
const valid = readdirSync(join(directory, "valid"))
  .filter((name) => name.endsWith(".json"))
  .sort();
const invalid = readdirSync(join(directory, "invalid"))
  .filter((name) => name.endsWith(".json"))
  .sort();
const validCapabilities = Object.fromEntries(
  valid.map((name) => {
    const result = validatePrototypeSpec(readFileSync(join(directory, "valid", name), "utf8"));
    if (!result.success) {
      throw new Error(name + JSON.stringify(result.error));
    }
    return [name, requiredPrototypeCapabilities(result.data)];
  }),
);
writeFileSync(
  join(directory, "corpus.json"),
  JSON.stringify({ valid, invalid, validCapabilities }, null, 2) + "\n",
);
console.log(
  `Captured ${valid.length} valid, ${invalid.length} invalid; ${seenObjects.size} object rules, ${seenBounds.size} bounds, ${capabilityExamples.size} gates`,
);
