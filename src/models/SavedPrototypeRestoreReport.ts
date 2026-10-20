export interface SavedPrototypeRestoreReport {
  restored: string[];
  skipped: string[];
  failed: { id: string; code: string; reason: string }[];
}
