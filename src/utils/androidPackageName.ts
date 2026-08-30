/**
 * Android application ID accepted at destructive package-scoped shell
 * boundaries. Requiring at least two Java-style segments also prevents a
 * numeric value from being interpreted as a PID by commands such as `am crash`.
 */
export const ANDROID_PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;
