# Manual-test batch incidents

- Kind: concept
- Date: 2026-10-23
- Source: moved from `how-it-works/manual-test-harness.md`; #11905, #12212, #15053
- Shaped: [Manual-test harness](../how-it-works/manual-test-harness.md)

## Incidents behind harness rules

- **`adb emu kill` hung under load** in batch 20261013a. The harness rules forbid it.
- **Split coordination registry** made batch 20261012a report a false 7-of-6 capacity finding
  (#11905). The batch uses one shared adb-server coordination directory by default;
  `init --split-adb-coordination` is opt-in.
- **Host sleep** in batch 20261013a expired every idle session on wake, invalidating timings across
  the sleep (#12212). Preflight checks power, lid and sleep assertions, and the page recommends
  `caffeinate`.
