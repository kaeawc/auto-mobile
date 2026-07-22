/**
 * POSIX shell quoting for values that must survive a shell that is NOT ours.
 *
 * Host-side execution in this repo goes through `execFile`/`spawn` with an argv
 * array, so no host shell is involved. But `adb shell <cmd>` is different: adb
 * concatenates its remaining arguments with spaces and hands the result to
 * `/system/bin/sh` ON THE DEVICE, which then does full word splitting and
 * expansion. Any caller-supplied value embedded in such a command must therefore
 * be quoted for that device shell.
 *
 * Double quotes are not enough — `$`, backticks and `\` stay live inside them.
 * Single quotes are the only POSIX construct that suppresses every expansion.
 */

/**
 * Wrap `value` in single quotes so a POSIX shell sees it as exactly one literal
 * word. A single quote cannot appear inside a single-quoted string, so each one
 * is emitted as `'\''` — close, escaped literal quote, reopen.
 * @param value - Raw value to quote
 * @returns The value as a single, fully literal shell word
 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
