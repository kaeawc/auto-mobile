# Vouch (contributor gating)

This repo uses [**`mitchellh/vouch`**](https://github.com/mitchellh/vouch) — a
community trust-management system — to gate GitHub issues and pull requests from
non-contributors. It is the same system Ghostty and 150+ other projects use; we
consume the upstream GitHub Actions and the standard `VOUCHED.td` file format
rather than maintaining our own implementation.

## How it works

- **Trust list:** [`.github/VOUCHED.td`](../../.github/VOUCHED.td) — a flat,
  alphabetically-sorted text file ("Trustdown"). One handle per line, no `@`,
  optional `github:` platform prefix. Denounce by prefixing `-` with an optional
  reason:

  ```
  github:kaeawc
  -github:slopmaster3000 Submitted endless amounts of AI slop
  ```

- **Model:** flat. A user is *vouched*, *denounced*, or *unknown* — there are no
  reputation scores, vouch budgets, invite tokens, or transitive/cascading trust.
  Authority comes from GitHub repo permissions: only collaborators with an allowed
  role (admin/maintain/write/triage) vouch or denounce. Vouched users do not gain
  the ability to vouch others.

- **Gating:** the `check-pr` / `check-issue` actions run on new PRs/issues and
  close them if the author is unvouched or denounced (bots and write-access
  collaborators are always allowed).

- **Managing:** a maintainer comments on any issue to update the list:
  - `vouch @user [reason]` — add to the trust list
  - `denounce @user [reason]` — denounce
  - `unvouch @user` — remove

  The `manage-by-issue` action commits the change back to `.github/VOUCHED.td`.

- **Web of trust (optional):** projects can aggregate *other projects'*
  `VOUCHED.td` lists, so a trust/denounce decision in one repo can ripple across
  repos with shared values. See the upstream README to opt into shared manager or
  vouched lists.

## Workflows

| Workflow | Trigger | Effect |
|----------|---------|--------|
| [`vouch-check-pr.yml`](../../.github/workflows/vouch-check-pr.yml) | `pull_request_target` opened/reopened | Close PRs from unvouched/denounced authors |
| [`vouch-check-issue.yml`](../../.github/workflows/vouch-check-issue.yml) | `issues` opened/reopened | Close issues from unvouched/denounced authors |
| [`vouch-manage-by-issue.yml`](../../.github/workflows/vouch-manage-by-issue.yml) | `issue_comment` created | Apply `vouch`/`denounce`/`unvouch` from maintainers |

The action refs are pinned to `mitchellh/vouch@v1.5.0`
(`d66fa29a64600490892131ad87597c30c91fcac4`).

## Tuning enforcement

Both check actions default here to **enforcing** (`require-vouch: "true"`,
`auto-close: "true"`). To soften:

- `require-vouch: "false"` — allow anyone to open issues/PRs but still block
  denounced users. A common setup is enforcing on PRs but permissive on issues so
  anyone can still file bug reports.
- `auto-close: "false"` — advisory only (report status without closing).
- `dry-run: "true"` — log intended actions without applying them, useful while
  rolling it out.

## Notes / prerequisites

- `manage-by-issue` pushes to the default branch with `GITHUB_TOKEN`, which
  requires repo **Settings → Actions → General → Workflow permissions →
  "Read and write"**. For commits that must re-trigger other workflows or bypass
  branch protection, swap in a GitHub App token
  (`actions/create-github-app-token`), as Ghostty does.
- Seed the trust list by editing `.github/VOUCHED.td` directly or via
  `vouch @user` comments. The repo owner (`github:kaeawc`) is already seeded.
