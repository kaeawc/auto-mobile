#!/usr/bin/env bun
/**
 * GitHub Action entrypoint for the vouch gate.
 *
 * Reads the triggering webhook event, runs it through the vouch domain
 * ({@link runVouchGate}), and applies the resulting label/comment/close side
 * effects via the GitHub REST API. The trust graph is stored as a committed JSON
 * file so it is transparent and auditable in git history; the workflow commits
 * any change back.
 *
 * Environment:
 *   GITHUB_TOKEN        - token with issues:write / pull-requests:write (required to act)
 *   GITHUB_EVENT_NAME   - e.g. "issues", "pull_request_target", "issue_comment"
 *   GITHUB_EVENT_PATH   - path to the event payload JSON (provided by Actions)
 *   GITHUB_REPOSITORY   - "owner/repo"
 *   GITHUB_API_URL      - defaults to https://api.github.com
 *   VOUCH_ENFORCE       - "true" to close gated issues/PRs; otherwise advisory (default)
 *   VOUCH_GRAPH_PATH    - graph file (default ".github/vouch/graph.json")
 */

import { promises as fs } from "fs";
import { FileVouchStore } from "./vouch/FileVouchStore";
import { VouchEngine } from "./vouch/VouchEngine";
import {
  runVouchGate,
  type GitHubIssueClient,
  type VouchEventPayload,
} from "./vouch/VouchGitHubRunner";

const DEFAULT_GRAPH_PATH = ".github/vouch/graph.json";

/**
 * Coerce a (potentially event-file-derived) issue number to a validated positive
 * safe integer. Issue/PR numbers are always small positive integers; validating
 * here means the only event-payload value that reaches the request URL is a
 * checked number, not an attacker-influenced string path segment (CodeQL:
 * "file data in outbound network request").
 */
function toSafeIssueNumber(value: number): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`Refusing to build a request for a non-positive-integer issue number: ${value}`);
  }
  return n;
}

class RestGitHubClient implements GitHubIssueClient {
  /** Fixed, trusted request origin. The destination host never varies with input. */
  private readonly origin: string;

  constructor(
    apiUrl: string,
    private readonly repo: string,
    private readonly token: string
  ) {
    this.origin = new URL(apiUrl).origin;
  }

  /**
   * Build the request URL from the fixed trusted origin plus a fully
   * caller-constructed path, then assert the resolved URL still points at that
   * origin before sending. The `issueNumber` segments are validated integers and
   * the repo/label segments are URL-encoded, so no event-file string can redirect
   * the request to a different host.
   */
  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const url = new URL(`/repos/${this.repo}${path}`, this.origin);
    if (url.origin !== this.origin) {
      throw new Error(`Refusing to send a request to an unexpected origin: ${url.origin}`);
    }
    return await fetch(url, {
      method,
      headers: {
        "authorization": `Bearer ${this.token}`,
        "accept": "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    const res = await this.request("POST", `/issues/${toSafeIssueNumber(issueNumber)}/labels`, {
      labels: [label],
    });
    if (!res.ok) {
      throw new Error(`addLabel failed: ${res.status} ${await res.text()}`);
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const res = await this.request(
      "DELETE",
      `/issues/${toSafeIssueNumber(issueNumber)}/labels/${encodeURIComponent(label)}`
    );
    // 404 just means the label was not present — not an error for our purposes.
    if (!res.ok && res.status !== 404) {
      throw new Error(`removeLabel failed: ${res.status} ${await res.text()}`);
    }
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    const res = await this.request("POST", `/issues/${toSafeIssueNumber(issueNumber)}/comments`, {
      body,
    });
    if (!res.ok) {
      throw new Error(`comment failed: ${res.status} ${await res.text()}`);
    }
  }

  async close(issueNumber: number): Promise<void> {
    const res = await this.request("PATCH", `/issues/${toSafeIssueNumber(issueNumber)}`, {
      state: "closed",
    });
    if (!res.ok) {
      throw new Error(`close failed: ${res.status} ${await res.text()}`);
    }
  }
}

async function main(): Promise<void> {
  const eventName = process.env.GITHUB_EVENT_NAME;
  const eventPath = process.env.GITHUB_EVENT_PATH;
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const enforce = (process.env.VOUCH_ENFORCE ?? "").toLowerCase() === "true";
  const graphPath = process.env.VOUCH_GRAPH_PATH ?? DEFAULT_GRAPH_PATH;

  if (!eventName || !eventPath || !repo || !token) {
    throw new Error(
      "vouch-gate requires GITHUB_EVENT_NAME, GITHUB_EVENT_PATH, GITHUB_REPOSITORY and GITHUB_TOKEN."
    );
  }

  const payload = JSON.parse(await fs.readFile(eventPath, "utf8")) as VouchEventPayload;
  const store = new FileVouchStore(graphPath);
  const engine = new VouchEngine();
  const client = new RestGitHubClient(apiUrl, repo, token);

  const result = await runVouchGate({ eventName, payload, store, engine, client, enforce });

  console.log(`[vouch-gate] ${result.summary}`);
}

main().catch(error => {

  console.error(`[vouch-gate] failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
