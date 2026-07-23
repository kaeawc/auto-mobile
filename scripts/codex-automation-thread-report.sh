#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage:
  codex-automation-thread-report.sh [--codex-home PATH] [--title TITLE ...]

Scans Codex session JSONL files and reports:
  - how many recurring automation run threads match each title
  - where matching automations were originally created
  - the initial user request for each creation thread
  - likely skill/tool evidence around the creation thread

Defaults:
  --codex-home "$CODEX_HOME" if set, otherwise "$HOME/.codex"
  --title may be repeated. If omitted, the auto-mobile PR watcher titles are used.

Examples:
  scripts/codex-automation-thread-report.sh
  scripts/codex-automation-thread-report.sh --codex-home "$HOME/.codex" --title "Await PR 2455 feedback"
USAGE
}

codex_home="${CODEX_HOME:-$HOME/.codex}"
titles=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --codex-home)
      [[ $# -ge 2 ]] || { echo "missing value for --codex-home" >&2; exit 2; }
      codex_home="$2"
      shift 2
      ;;
    --title)
      [[ $# -ge 2 ]] || { echo "missing value for --title" >&2; exit 2; }
      titles+=("$2")
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ${#titles[@]} -eq 0 ]]; then
  titles=(
    "Await PR 2455 feedback"
    "Watch PR 2457 feedback"
    "Monitor PR 2462 feedback"
    "Await feedback on PR 2456"
  )
fi

if [[ ! -d "$codex_home" ]]; then
  echo "Codex home does not exist: $codex_home" >&2
  exit 1
fi

python3 - "$codex_home" ${titles[@]+"${titles[@]}"} <<'PY'
import json
import pathlib
import sys
from collections import Counter, defaultdict

codex_home = pathlib.Path(sys.argv[1]).expanduser()
titles = sys.argv[2:]
roots = [codex_home / "sessions", codex_home / "archived_sessions"]

def iter_jsonl_files():
    for root in roots:
        if not root.exists():
            continue
        yield from sorted(root.rglob("*.jsonl"))

def read_lines(path):
    try:
        return path.read_text(errors="replace").splitlines()
    except OSError:
        return []

def json_obj(line):
    try:
        return json.loads(line)
    except json.JSONDecodeError:
        return None

def message_text(payload):
    text_parts = []
    for item in payload.get("content", []):
        if isinstance(item, dict):
            text_parts.append(item.get("text") or item.get("input_text") or "")
    return " ".join(text_parts)

def short(text, limit=220):
    one_line = " ".join(text.split())
    if len(one_line) <= limit:
        return one_line
    return one_line[: limit - 1] + "…"

run_counts = Counter()
first_run = {}
last_run = {}
creation_events = defaultdict(list)

for path in iter_jsonl_files():
    lines = read_lines(path)
    first_text = "\n".join(lines[:12])
    for title in titles:
        if f"Automation: {title}" in first_text:
            run_counts[title] += 1
            ts = None
            for line in lines[:12]:
                obj = json_obj(line)
                if obj and f"Automation: {title}" in line:
                    ts = obj.get("timestamp")
                    break
            rel = path.relative_to(codex_home)
            if title not in first_run or (
                ts is not None and (first_run[title][0] is None or ts < first_run[title][0])
            ):
                first_run[title] = (ts, rel)
            if title not in last_run or (
                ts is not None and (last_run[title][0] is None or ts > last_run[title][0])
            ):
                last_run[title] = (ts, rel)

    for idx, line in enumerate(lines, start=1):
        has_create_mode = '"mode":"create"' in line or '\\"mode\\":\\"create\\"' in line
        if "automation_update" not in line or not has_create_mode:
            continue
        if not any(title in line for title in titles):
            continue
        obj = json_obj(line)
        if not obj:
            continue
        payload = obj.get("payload", {})
        if payload.get("type") != "function_call" or payload.get("name") != "automation_update":
            continue

        raw_args = payload.get("arguments", "{}")
        try:
            args = json.loads(raw_args)
        except json.JSONDecodeError:
            args = {}
        title = args.get("name")
        if title not in titles:
            continue

        initial_user = None
        previous_assistant = None
        skill_hits = set()
        tool_hits = set()

        for prior_line in lines[:idx]:
            prior = json_obj(prior_line)
            if not prior:
                continue
            prior_payload = prior.get("payload", {})
            if prior_payload.get("type") == "message":
                role = prior_payload.get("role")
                text = message_text(prior_payload)
                if role == "user" and initial_user is None and text.strip() and not text.lstrip().startswith("# AGENTS.md"):
                    initial_user = text
                if role == "assistant" and ("monitor" in text.lower() or "watch" in text.lower() or "automation" in text.lower()):
                    previous_assistant = text
                for skill in ("self-review", "gh-address-comments", "gh-fix-ci", "github:yeet", "push-pr", "gh-pr-workflow"):
                    if skill in text:
                        skill_hits.add(skill)
            if prior_payload.get("type") == "function_call":
                name = prior_payload.get("name")
                namespace = prior_payload.get("namespace")
                if name:
                    tool_hits.add(f"{namespace + '.' if namespace else ''}{name}")

        for later_line in lines[idx : min(len(lines), idx + 350)]:
            if "SKILL.md" not in later_line and "self-review" not in later_line and "gh-address-comments" not in later_line and "gh-fix-ci" not in later_line:
                continue
            for skill in ("self-review", "gh-address-comments", "gh-fix-ci", "github:yeet", "push-pr", "gh-pr-workflow"):
                if skill in later_line:
                    skill_hits.add(skill)

        creation_events[title].append(
            {
                "timestamp": obj.get("timestamp"),
                "path": path.relative_to(codex_home),
                "line": idx,
                "args": args,
                "initial_user": initial_user,
                "previous_assistant": previous_assistant,
                "skill_hits": sorted(skill_hits),
                "tool_hits": sorted(tool_hits),
            }
        )

print("# Codex Automation Thread Report")
print()
print(f"Codex home: `{codex_home}`")
print()
print("## Matching Run Threads")
print()
for title in titles:
    print(f"- `{title}`: {run_counts[title]} run thread(s)")
    if title in first_run:
        ts, rel = first_run[title]
        print(f"  First observed run: {ts or 'unknown'} in `{rel}`")
    if title in last_run:
        ts, rel = last_run[title]
        print(f"  Last observed run: {ts or 'unknown'} in `{rel}`")
print()
print("## Creation Events")
print()
for title in titles:
    events = creation_events.get(title, [])
    if not events:
        print(f"- `{title}`: no creation event found in local session logs")
        continue
    print(f"- `{title}`: {len(events)} create call(s)")
    for event in events:
        args = event["args"]
        print(f"  - Created at {event['timestamp']} in `{event['path']}:{event['line']}`")
        if event["initial_user"]:
            print(f"    Initial user request: {short(event['initial_user'])}")
        if event["previous_assistant"]:
            print(f"    Pre-create assistant context: {short(event['previous_assistant'])}")
        print(f"    Schedule: `{args.get('rrule', 'unknown')}`")
        print(f"    Workspace(s): `{args.get('cwds', 'unknown')}`")
        print(f"    Creator tool: `automation_update`")
        if event["skill_hits"]:
            print(f"    Skill evidence in thread: `{', '.join(event['skill_hits'])}`")
        else:
            print("    Skill evidence in thread: none before/near creation")
print()
print("## Interpretation")
print()
print("- The recurring entries in Recents are run threads created by cron automations.")
print("- The automation definitions are created through the Codex app `automation_update` tool.")
print("- Skill names found in a thread are supporting context, not proof that the skill itself scheduled the automation.")
PY
