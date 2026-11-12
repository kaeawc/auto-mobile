# Session broker reuse measurements

- Kind: concept
- Date: 2026-10-21
- Source: moved from `how-it-works/session-broker-device-reuse.md`; #14358, #14366, #14678, #14786,
  #14795, #15053
- Shaped: [Session broker device reuse, reset, and capacity](../how-it-works/session-broker-device-reuse.md)

## Observed timings

- Owner exit (`session_owner_exited`): the broker destroyed the device about 26 s after the exit in
  batch 20261021e.
- iOS keep-booted reuse was measured at about 10 s, but on iOS 27 keep-booted reset always falls
  back to erase until #14786 is fixed, so that time is not reachable there.

## Worked sizing example

No matched comparison shows reuse reduces end-to-end latency; an idle-pool hit
moves boot work from acquisition to release. Illustrative (not measured) creation
p50 ~107 s, p90 ~124 s. Measured iOS erase reset: ~15 s stop, 0.3 s erase, 52 s
boot, ~67.3 s total. For up to six concurrent sessions retaining two warm devices:
`sessionCap: 6`, `idlePoolCap: 2`, `totalDeviceCap: 10` (if the host can hold ten
devices), and `maxConcurrentResetBoots: 2` or lower if the boot gate safely admits
two. At 67.3 s, two reset slots clear ten resets in ~5 waves (337 s), one slot in
~10 waves (673 s), ignoring queueing and variance. If observed reset p90 is well
above the estimate, adjust reset concurrency, `idlePoolCap`, or the client's
preparation timeout; more reset concurrency only helps with spare boot-gate and
host capacity.
