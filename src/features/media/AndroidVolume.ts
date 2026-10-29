/**
 * Prefer the audio shell setter (API 34+): media_session can silently ignore writes on API 37.
 * Older releases fall back only on an unsupported-command/usage response, never on a permission
 * or transport failure. Preserve other output and the exit status for the caller's error handling.
 */
export function volumeSetScript(streamCode: number, level: number): string {
  return (
    `volume_output=$(cmd audio set-volume ${streamCode} ${level} 2>&1); volume_status=$?; ` +
    `case "$volume_output" in ` +
    `*"Unknown command"*|*"Unknown option"*|*"No shell command implementation"*|*"Can't find service"*|*"usage:"*|*"Usage:"*) ` +
    `cmd media_session volume --stream ${streamCode} --set ${level} ;; ` +
    `*) printf '%s\\n' "$volume_output"; (exit "$volume_status") ;; esac`
  );
}
