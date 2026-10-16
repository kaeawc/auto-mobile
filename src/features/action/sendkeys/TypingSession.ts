/** Mutable state shared by every command and in-flight call on one executor.
 * Keep the original lifetimes: only explicit caret resets clear unsafe state;
 * password routing survives typing for the final target check; IME users are
 * pinned and cleared under the device IME lock.
 */
export class TypingSession {
  androidCaretUnsafe = false;
  imeUserId: number | undefined;
  typingPasswordField = false;
}
