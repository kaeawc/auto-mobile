---
name: research
description: Use this skill to conduct deep parallel research on a topic using web searches and available tools. Produces cited markdown files in a research/ directory with validated URLs and a synthesis summary.
---

# Research

Conduct parallel deep research on a topic. Download and cite sources as markdown files. Validate all URLs. Summarize knowns vs unknowns.

## Step 1: Setup Output Directory

```bash
TOPIC_SLUG=$(echo "<topic>" | tr '[:upper:]' '[:lower:]' \
  | sed 's/[^a-z0-9]/-/g' | sed 's/--*/-/g' | head -c 60)
TOPIC_DIR="research/${TOPIC_SLUG}"
mkdir -p "${TOPIC_DIR}/sources"
```

Add `research/` to `.gitignore` if not already there:
```bash
grep -q '^research/' .gitignore 2>/dev/null || echo 'research/' >> .gitignore
```

## Step 2: Decompose Into Research Angles

Break the topic into distinct, parallelizable angles. Each angle becomes a separate research task.

Example for "home automation APIs":
1. Google Home API and SDK
2. Apple HomeKit SDK
3. Matter protocol specification
4. Zigbee/Z-Wave protocols
5. Local network discovery methods

Present the angles before starting:
```
Research angles for "<topic>":
  1. [angle] — search queries to use
  2. [angle] — search queries to use
  ...
```

## Step 3: Execute Research Per Angle

For each angle:

1. **Search broadly**: Try multiple search queries. Rephrase if initial results are poor.
2. **Read deeply**: Fetch the most relevant pages in full. Extract specific technical details, code examples, API endpoints, version numbers, limitations.
3. **Follow references**: If a source links to primary docs, specs, or implementations, follow those too.
4. **Save each source** to `${TOPIC_DIR}/sources/[angle]-[N].md`:

```markdown
# [Title of the source]
**URL**: [url]
**Accessed**: [date]
**Relevance**: [one-line why this matters]

## Key Findings
[extracted content, code examples, technical details]
```

5. **Write angle summary** to `${TOPIC_DIR}/[angle-slug].md`:
   - What was found
   - Key technical details
   - All citations as markdown links
   - Open questions from this angle

Do NOT fabricate URLs or citations. If a source can't be found, say so.

## Step 4: Validate All Citations

Extract and validate every URL cited:

```bash
grep -roh 'https\?://[^ )]*' "${TOPIC_DIR}/" | sort -u > /tmp/research_urls.txt

if command -v lychee &>/dev/null; then
    lychee --no-progress /tmp/research_urls.txt 2>&1
else
    while IFS= read -r url; do
        STATUS=$(curl -sL -o /dev/null -w "%{http_code}" --max-time 10 "$url" 2>/dev/null)
        if [ "$STATUS" -ge 400 ] || [ "$STATUS" -eq 000 ]; then
            echo "BROKEN ($STATUS): $url"
        fi
    done < /tmp/research_urls.txt
fi
```

Mark broken links with a warning in their source files.

## Step 5: Write Synthesis Summary

Create `${TOPIC_DIR}/SUMMARY.md`:

```markdown
# Research Summary: [Topic]
**Date**: [date]
**Agents**: [N] | **Sources**: [count] | **URLs validated**: [pass/fail]

## What We Learned
### [Theme 1]
[synthesis across angles]
- Source: [citation]

### [Theme 2]
[synthesis]

## Key Technical Details
[APIs, endpoints, protocols, versions, code patterns]

## What Remains Unknown or Assumed
- [ ] [open question]
- [ ] [assumption needing validation]

## Source Index
| # | Title | URL | Status | Angle |
|---|-------|-----|--------|-------|
| 1 | ... | ... | ... | ... |
```

## Step 6: Present Next Steps

After the summary, suggest options:
- Research deeper on specific unknowns
- Turn findings into an implementation plan
- Start implementing based on learnings
- Save key findings to project memory

## Output Structure

```
research/[topic-slug]/
  SUMMARY.md              — synthesis + citation index
  [angle-1].md            — angle 1 findings
  [angle-2].md            — angle 2 findings
  sources/
    [angle-1]-1.md        — downloaded source
    [angle-1]-2.md
    [angle-2]-1.md
```

## Safety Rules

- Never fabricate URLs — every citation must come from an actual search or fetch.
- Never hallucinate content — if a source doesn't say something, don't claim it does.
- Validate all URLs with lychee or curl.
- Date-stamp all research — it has a shelf life.
- Keep `research/` gitignored to avoid committing downloaded web content.
