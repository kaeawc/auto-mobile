---
name: research
description: Use this skill to conduct deep parallel research on a topic using web searches and available tools. Produces cited markdown files in a research/ directory with validated URLs and a synthesis summary.
---

# Research

Conduct topic research with explicit citations, saved artifacts, and a final synthesis.

## Workflow

1. Create `research/<topic-slug>/sources/`.
2. Ensure `research/` is gitignored before saving downloaded source material.
3. Break the topic into distinct research angles before collecting sources.
4. For each angle, search broadly, read primary sources, follow references, and save notes as markdown files.
5. Save each source with title, URL, access date, relevance, and extracted findings.
6. Validate all cited URLs with `lychee` or `curl`.
7. Write `SUMMARY.md` covering what is known, what remains unknown, and a source index.

## Repo Rules

- Do not fabricate URLs, citations, or quoted claims.
- Date-stamp the research because it becomes stale quickly.
- Keep downloaded material out of version control unless the user explicitly wants it committed.
- When the task is implementation-adjacent, end with concrete next-step options such as plan, implement, or deeper research.
