# iOS simulator Photos TCC captures

Real captures from manual-test batch 20261015a (iOS 27.0 simulator
`amslot-feca0605-0-g1-d3c54cd6`, Playground app `dev.jasonpearson.automobile.Playground`,
2026-10-15, SHA ecf0ae79c3). Do not hand-edit; re-capture instead.

- `<case>-tcc.json`: `sqlite3 -json` output of `select * from access` for the app's Photos
  rows in the simulator `TCC.db` (`none` is empty: sqlite prints nothing for zero rows).
- `<case>-probe.json`: native PhotoKit authorization status from the Playground probe (#12398)
  taken at the same moment.

Cases in order: `none` -> `addonly` (grant photos-add) -> `full` (grant photos) -> `revoked`
(revoke photos) -> `full2` (grant photos after a revoke; leaves a stale `kTCCServicePhotosAdd`
row with `auth_value` 0 while PhotoKit reports add-only `authorized`, issue #12462).
