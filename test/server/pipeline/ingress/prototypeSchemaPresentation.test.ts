import { beforeAll, describe, expect, test } from "bun:test";
import committedDefinitionsJson from "../../../../schemas/tool-definitions.json";
import { InMemoryToolSelectionProfileRegistry } from "../../../../src/daemon/InMemoryToolSelectionProfileRegistry";
import { connectionPresentationOptions } from "../../../../src/daemon/mcpProxy/ProxyContracts";
import {
  applyConnectionPresentationProfile,
  type ConnectionPresentationProfilePort,
} from "../../../../src/daemon/proxy/ConnectionPresentationProfile";
import {
  getStaticToolDefinitions,
  type PrototypeFullSchemaFlag,
} from "../../../../src/daemon/staticToolDefinitions";
import { INTERNAL_PROTOTYPE_FULL_SCHEMA_PARAM } from "../../../../src/daemon/wire/constants";
import { parseCallContext } from "../../../../src/server/pipeline/ingress/callContext";
import {
  rememberPrototypeFullSchema,
  resolvePrototypeFullSchema,
} from "../../../../src/server/pipeline/ingress/connectionPresentation";
import {
  type PrototypeSpecSchemaInliner,
  specSchemaInliner,
  withConnectionPrototypeSchema,
} from "../../../../src/server/pipeline/ingress/prototypeSchemaPresentation";
import { FakeDaemonClient } from "../../../fakes/FakeDaemonClient";

interface Definition {
  name: string;
  inputSchema: Record<string, unknown>;
}

const committedDefinitions = committedDefinitionsJson as Definition[];
const PROFILE = "profile-1";

class FakeFlag implements PrototypeFullSchemaFlag {
  constructor(private readonly enabled: boolean) {}
  isEnabled(): boolean {
    return this.enabled;
  }
}

/** Marks the schema instead of converting the 56k-token spec contract. */
class FakeInliner implements PrototypeSpecSchemaInliner {
  calls = 0;
  inline(inputSchema: Record<string, unknown>): Record<string, unknown> {
    this.calls++;
    return { ...inputSchema, inlined: true };
  }
}

class FakePort implements ConnectionPresentationProfilePort {
  profile: string | undefined;
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown> {
    return args;
  }
  rememberToolSelectionProfile(): void {
    this.profile = PROFILE;
  }
  hasToolSelectionProfile(): boolean {
    return this.profile !== undefined;
  }
}

const TERSE: Definition = { name: "prototype", inputSchema: { form: "terse" } };
const FULL: Definition = { name: "prototype", inputSchema: { form: "full" } };
const OTHER: Definition = { name: "observe", inputSchema: { form: "observe" } };

/**
 * One connection end to end with fakes: the client proxy materializes its presentation profile on
 * the daemon, the daemon parses the forwarded call and stores the request, then lists tools for
 * that connection. The daemon's registry lists the form its own flag selects.
 */
async function listForConnection(clientFlag: boolean, daemonFlag: boolean) {
  const client = new FakeDaemonClient();
  await applyConnectionPresentationProfile(
    client,
    connectionPresentationOptions({ prototypeFullSchemaFlag: new FakeFlag(clientFlag) }),
    new FakePort(),
  );
  const registry = new InMemoryToolSelectionProfileRegistry();
  for (const call of client.callToolCalls) {
    const context = parseCallContext(call.params, {
      daemonMode: true,
      acceptanceDiscoveryCapability: undefined,
    });
    rememberPrototypeFullSchema(registry, PROFILE, context.requestedPrototypeFullSchema);
  }
  const daemonDefault = new FakeFlag(daemonFlag);
  const inliner = new FakeInliner();
  const registryListing = [daemonFlag ? FULL : TERSE, OTHER];
  const listed = withConnectionPrototypeSchema(
    registryListing,
    resolvePrototypeFullSchema(registry, PROFILE, daemonDefault.isEnabled()),
    { daemonDefault, inliner },
  );
  return { client, listed, registryListing, inliner };
}

describe("per-connection AUTOMOBILE_PROTOTYPE_FULL_SCHEMA (#17723)", () => {
  test("client without the flag, daemon without it: the listing is untouched and nothing is sent", async () => {
    const { client, listed, registryListing, inliner } = await listForConnection(false, false);
    expect(client.callToolCalls).toEqual([]);
    expect(listed).toBe(registryListing);
    expect(inliner.calls).toBe(0);
  });

  test("client with the flag, daemon without it: this connection gets the full schema", async () => {
    const { client, listed, inliner } = await listForConnection(true, false);
    expect(client.callToolCalls).toHaveLength(1);
    expect(client.callToolCalls[0]?.params[INTERNAL_PROTOTYPE_FULL_SCHEMA_PARAM]).toBe(true);
    expect(listed).toEqual([
      { name: "prototype", inputSchema: { form: "terse", inlined: true } },
      OTHER,
    ]);
    expect(listed[1]).toBe(OTHER);
    expect(inliner.calls).toBe(1);
  });

  test("client without the flag, daemon with it: the daemon's full schema is served", async () => {
    const { listed, registryListing, inliner } = await listForConnection(false, true);
    expect(listed).toBe(registryListing);
    expect(listed[0]).toBe(FULL);
    expect(inliner.calls).toBe(0);
  });

  test("client with the flag, daemon with it: the daemon's full schema is not re-inlined", async () => {
    const { listed, registryListing, inliner } = await listForConnection(true, true);
    expect(listed).toBe(registryListing);
    expect(inliner.calls).toBe(0);
  });

  test("another connection on the same daemon keeps its own choice", () => {
    const registry = new InMemoryToolSelectionProfileRegistry();
    rememberPrototypeFullSchema(registry, "flagged", true);
    expect(resolvePrototypeFullSchema(registry, "flagged", false)).toBe(true);
    expect(resolvePrototypeFullSchema(registry, "plain", false)).toBe(false);
    expect(resolvePrototypeFullSchema(registry, undefined, false)).toBe(false);
    expect(resolvePrototypeFullSchema(registry, "plain", true)).toBe(true);
  });
});

describe("the production inliner", () => {
  const committedPrototype = committedDefinitions.find((tool) => tool.name === "prototype")!;
  let inlined: Record<string, unknown>;
  beforeAll(() => {
    // The first inline converts the spec contract; keep that out of the timed tests.
    inlined = specSchemaInliner.inline(committedPrototype.inputSchema);
  });

  test("with both flags unset every definition is byte-identical to the committed file", () => {
    const listed = withConnectionPrototypeSchema(committedDefinitions, false, {
      daemonDefault: new FakeFlag(false),
      inliner: specSchemaInliner,
    });
    expect(JSON.stringify(listed)).toBe(JSON.stringify(committedDefinitions));
  });

  test("the connected full schema matches the proxy's cold full schema", () => {
    const coldFull = getStaticToolDefinitions(new FakeFlag(true)).find(
      (tool) => tool.name === "prototype",
    )!;
    expect(JSON.stringify(inlined)).toBe(JSON.stringify(coldFull.inputSchema));
    expect(JSON.stringify(inlined)).toContain('"$ref":"#/properties/spec/properties/root"');
  });

  test("inlining is cached per source schema and leaves the source untouched", () => {
    expect(specSchemaInliner.inline(committedPrototype.inputSchema)).toBe(inlined);
    expect(JSON.stringify(committedPrototype.inputSchema)).not.toContain("$ref");
  });
});
