/** Validate the platform version before it becomes a wire/cache key. */
export function iosBuildVersion(raw: string): { versionCode: number; versionKey?: string } | null {
  const trimmed = raw.trim();
  // 64 characters accommodates build labels while bounding wire/cache keys.
  // Metadata and provenance share the trimmed platform value.
  if (!trimmed || trimmed.length > 64 || /[\u0000-\u001f\u007f-\u009f]/.test(trimmed)) {
    return null;
  }
  const numeric = Number(trimmed);
  if (/^\d+$/.test(trimmed) && Number.isSafeInteger(numeric)) {
    return { versionCode: numeric };
  }
  return { versionCode: 0, versionKey: trimmed };
}
