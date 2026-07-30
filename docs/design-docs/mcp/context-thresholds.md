# Context Baselines

<kbd>✅ Implemented</kbd> <kbd>🧪 Tested</kbd>

> **Current state:** CI records the context used by the default core tool profile and the full advertised tool surface on every relevant pull request and push to main. Limits will be added after both baselines are reviewed.

## Overview

The context benchmark instantiates the production MCP server, so its tool and resource registration cannot drift from the runtime server. It records:

- **Core Tools** — the default profile: tools without an opt-in capability.
- **All Tools** — every normal advertised tool, including opt-in capabilities.
- **Resources** and **Resource Templates** — shared context in both profiles.
- **Core Total** and **All Total** — each tool profile plus the shared resources and templates.

## Local Development

```bash
# Detailed per-item estimation for investigation
bun run estimate-context

# Record the production-server baselines
bun run benchmark-context

# Write the CI-format report
bun run benchmark-context --output reports/context-benchmark.json
```

## Baseline Configuration

`scripts/context-thresholds.json` records the canonical measurements. It deliberately has no `thresholds` section until the core and all-tool totals have been reviewed.

```json
{
  "version": "2.0.0",
  "metadata": {
    "generatedAt": "2026-07-29",
    "description": "Production-server context baselines for core and all-tool profiles",
    "baseline": {
      "coreTools": 8177,
      "allTools": 25896,
      "resources": 1259,
      "resourceTemplates": 12137,
      "coreTotal": 21573,
      "allTotal": 39292
    }
  }
}
```

### Current Baselines (2026-07-29)

| Category | Baseline | Scope |
|----------|----------|-------|
| Core Tools | 8,177 tokens | Default core profile |
| All Tools | 25,896 tokens | All advertised tools |
| Resources | 1,259 tokens | Shared |
| Resource Templates | 12,137 tokens | Shared |
| **Core Total** | **21,573 tokens** | **Default core profile** |
| **All Total** | **39,292 tokens** | **All advertised tools** |

## Benchmark Report Format

```text
MCP CONTEXT BASELINE BENCHMARK REPORT

Category                     Actual   Baseline    Delta  Status
--------------------------------------------------------------------------------
  Core Tools                     8177       8177       +0  • BASELINE
  All Tools                     25896      25896       +0  • BASELINE
  Resources                      1259       1259       +0  • BASELINE
  Resource Templates            12137      12137       +0  • BASELINE
--------------------------------------------------------------------------------
  CORE TOTAL                   21573      21573       +0  • BASELINE
  ALL TOTAL                    39292      39292       +0  • BASELINE

Overall Status: • BASELINES RECORDED (threshold enforcement pending)
```

The JSON report marks this state explicitly:

```json
{
  "passed": true,
  "enforcement": { "enabled": false },
  "results": {
    "coreTools": { "actual": 8177, "baseline": 8177, "delta": 0 },
    "allTools": { "actual": 25896, "baseline": 25896, "delta": 0 },
    "resources": { "actual": 1259, "baseline": 1259, "delta": 0 },
    "resourceTemplates": { "actual": 12137, "baseline": 12137, "delta": 0 },
    "coreTotal": { "actual": 21573, "baseline": 21573, "delta": 0 },
    "allTotal": { "actual": 39292, "baseline": 39292, "delta": 0 }
  },
  "violations": []
}
```

## CI Integration

The pull-request workflow uploads the report and posts this table. A baseline-only run is marked with a ruler instead of a pass/fail claim.

| Category | Actual | Baseline | Delta | Status |
|----------|--------|----------|-------|--------|
| Core Tools | 8,177 | 8,177 | +0 | 📏 |
| All Tools | 25,896 | 25,896 | +0 | 📏 |
| Resources | 1,259 | 1,259 | +0 | 📏 |
| Resource Templates | 12,137 | 12,137 | +0 | 📏 |
| **Core Total** | **21,573** | **21,573** | **+0** | 📏 |
| **All Total** | **39,292** | **39,292** | **+0** | 📏 |

## Adding Thresholds After Baseline Review

When budgets are chosen, add a complete `thresholds` object with all six measurement keys. The benchmark then adds `threshold`, `usage`, and `passed` fields for every result and fails CI for a value over its limit.

```mermaid
flowchart LR
    A["Review core and all-tool baselines"] --> B["Choose independent budgets"];
    B --> C["Add all six thresholds"];
    C --> D["Validate the benchmark"];
    D --> E["CI enforces the budgets"];
```

Keep the core and all-tool budgets independent. A larger all-tools allowance must not mask regression in the default profile.

## Related Documentation

- [MCP Resources](resources.md) - Resource system design
- [MCP Server](index.md) - Overall MCP architecture
- [Validation Commands](https://github.com/kaeawc/auto-mobile/blob/main/CLAUDE.md) - Development validation workflows
