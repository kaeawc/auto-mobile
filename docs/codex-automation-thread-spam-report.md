# Codex Automation Thread Spam Report

Date: 2026-07-23

## Summary

The Codex Recents list on this machine showed a large number of repeated threads with titles like:

- `Await PR 2455 feedback`
- `Watch PR 2457 feedback`
- `Monitor PR 2462 feedback`
- `Await feedback on PR 2456`

The repeated entries were not caused by a skill directly creating many files. They were caused by four hourly Codex cron automations. Each scheduled run created a separate Codex session/thread record, and those run threads accumulated in Recents.

The automations were originally created through the Codex app `automation_update` tool from issue-implementation threads on 2026-06-24. GitHub/self-review skills were present in those threads, but the scheduling action itself was an `automation_update` tool call.

## Local Findings

The reusable inspection script is:

```bash
scripts/codex-automation-thread-report.sh
```

On this machine, it reported:

| Automation title            | Matching run threads |
| --------------------------- | -------------------: |
| `Await PR 2455 feedback`    |                  167 |
| `Watch PR 2457 feedback`    |                  166 |
| `Monitor PR 2462 feedback`  |                  167 |
| `Await feedback on PR 2456` |                  167 |

The original creation events were:

| Automation title            | Created at           | Source thread                                                                              | Initial user request                       |
| --------------------------- | -------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------ |
| `Await feedback on PR 2456` | 2026-06-24T19:39:19Z | `archived_sessions/rollout-2026-06-24T13-57-56-019efafe-ffc1-7dd0-9feb-9a28bf4dd3c3.jsonl` | `read and work to implement gh issue 2441` |
| `Await PR 2455 feedback`    | 2026-06-24T19:39:27Z | `archived_sessions/rollout-2026-06-24T13-58-05-019efaff-2517-72a1-914f-94fb5294cf45.jsonl` | `read and work to implement gh issue 2445` |
| `Watch PR 2457 feedback`    | 2026-06-24T19:39:19Z | `archived_sessions/rollout-2026-06-24T13-58-13-019efaff-440c-7890-a784-1990e4e9c186.jsonl` | `read and work to implement gh issue 2449` |
| `Monitor PR 2462 feedback`  | 2026-06-24T19:39:48Z | `archived_sessions/rollout-2026-06-24T13-58-03-019efaff-1c13-7893-b186-dd062580d588.jsonl` | `read and work to implement gh issue 2444` |

Two of the automations had an initial rejected/duplicate-looking create attempt followed by a successful retry with the scheduler's expected field shape. That is separate from the long-term Recents growth; the main growth came from hourly runs.

## Likely Cause

The originating agents opened PRs and then autonomously created hourly feedback monitors for those PRs. The monitor intent was reasonable for active PRs, but there was no obvious stop condition once the PRs merged. As a result, each automation continued producing a new session/thread on every hourly run until later stopped or no longer active.

The waste has two parts:

1. Scheduler resource usage: repeated no-op PR checks after the PRs were already merged/clean.
2. UI clutter: each run appears as a separate recent thread, flooding Recents with repeated titles.

## Skill Attribution

The evidence does not support "a skill directly created the threads."

The direct creator was:

```text
automation_update mode=create kind=cron
```

Nearby thread evidence included these skill names:

- `github:yeet`
- `gh-pr-workflow`
- `push-pr`
- `gh-address-comments`
- `gh-fix-ci`
- `self-review`

These are supporting context only. A skill being present in a thread means it may have shaped the workflow, but the actual scheduling write came from the Codex app automation tool.

## Reproduction Script

The script scans local Codex JSONL logs and prints a Markdown report. It looks in:

```text
$CODEX_HOME/sessions
$CODEX_HOME/archived_sessions
```

It reports:

- number of matching automation run threads
- first and last observed run
- original `automation_update` create calls
- source JSONL path and line number
- initial user request in the creation thread
- assistant context immediately before creation
- schedule and workspace fields
- nearby skill-name evidence

## How To Run On Another Machine

Copy or check out this script on the target machine:

```bash
scripts/codex-automation-thread-report.sh
```

Run with the default Codex home:

```bash
scripts/codex-automation-thread-report.sh
```

Run with an explicit Codex home:

```bash
scripts/codex-automation-thread-report.sh --codex-home "$HOME/.codex"
```

Inspect one specific title:

```bash
scripts/codex-automation-thread-report.sh \
  --codex-home "$HOME/.codex" \
  --title "Await PR 2455 feedback"
```

Inspect several titles:

```bash
scripts/codex-automation-thread-report.sh \
  --title "Await PR 2455 feedback" \
  --title "Watch PR 2457 feedback" \
  --title "Monitor PR 2462 feedback" \
  --title "Await feedback on PR 2456"
```

The script only requires Bash and Python 3. It does not call GitHub, does not mutate Codex state, and does not require network access.

## How To Interpret Output

High run counts indicate repeated scheduled sessions for the same automation title.

Creation events identify where the automation was scheduled. The key fields are:

- `Created at`: timestamp of the `automation_update` create call
- `Initial user request`: the user request that started the source thread
- `Pre-create assistant context`: the assistant's stated reason for creating the monitor
- `Schedule`: the recurrence rule, for example `FREQ=HOURLY;INTERVAL=1`
- `Workspace(s)`: where the cron automation ran
- `Creator tool`: should be `automation_update` for Codex automations
- `Skill evidence in thread`: useful context, not proof of direct authorship

No creation event found usually means one of:

- the local machine no longer has the archived source thread
- the automation was created on another host
- the title passed to `--title` differs from the creation-time name
- the JSONL format changed enough that the parser needs a small update

## Suggested Product Follow-Ups

Consider making cron automation runs less noisy in Recents:

- group recurring runs under the automation definition
- hide successful no-op runs from Recents by default
- show only the latest run per automation unless pinned or opened
- automatically pause PR-monitor automations when the watched PR is merged or closed
- require an explicit duration or stop condition for hourly PR feedback monitors
- warn before creating an hourly monitor from an agent-created PR workflow

Consider improving attribution:

- store `created_by_thread_id`, `created_by_tool`, and selected skill context in automation metadata
- expose automation creation metadata in the UI
- make run-thread records link back to the automation definition

## Current Workaround

For this specific case, pause or delete these automation IDs:

```text
await-feedback-on-pr-2456
await-pr-2455-feedback
watch-pr-2457-feedback
monitor-pr-2462-feedback
```

All four watched PRs were already merged/clean in the local evidence, so continued hourly polling was no longer useful.
