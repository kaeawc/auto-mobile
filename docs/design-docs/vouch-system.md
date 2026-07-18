# Vouch System (web-of-trust gating)

A web-of-trust that gates GitHub issues and pull requests from non-contributors.
It is modeled on Mitchell Hashimoto's Ghostty beta vouch system: a small set of
trusted seed members can vouch newcomers in, each member has a bounded "vouch
budget", trust flows down a forest, and denouncing a bad actor revokes their
downstream sub-tree while charging a decaying reputation penalty up the chain
that vouched them in.

## Why

Open repos attract drive-by issues and PRs from accounts with no track record.
Rather than a hard "contributors only" wall, the vouch system lets the community
extend trust deliberately and *accountably*: anyone can be brought in by someone
who is willing to stake reputation on them.

## Roles

| Role | Vouched in by | Cascade-revocable | Notes |
|------|---------------|-------------------|-------|
| `founder` | nobody (seed) | **No — immune** | The repo owner. A root of trust. |
| `contributor` | nobody (seed) | Only if explicitly denounced | Directly trusted (e.g. merged PRs). |
| `vouched` | another member | Yes | Joined by redeeming/receiving a vouch. |

## Mechanics

- **Vouch budget.** Each member's capacity is `base(role) + floor(reputation /
  reputationPerBonusVouch)`. Outstanding commitments (pending invites + active
  members they vouched in) consume the budget. See
  [`VouchPolicy.ts`](../../src/features/vouch/VouchPolicy.ts) for the defaults.
- **Invite tokens.** A member spends a slot to mint a single-use token
  (`/vouch invite`), or vouches someone in directly (`/vouch admit @user`).
- **Trust graph.** Every `vouched` member stores a single `vouchedBy` pointer;
  the whole forest is reconstructable from it.
- **Revocation cascade.** Denouncing a member (`/vouch denounce @user`) revokes
  them and everyone in their downstream sub-tree.
- **Shared accountability.** The denounced member's *direct* voucher loses
  `denouncePenalty` reputation; each ancestor further up pays a `penaltyDecay`
  fraction of the one below, until it rounds to zero. Lower reputation means a
  smaller vouch budget.

### What happens when someone you invited is denounced?

Because you (the repo owner) are a `founder`:

1. **The denounced member is revoked** — their issues/PRs are gated again.
2. **The cascade goes down, not up** — everyone *they* vouched for is revoked too.
3. **You take a reputation hit, never a revocation** — the penalty lowers your
   vouch budget (you can invite fewer people until reputation recovers), but a
   founder is immune from revocation and floored at zero reputation, so you never
   lose access. Denouncing a bad actor can never lock you out of your own repo.

## Architecture

```
GitHub event ──▶ scripts/github/vouch-gate.ts (adapter: fetch + file store)
                      │
                      ▼
              VouchGitHubRunner ──▶ VouchEngine (pure domain: trust + accountability)
                      │                   ▲
                      ▼                   │
              GitHubIssueClient      VouchStateStore
              (label/comment/close)   ├─ FileVouchStore (.github/vouch/graph.json)  ← Action path
                                      └─ VouchRepository (SQLite)                    ← daemon/MCP path
```

- [`VouchEngine`](../../src/features/vouch/VouchEngine.ts) — pure, deterministic
  (injected `IdGenerator` + `Timer`), no I/O. All trust/accountability logic.
- [`VouchService`](../../src/features/vouch/VouchService.ts) — engine + SQLite
  persistence, for the daemon/MCP path.
- [`FileVouchStore`](../../src/features/vouch/FileVouchStore.ts) +
  [`VouchSnapshot`](../../src/features/vouch/VouchSnapshot.ts) — JSON graph in the
  repo, for the GitHub-Action path (transparent + auditable in git history).
- [`VouchGitHubGate`](../../src/features/vouch/VouchGitHubGate.ts) — pure command
  parsing + action planning.
- [`VouchGitHubRunner`](../../src/features/vouch/VouchGitHubRunner.ts) —
  orchestrates one event; side effects via an injected client.

## Slash commands (post as an issue/PR comment)

| Command | Who can run it | Effect |
|---------|----------------|--------|
| `/vouch admit @user` | any active member with budget | Vouch `@user` in directly. |
| `/vouch invite` | any active member with budget | Mint a single-use token. |
| `/vouch redeem <token>` | anyone | Join by redeeming a token. |
| `/vouch denounce @user [reason]` | founder / contributor | Revoke `@user`'s sub-tree. |
| `/vouch status [@user]` | anyone | Report standing + remaining budget. |

## Deploying the GitHub gate

1. Seed the graph. The repo owner is already seeded as a `founder` in
   [`.github/vouch/graph.json`](../../.github/vouch/graph.json). Add trusted
   contributors by editing that file (`role: "contributor"`) or via `/vouch admit`.
2. Enable the workflow: set the repository **variable** `VOUCH_GATE_ENABLED` to
   `true` (Settings → Secrets and variables → Actions → Variables). The
   [`vouch-gate.yml`](../../.github/workflows/vouch-gate.yml) workflow is inert
   until then.
3. Choose enforcement. It defaults to **advisory** — a gated issue/PR gets the
   `needs-vouch` label and a guidance comment but stays open. Set the
   `VOUCH_ENFORCE` variable to `true` to close gated issues/PRs.

`pull_request_target` is used so PRs from forks can be gated and the graph (a
base-repo file) can be read/written; the workflow reads only the event payload,
never checks out untrusted PR code. Graph mutations are committed back to the
default branch, so the trust graph's evolution is visible in git history.
