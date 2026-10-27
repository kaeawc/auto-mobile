import { describe, expect, test } from "bun:test";
import {
  applyConnectionPresentationProfile,
  connectionPresentationUpdates,
  type ConnectionPresentationProfilePort,
} from "../../../src/daemon/proxy/ConnectionPresentationProfile";
import { DaemonUnavailableError } from "../../../src/daemon/client";
import { SET_TOOL_ENABLED_TOOL_NAME } from "../../../src/features/toolSelection/toolSelectionControl";
import {
  INTERNAL_ACTIONS_COMPACT_METADATA_PARAM,
  INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM,
} from "../../../src/daemon/wire/constants";
import { FakeDaemonClient } from "../../fakes/FakeDaemonClient";

class FakePort implements ConnectionPresentationProfilePort {
  profile: string | undefined;
  readonly remembered: Array<{ name: string; args: Record<string, unknown> }> = [];
  constructor(private readonly mintOnRemember: string | null = "profile-1") {}
  withToolSelectionProfile(args: Record<string, unknown>): Record<string, unknown> {
    return this.profile ? { ...args, profile: this.profile } : args;
  }
  rememberToolSelectionProfile(name: string, args: Record<string, unknown>): void {
    this.remembered.push({ name, args });
    this.profile = this.mintOnRemember ?? undefined;
  }
  hasToolSelectionProfile(): boolean {
    return Boolean(this.profile);
  }
}

describe("connectionPresentationUpdates", () => {
  test("returns nothing without options", () => {
    expect(connectionPresentationUpdates([], [], undefined, undefined)).toEqual([]);
  });

  test("emits enable then disable updates", () => {
    expect(connectionPresentationUpdates(["a"], ["b"], undefined, undefined)).toEqual([
      { toolNames: ["a"], enabled: true },
      { toolNames: ["b"], enabled: false },
    ]);
  });

  test("a presentation-only policy reaffirms setToolEnabled", () => {
    expect(connectionPresentationUpdates([], [], true, undefined)).toEqual([
      { toolNames: [SET_TOOL_ENABLED_TOOL_NAME], enabled: true },
    ]);
  });
});

describe("applyConnectionPresentationProfile", () => {
  test("makes no calls without options", async () => {
    const client = new FakeDaemonClient();
    await applyConnectionPresentationProfile(client, undefined, new FakePort());
    expect(client.callToolCalls).toEqual([]);
  });

  test("forwards each update with internal params and remembers the profile", async () => {
    const client = new FakeDaemonClient();
    const port = new FakePort();
    await applyConnectionPresentationProfile(
      client,
      {
        enabledTools: ["a"],
        toolResultsNoStructuredContent: true,
        actionsCompactMetadata: false,
      },
      port,
    );
    expect(client.callToolCalls).toEqual([
      {
        toolName: SET_TOOL_ENABLED_TOOL_NAME,
        params: {
          toolNames: ["a"],
          enabled: true,
          [INTERNAL_TOOL_RESULTS_NO_STRUCTURED_CONTENT_PARAM]: true,
          [INTERNAL_ACTIONS_COMPACT_METADATA_PARAM]: false,
        },
      },
    ]);
    expect(port.remembered).toHaveLength(1);
  });

  test("attaches the profile minted by an earlier update to the next", async () => {
    const client = new FakeDaemonClient();
    await applyConnectionPresentationProfile(
      client,
      { enabledTools: ["a"], disabledTools: ["b"] },
      new FakePort(),
    );
    expect(client.callToolCalls[0]?.params.profile).toBeUndefined();
    expect(client.callToolCalls[1]?.params.profile).toBe("profile-1");
  });

  test("throws when the daemon reports an error result", async () => {
    const client = new FakeDaemonClient({ toolResult: { isError: true, content: [] } });
    await expect(
      applyConnectionPresentationProfile(client, { enabledTools: ["a"] }, new FakePort()),
    ).rejects.toBeInstanceOf(DaemonUnavailableError);
  });

  test("throws when no profile is returned", async () => {
    const client = new FakeDaemonClient();
    await expect(
      applyConnectionPresentationProfile(client, { enabledTools: ["a"] }, new FakePort(null)),
    ).rejects.toThrow("did not return a connection profile");
  });
});
