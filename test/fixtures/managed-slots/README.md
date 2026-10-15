# Captured registry upgrade

`registry-schema-004.sql` is the immutable pre-retirement schema/data capture;
its source ref and reproduction command are embedded in the SQL. Do not rewrite
it to resemble the current schema.

`registryUpgradeFromCapturedSchema.test.ts` loads the capture, retires legacy
assignment/open-journal/free-device inventory with injected native shutdown and
owner-liveness ports, then applies `2026_10_16_008_retire_slot_features`. It also
builds a 007 snapshot to exercise the migration's independent safety refusal and
mixed broker/legacy data preservation. Broker scopes, role assignments, journals,
requests and resources are compared as raw SQL rows, including JSON strings.
The historical 000–007 migration tests explicitly target 007 when testing old
free-pool fields. `sqliteBindingRegistry.integration.test.ts` uses the shared
file-backed harness for a captured-file open/retire/migrate/close/reopen check.

Retirement shuts down product devices; AVD/simulator images remain on disk.
Unconfirmed shutdown or a live owner keeps all legacy records and leaves 008
pending for a later startup retry. Direct 008 application refuses unsafe rows.
