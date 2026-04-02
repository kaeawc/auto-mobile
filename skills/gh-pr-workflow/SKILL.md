---
name: gh-pr-workflow
description: Helper skill for PR creation or editing with gh; use it when another GitHub workflow needs a multiline PR body preserved via --body-file.
---

# PR Creation Without Newline Mangling

Preserve PR body formatting by writing the body to a file and passing that file to `gh`.

- Prefer `scratch/pr-body.md` for PR text created in-session.
- Create PRs with `gh pr create --title "..." --body-file scratch/pr-body.md`.
- Update PRs with `gh pr edit --body-file scratch/pr-body.md`.
- Avoid `--body "..."` when multiline formatting matters.
- Treat this as a supporting skill for `push-pr` or other PR workflows, not as the top-level workflow by itself.

Example:

```bash
cat <<'EOF_BODY' > scratch/pr-body.md
## Summary
- ...

## Testing
- ...
EOF_BODY

gh pr create --title "Your title" --body-file scratch/pr-body.md
```
