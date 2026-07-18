import { beforeEach, describe, expect, test } from "bun:test";
import { runVouchGate, type GitHubIssueClient } from "../../../src/features/vouch/VouchGitHubRunner";
import type { VouchStateStore } from "../../../src/features/vouch/FileVouchStore";
import { VouchEngine } from "../../../src/features/vouch/VouchEngine";
import { emptyVouchState, type VouchState } from "../../../src/features/vouch/types";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

class InMemoryStore implements VouchStateStore {
  constructor(public state: VouchState = emptyVouchState()) {}
  async load(): Promise<VouchState> {
    return this.state;
  }
  async save(state: VouchState): Promise<void> {
    this.state = state;
  }
}

class FakeClient implements GitHubIssueClient {
  labelsAdded: Array<[number, string]> = [];
  labelsRemoved: Array<[number, string]> = [];
  comments: Array<[number, string]> = [];
  closed: number[] = [];
  async addLabel(n: number, l: string) {
    this.labelsAdded.push([n, l]);
  }
  async removeLabel(n: number, l: string) {
    this.labelsRemoved.push([n, l]);
  }
  async comment(n: number, b: string) {
    this.comments.push([n, b]);
  }
  async close(n: number) {
    this.closed.push(n);
  }
}

describe("runVouchGate", () => {
  let engine: VouchEngine;
  let store: InMemoryStore;
  let client: FakeClient;

  beforeEach(() => {
    engine = new VouchEngine({ timer: new FakeTimer(), idGenerator: new CountingIdGenerator("tok") });
    store = new InMemoryStore();
    engine.seedMember(store.state, "owner", "founder");
    client = new FakeClient();
  });

  test("gates an unknown actor opening an issue (advisory: comment + label, no close)", async () => {
    const result = await runVouchGate({
      eventName: "issues",
      payload: { action: "opened", issue: { number: 7, user: { login: "stranger" } } },
      store,
      engine,
      client,
      enforce: false,
    });
    expect(result.handled).toBe(true);
    expect(client.labelsAdded).toEqual([[7, "needs-vouch"]]);
    expect(client.comments[0]![1]).toContain("not yet vouched");
    expect(client.closed).toEqual([]);
  });

  test("closes an unknown actor's issue when enforcing", async () => {
    await runVouchGate({
      eventName: "pull_request_target",
      payload: { action: "opened", pull_request: { number: 9, user: { login: "stranger" } } },
      store,
      engine,
      client,
      enforce: true,
    });
    expect(client.closed).toEqual([9]);
  });

  test("allows a known member and clears the gate label", async () => {
    await runVouchGate({
      eventName: "issues",
      payload: { action: "opened", issue: { number: 3, user: { login: "Owner" } } },
      store,
      engine,
      client,
      enforce: true,
    });
    expect(client.labelsRemoved).toEqual([[3, "needs-vouch"]]);
    expect(client.labelsAdded).toEqual([]);
    expect(client.closed).toEqual([]);
  });

  test("`/vouch admit` from a member vouches the target in and persists", async () => {
    await runVouchGate({
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 4, user: { login: "stranger" } },
        comment: { body: "/vouch admit @stranger", user: { login: "owner" } },
      },
      store,
      engine,
      client,
      enforce: false,
    });
    expect(store.state.members.get("stranger")!.status).toBe("active");
    expect(client.comments[0]![1]).toContain("vouched in");
  });

  test("`/vouch admit` from a non-member is rejected with a comment", async () => {
    await runVouchGate({
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 4, user: { login: "x" } },
        comment: { body: "/vouch admit @stranger", user: { login: "randopublic" } },
      },
      store,
      engine,
      client,
      enforce: false,
    });
    expect(store.state.members.has("stranger")).toBe(false);
    expect(client.comments[0]![1]).toContain("not an active member");
  });

  test("`/vouch denounce` revokes the target sub-tree", async () => {
    const invite = engine.issueInvite(store.state, "owner");
    engine.redeemInvite(store.state, invite.token, "baduser");

    await runVouchGate({
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 5, user: { login: "owner" } },
        comment: { body: "/vouch denounce @baduser spam", user: { login: "owner" } },
      },
      store,
      engine,
      client,
      enforce: false,
    });
    expect(store.state.members.get("baduser")!.status).toBe("revoked");
    expect(client.comments[0]![1]).toContain("denounced");
  });

  test("ignores comments without a /vouch command", async () => {
    const result = await runVouchGate({
      eventName: "issue_comment",
      payload: {
        action: "created",
        issue: { number: 6, user: { login: "owner" } },
        comment: { body: "just chatting", user: { login: "owner" } },
      },
      store,
      engine,
      client,
      enforce: false,
    });
    expect(result.handled).toBe(false);
    expect(client.comments).toEqual([]);
  });
});
