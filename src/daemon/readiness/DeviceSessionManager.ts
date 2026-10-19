/**
 * Transitional alias: the class is now `DeviceReadiness` (it holds no sessions). Importers that
 * have not migrated yet keep compiling through these names.
 */
export * from "./DeviceReadiness";
export { DeviceReadiness as DeviceSessionManager } from "./DeviceReadiness";
export type { DeviceReadinessOptions as DeviceSessionManagerOptions } from "./DeviceReadiness";
