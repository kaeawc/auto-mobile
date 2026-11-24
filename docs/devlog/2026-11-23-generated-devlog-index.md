# Generate the devlog index and nav from the entries

- Kind: decision
- Date: 2026-11-23
- Source: #19121

## Context

Every pull request that added a devlog entry also added a row to the devlog index and a line to the
`mkdocs.yml` devlog nav, both at the top of the list. On 2026-11-23 that caused a merge conflict on
almost every open pull request after each merge to main. One conflict lane's lint auto-fix even
formatted unresolved conflict markers into the index table.

## Options

- Keep the hand-edited lists and resolve each conflict.
- Generate both lists from the entry files, between marker comments, and check that they are current.

## Decision

`scripts/docs/generate-devlog-index.ts` reads each entry's `# ` title and its `- Kind:` and `- Date:`
lines, and rewrites the index table and the nav block newest first, by file name. The `devlog-index`
fast-validation check (`--group docs`) runs it with `--check` and fails when either list is stale.
Authors add only the entry file and run the script.

## Consequences

Two pull requests that each add an entry still touch the same generated lines, but running the script
resolves the conflict, not a hand edit. The script writes the index table without padding and oxfmt
skips the file, so a long title does not rewrite every row. The script lists entries from one day by
file name, not by the order they arrived. Nav labels drop backticks, which MkDocs shows literally. An
entry with a bad file name, kind or date fails the check.
