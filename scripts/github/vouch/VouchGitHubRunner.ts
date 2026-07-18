/**
 * Orchestrates a single GitHub event through the vouch domain and emits the
 * resulting side effects via an injected {@link GitHubIssueClient}. Kept free of
 * `fetch`/env so it is unit-testable with a fake client and an in-memory store;
 * `scripts/github/vouch-gate.ts` is the thin adapter that supplies the real
 * client and file store.
 */

import { VouchEngine } from "./VouchEngine";
import { DEFAULT_GATE_LABEL, parseVouchCommand, planGateAction } from "./VouchGitHubGate";
import type { VouchStateStore } from "./FileVouchStore";
import { canonicalLogin, type Member, type VouchState } from "./types";
import { ActionableError } from "../../../src/models/ActionableError";

/** Minimal GitHub issue/PR surface the runner needs. */
export interface GitHubIssueClient {
  addLabel(issueNumber: number, label: string): Promise<void>;
  removeLabel(issueNumber: number, label: string): Promise<void>;
  comment(issueNumber: number, body: string): Promise<void>;
  close(issueNumber: number): Promise<void>;
}

/** The subset of a GitHub webhook payload the runner reads. */
export interface VouchEventPayload {
  action?: string;
  issue?: { number: number; user?: { login: string } };
  pull_request?: { number: number; user?: { login: string } };
  comment?: { body: string; user?: { login: string } };
}

export interface VouchGitHubRunnerDeps {
  eventName: string;
  payload: VouchEventPayload;
  store: VouchStateStore;
  engine: VouchEngine;
  client: GitHubIssueClient;
  enforce: boolean;
  gateLabel?: string;
}

export interface VouchGitHubRunResult {
  handled: boolean;
  summary: string;
}

/** Handle one event end-to-end. Returns a short summary for logging. */
export async function runVouchGate(deps: VouchGitHubRunnerDeps): Promise<VouchGitHubRunResult> {
  const { eventName, payload } = deps;

  if (isOpenedEvent(eventName, payload)) {
    return await handleOpened(deps);
  }
  if (eventName === "issue_comment" && payload.action === "created") {
    return await handleComment(deps);
  }
  return { handled: false, summary: `No vouch action for event '${eventName}/${payload.action}'.` };
}

function isOpenedEvent(eventName: string, payload: VouchEventPayload): boolean {
  const opensGate = eventName === "issues" || eventName.startsWith("pull_request");
  const action = payload.action ?? "opened";
  return opensGate && (action === "opened" || action === "reopened");
}

function subject(payload: VouchEventPayload): { number: number; author: string } | null {
  const target = payload.issue ?? payload.pull_request;
  if (!target || target.number === undefined) {
    return null;
  }
  return { number: target.number, author: canonicalLogin(target.user?.login ?? "") };
}

async function handleOpened(deps: VouchGitHubRunnerDeps): Promise<VouchGitHubRunResult> {
  const { payload, store, engine, client, enforce, gateLabel = DEFAULT_GATE_LABEL } = deps;
  const info = subject(payload);
  if (!info || !info.author) {
    return { handled: false, summary: "Opened event missing subject/author." };
  }

  const state = await store.load();
  const decision = engine.evaluateGate(state, info.author);
  const plan = planGateAction(decision, { enforce, gateLabel });

  if (plan.removeLabel) {
    await client.removeLabel(info.number, plan.removeLabel);
  }
  if (plan.addLabel) {
    await client.addLabel(info.number, plan.addLabel);
  }
  if (plan.comment) {
    await client.comment(info.number, plan.comment);
  }
  if (plan.close) {
    await client.close(info.number);
  }

  return {
    handled: true,
    summary: `Gate for '${info.author}' on #${info.number}: ${plan.allowed ? "allowed" : "gated"}.`,
  };
}

async function handleComment(deps: VouchGitHubRunnerDeps): Promise<VouchGitHubRunResult> {
  const { payload, store, engine, client } = deps;
  const commentBody = payload.comment?.body ?? "";
  const command = parseVouchCommand(commentBody);
  if (!command) {
    return { handled: false, summary: "Comment has no /vouch command." };
  }
  const issueNumber = payload.issue?.number ?? payload.pull_request?.number;
  if (issueNumber === undefined) {
    return { handled: false, summary: "Comment event missing issue number." };
  }
  const commenter = canonicalLogin(payload.comment?.user?.login ?? "");

  const state = await store.load();
  let reply: string;
  let mutated = false;

  try {
    switch (command.kind) {
      case "invite": {
        requireActiveMember(state, commenter, "issue invites");
        const invite = engine.issueInvite(state, commenter);
        mutated = true;
        reply =
          `Issued a single-use invite token for @${commenter}. Token: \`${invite.token}\`\n\n` +
          `⚠️ Anyone can redeem a token posted publicly — prefer \`/vouch admit @user\` to vouch someone in directly.`;
        break;
      }
      case "admit": {
        requireActiveMember(state, commenter, "admit members");
        const invite = engine.issueInvite(state, commenter);
        const member = engine.redeemInvite(state, invite.token, command.target);
        mutated = true;
        reply = `✅ @${command.target} has been vouched in by @${commenter} (role: ${member.role}). Their issues/PRs will pass the gate.`;
        break;
      }
      case "redeem": {
        const member = engine.redeemInvite(state, command.token, commenter);
        mutated = true;
        reply = `✅ @${commenter} redeemed an invite and is now vouched in via @${member.vouchedBy}.`;
        break;
      }
      case "denounce": {
        requireDenouncer(state, commenter);
        const result = engine.denounce(state, command.target, command.reason);
        mutated = true;
        reply =
          `🚫 @${command.target} denounced by @${commenter}. Revoked ${result.revoked.length} member(s); ` +
          `penalised ${result.penalised.length} voucher(s) up the chain.`;
        break;
      }
      case "status": {
        const who = command.target ?? commenter;
        const member = state.members.get(who);
        reply = member
          ? `@${who}: role=${member.role}, status=${member.status}, reputation=${member.reputation}, ` +
            `remaining invites=${engine.remainingCapacity(state, who)}.`
          : `@${who} is not a known member of the trust graph.`;
        break;
      }
    }
  } catch (error) {
    const message = error instanceof ActionableError ? error.message : `Unexpected error: ${String(error)}`;
    await client.comment(issueNumber, `⚠️ ${message}`);
    return { handled: true, summary: `Command '${command.kind}' rejected: ${message}` };
  }

  if (mutated) {
    await store.save(state);
  }
  await client.comment(issueNumber, reply);
  return { handled: true, summary: `Command '${command.kind}' applied.` };
}

function requireActiveMember(state: VouchState, login: string, action: string): Member {
  const member = state.members.get(login);
  if (!member || member.status !== "active") {
    throw new ActionableError(`@${login} is not an active member and cannot ${action}.`);
  }
  return member;
}

function requireDenouncer(state: VouchState, login: string): Member {
  const member = requireActiveMember(state, login, "denounce");
  if (member.role !== "founder" && member.role !== "contributor") {
    throw new ActionableError(`@${login} must be a founder or contributor to denounce a member.`);
  }
  return member;
}
