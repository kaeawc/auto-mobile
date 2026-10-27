import type { Migration, MigrationProvider } from "kysely/migration";
import * as m000 from "./migrations/2025_12_28_000_initial_schema";
import * as m001 from "./migrations/2025_12_30_000_performance_thresholds";
import * as m002 from "./migrations/2025_12_30_001_navigation_graph";
import * as m003 from "./migrations/2025_12_31_000_accessibility_baselines";
import * as m004 from "./migrations/2025_12_31_001_memory_audit";
import * as m005 from "./migrations/2026_01_01_000_recomposition_metrics";
import * as m006 from "./migrations/2026_01_02_000_prediction_history";
import * as m007 from "./migrations/2026_01_03_000_feature_flags";
import * as m008 from "./migrations/2026_01_03_000_test_executions";
import * as m009 from "./migrations/2026_01_05_000_tool_calls";
import * as m010 from "./migrations/2026_01_08_000_test_coverage";
import * as m011 from "./migrations/2026_01_09_000_video_recordings";
import * as m012 from "./migrations/2026_01_10_000_device_snapshots";
import * as m013 from "./migrations/2026_01_11_000_installed_apps";
import * as m014 from "./migrations/2026_01_11_000_video_recording_highlights";
import * as m015 from "./migrations/2026_01_13_000_installed_apps_session_tracking";
import * as m016 from "./migrations/2026_01_14_000_appearance_config";
import * as m017 from "./migrations/2026_01_25_000_navigation_screenshots";
import * as m018 from "./migrations/2026_01_25_001_test_run_details";
import * as m019 from "./migrations/2026_01_27_000_crash_anr_monitoring";
import * as m020 from "./migrations/2026_01_27_000_failures";
import * as m021 from "./migrations/2026_01_29_000_named_nodes";
import * as m022 from "./migrations/2026_01_30_000_performance_live_metrics";
import * as m023 from "./migrations/2026_03_15_000_telemetry_events";
import * as m024 from "./migrations/2026_03_18_000_navigation_events";
import * as m025 from "./migrations/2026_03_19_000_storage_events";
import * as m026 from "./migrations/2026_03_19_001_layout_events";
import * as m027 from "./migrations/2026_03_19_002_storage_events_previous_value";
import * as m028 from "./migrations/2026_03_19_003_layout_events_screen_name";
import * as m029 from "./migrations/2026_03_20_000_network_event_details";
import * as m030 from "./migrations/2026_04_01_000_drop_custom_events";
import * as m031 from "./migrations/2026_04_02_000_device_sessions";
import * as m032 from "./migrations/2026_07_01_000_failure_groups_signature_unique";
import * as m033 from "./migrations/2026_07_02_000_event_composite_indexes";
import * as m034 from "./migrations/2026_07_03_000_drop_redundant_device_indexes";
import * as m035 from "./migrations/2026_07_03_000_repair_datetime_now_defaults";
import * as m036 from "./migrations/2026_07_04_000_storage_events_key_lookup";
import * as m037 from "./migrations/2026_07_05_000_repair_updated_at_defaults";
import * as m038 from "./migrations/2026_07_24_000_device_locks";
import * as m039 from "./migrations/2026_07_27_000_session_tool_capabilities";
import * as m040 from "./migrations/2026_07_31_000_video_recordings_owner_session";
import * as m041 from "./migrations/2026_08_02_000_navigation_provenance";
import * as m042 from "./migrations/2026_08_17_000_emulator_loss_incidents";
import * as m043 from "./migrations/2026_08_22_000_provision_device_operations";
import * as m044 from "./migrations/2026_08_22_001_session_tool_overrides";
import * as m045 from "./migrations/2026_08_22_002_navigation_observation_eviction_index";
import * as m046 from "./migrations/2026_08_22_003_device_teardown_operations";
import * as m047 from "./migrations/2026_08_23_000_device_teardown_operation_owner";
import * as m048 from "./migrations/2026_08_23_001_default_existing_delete_device_disabled";
import * as m049 from "./migrations/2026_08_24_000_installed_apps_profile_type";
import * as m050 from "./migrations/2026_09_06_000_tool_selection_profile_provenance";
import * as m051 from "./migrations/2026_09_08_000_provision_device_operations_expiry";
import * as m052 from "./migrations/2026_09_10_000_provision_device_operation_attempt";
import * as m053 from "./migrations/2026_09_10_001_device_session_retention_index";
import * as m054 from "./migrations/2026_09_13_000_device_snapshot_vm_reclaim";
import * as m055 from "./migrations/2026_09_14_000_device_session_stable_identity";
import * as m056 from "./migrations/2026_09_14_001_device_session_identity_writer_fence";
import * as m057 from "./migrations/2026_09_16_000_device_session_liveness_owner";
import * as m058 from "./migrations/2026_09_16_001_device_session_liveness_contract";
import * as m059 from "./migrations/2026_09_17_000_device_session_liveness_writer_fence";
import * as m060 from "./migrations/2026_09_17_001_device_session_identity_fence_same_serial";
import * as m061 from "./migrations/2026_09_20_000_provision_device_lifecycle_outcome";
import * as m062 from "./migrations/2026_09_29_000_navigation_suggestion_provenance";
import * as m063 from "./migrations/2026_09_30_000_video_recording_display";
import * as m064 from "./migrations/2026_09_30_001_network_capture_fields";
import * as m065 from "./migrations/2026_10_05_000_device_locks_device_identity";
import * as m066 from "./migrations/2026_10_05_001_storage_events_key_lookup_insertion_order";
import * as m067 from "./migrations/2026_10_05_002_test_edge_coverage_edge_id_index";
import * as m068 from "./migrations/2026_10_09_000_device_resource_applications";
import * as m069 from "./migrations/2026_10_09_001_drop_provision_device_operations";
import * as m070 from "./migrations/2026_10_09_002_drop_device_teardown_operations";
import * as m071 from "./migrations/2026_10_12_000_rename_recording_tool_names";
import * as m072 from "./migrations/2026_10_12_001_video_recording_capture_teardown";
import * as m073 from "./migrations/2026_10_13_000_video_recording_recorder_daemon";
import * as m074 from "./migrations/2026_10_15_000_device_session_activity_seq";
import * as m076 from "./migrations/2026_10_26_000_prototype_test_sessions";
import * as m075 from "./migrations/2026_10_18_000_mcp_tasks";

/**
 * Bundle the default migrations without runtime folder discovery. Keep keys identical to
 * filenames (without .ts), in code-unit sort order; staticMigrations.test.ts guards drift.
 */
export const STATIC_MIGRATIONS: Readonly<Record<string, Migration>> = {
  "2025_12_28_000_initial_schema": m000,
  "2025_12_30_000_performance_thresholds": m001,
  "2025_12_30_001_navigation_graph": m002,
  "2025_12_31_000_accessibility_baselines": m003,
  "2025_12_31_001_memory_audit": m004,
  "2026_01_01_000_recomposition_metrics": m005,
  "2026_01_02_000_prediction_history": m006,
  "2026_01_03_000_feature_flags": m007,
  "2026_01_03_000_test_executions": m008,
  "2026_01_05_000_tool_calls": m009,
  "2026_01_08_000_test_coverage": m010,
  "2026_01_09_000_video_recordings": m011,
  "2026_01_10_000_device_snapshots": m012,
  "2026_01_11_000_installed_apps": m013,
  "2026_01_11_000_video_recording_highlights": m014,
  "2026_01_13_000_installed_apps_session_tracking": m015,
  "2026_01_14_000_appearance_config": m016,
  "2026_01_25_000_navigation_screenshots": m017,
  "2026_01_25_001_test_run_details": m018,
  "2026_01_27_000_crash_anr_monitoring": m019,
  "2026_01_27_000_failures": m020,
  "2026_01_29_000_named_nodes": m021,
  "2026_01_30_000_performance_live_metrics": m022,
  "2026_03_15_000_telemetry_events": m023,
  "2026_03_18_000_navigation_events": m024,
  "2026_03_19_000_storage_events": m025,
  "2026_03_19_001_layout_events": m026,
  "2026_03_19_002_storage_events_previous_value": m027,
  "2026_03_19_003_layout_events_screen_name": m028,
  "2026_03_20_000_network_event_details": m029,
  "2026_04_01_000_drop_custom_events": m030,
  "2026_04_02_000_device_sessions": m031,
  "2026_07_01_000_failure_groups_signature_unique": m032,
  "2026_07_02_000_event_composite_indexes": m033,
  "2026_07_03_000_drop_redundant_device_indexes": m034,
  "2026_07_03_000_repair_datetime_now_defaults": m035,
  "2026_07_04_000_storage_events_key_lookup": m036,
  "2026_07_05_000_repair_updated_at_defaults": m037,
  "2026_07_24_000_device_locks": m038,
  "2026_07_27_000_session_tool_capabilities": m039,
  "2026_07_31_000_video_recordings_owner_session": m040,
  "2026_08_02_000_navigation_provenance": m041,
  "2026_08_17_000_emulator_loss_incidents": m042,
  "2026_08_22_000_provision_device_operations": m043,
  "2026_08_22_001_session_tool_overrides": m044,
  "2026_08_22_002_navigation_observation_eviction_index": m045,
  "2026_08_22_003_device_teardown_operations": m046,
  "2026_08_23_000_device_teardown_operation_owner": m047,
  "2026_08_23_001_default_existing_delete_device_disabled": m048,
  "2026_08_24_000_installed_apps_profile_type": m049,
  "2026_09_06_000_tool_selection_profile_provenance": m050,
  "2026_09_08_000_provision_device_operations_expiry": m051,
  "2026_09_10_000_provision_device_operation_attempt": m052,
  "2026_09_10_001_device_session_retention_index": m053,
  "2026_09_13_000_device_snapshot_vm_reclaim": m054,
  "2026_09_14_000_device_session_stable_identity": m055,
  "2026_09_14_001_device_session_identity_writer_fence": m056,
  "2026_09_16_000_device_session_liveness_owner": m057,
  "2026_09_16_001_device_session_liveness_contract": m058,
  "2026_09_17_000_device_session_liveness_writer_fence": m059,
  "2026_09_17_001_device_session_identity_fence_same_serial": m060,
  "2026_09_20_000_provision_device_lifecycle_outcome": m061,
  "2026_09_29_000_navigation_suggestion_provenance": m062,
  "2026_09_30_000_video_recording_display": m063,
  "2026_09_30_001_network_capture_fields": m064,
  "2026_10_05_000_device_locks_device_identity": m065,
  "2026_10_05_001_storage_events_key_lookup_insertion_order": m066,
  "2026_10_05_002_test_edge_coverage_edge_id_index": m067,
  "2026_10_09_000_device_resource_applications": m068,
  "2026_10_09_001_drop_provision_device_operations": m069,
  "2026_10_09_002_drop_device_teardown_operations": m070,
  "2026_10_12_000_rename_recording_tool_names": m071,
  "2026_10_12_001_video_recording_capture_teardown": m072,
  "2026_10_13_000_video_recording_recorder_daemon": m073,
  "2026_10_15_000_device_session_activity_seq": m074,
  "2026_10_18_000_mcp_tasks": m075,
  "2026_10_26_000_prototype_test_sessions": m076,
};

export const staticMigrationProvider: MigrationProvider = {
  getMigrations: async () => ({ ...STATIC_MIGRATIONS }),
};
