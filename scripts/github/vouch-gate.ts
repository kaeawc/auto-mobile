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
import { FileVouchStore } from "../../src/features/vouch/FileVouchStore";
import { VouchEngine } from "../../src/features/vouch/VouchEngine";
import {
  runVouchGate,
  type GitHubIssueClient,
  type VouchEventPayload,
} from "../../src/features/vouch/VouchGitHubRunner";

const DEFAULT_GRAPH_PATH = ".github/vouch/graph.json";

class RestGitHubClient implements GitHubIssueClient {
  constructor(
    private readonly apiUrl: string,
    private readonly repo: string,
    private readonly token: string
  ) {}

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const response = await fetch(`${this.apiUrl}/repos/${this.repo}${path}`, {
      method,
      headers: {
        "authorization": `Bearer ${this.token}`,
        "accept": "application/vnd.github+json",
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  }

  async addLabel(issueNumber: number, label: string): Promise<void> {
    const res = await this.request("POST", `/issues/${issueNumber}/labels`, { labels: [label] });
    if (!res.ok) {
      throw new Error(`addLabel failed: ${res.status} ${await res.text()}`);
    }
  }

  async removeLabel(issueNumber: number, label: string): Promise<void> {
    const res = await this.request(
      "DELETE",
      `/issues/${issueNumber}/labels/${encodeURIComponent(label)}`
    );
    // 404 just means the label was not present — not an error for our purposes.
    if (!res.ok && res.status !== 404) {
      throw new Error(`removeLabel failed: ${res.status} ${await res.text()}`);
    }
  }

  async comment(issueNumber: number, body: string): Promise<void> {
    const res = await this.request("POST", `/issues/${issueNumber}/comments`, { body });
    if (!res.ok) {
      throw new Error(`comment failed: ${res.status} ${await res.text()}`);
    }
  }

  async close(issueNumber: number): Promise<void> {
    const res = await this.request("PATCH", `/issues/${issueNumber}`, { state: "closed" });
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
