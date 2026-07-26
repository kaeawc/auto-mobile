package dev.jasonpearson.automobile.desktop.domain

/** What a client should be showing after it forwarded an input action (issue #3348). */
public enum class PostInputRefreshState {
  /** No input has been forwarded since the last settle; the inspector renders the live snapshot. */
  Idle,

  /**
   * An input was forwarded successfully and the client is waiting for the first snapshot that
   * *supersedes* the one the input was dispatched through. The pre-input snapshot stays on screen
   * and stays clickable — it is still the best available truth, and the daemon's `input/tap`
   * response carries only the action result, never an observation.
   */
  AwaitingSnapshot,

  /** A superseding snapshot arrived (or the wait timed out); the inspector is current again. */
  Settled,
}

/**
 * The post-input inspector refresh policy for any daemon client that both forwards input and
 * renders observed state (issue #3348, part of #1099).
 *
 * The daemon's input responses (`input/tap` and its siblings) return the action result only: they
 * do **not** carry a fresh observation and do **not** implicitly trigger one. So a client must
 * decide, itself, when the picture it is showing is current again. This policy says: **consume the
 * next superseding snapshot from the observation stream you are already subscribed to — never
 * poll.**
 *
 * Expressed as snapshot transitions, so it is reproducible by a non-desktop client:
 * - **Success.** The client records the [DeviceFrameSnapshot.captureSequence] it dispatched through
 *   and enters [PostInputRefreshState.AwaitingSnapshot]. It keeps rendering the pre-input snapshot
 *   — pixels, dimensions and tree together — and does not clear, blank, or re-request anything. The
 *   wait settles on the first snapshot from a strictly greater **capture**. Because a snapshot only
 *   exists when its screenshot and hierarchy share a capture identity, "settled" means *both* have
 *   caught up; a duplicate or keepalive screenshot still belonging to the pre-input capture does
 *   not settle it, even though it advances the client's own source counter.
 * - **Timeout.** If no superseding snapshot arrives within [REFRESH_TIMEOUT_MS], the wait settles
 *   anyway. The ordinary freshness bound in [DeviceControlPolicy] independently retires the stale
 *   frame and drops control, so a timeout degrades to inspector mode rather than to a false
 *   "current" claim.
 * - **Failure.** A rejected or failed input changed nothing on the device, so nothing on screen is
 *   stale. The client settles immediately and clears **no** state: not the screenshot, not the
 *   hierarchy, not selection. It surfaces the daemon's actionable error instead.
 * - **Selection and hover.** Deterministic and unchanged by this policy: control mode suppresses
 *   both (they are cleared when the view enters control mode and never set while in it), so after a
 *   forwarded input selection and hover are null regardless of success or failure. When the view
 *   returns to inspector mode, selection is re-derived from the snapshot then current — an element
 *   id that no longer exists in the new hierarchy is dropped, which is the pre-existing inspector
 *   behavior.
 * - **Context change.** Any device switch, stream disconnect or mode change resets the tracker
 *   ([reset]); an input dispatched in a previous context never settles a wait in the new one.
 *
 * Pure and Compose-free; `nowMs` is supplied by the caller so tests need no real timers.
 */
public class PostInputRefreshTracker(private val timeoutMs: Long = REFRESH_TIMEOUT_MS) {
  private var awaitingAfterCapture: Long? = null
  private var awaitingSinceMs: Long = 0L

  /** Current state; see [PostInputRefreshState]. */
  public var state: PostInputRefreshState = PostInputRefreshState.Idle
    private set

  /**
   * Record that an input was forwarded successfully through [snapshot]. Starts waiting for the
   * first snapshot with a strictly greater sequence.
   */
  public fun onInputSucceeded(snapshot: DeviceFrameSnapshot, nowMs: Long) {
    awaitingAfterCapture = snapshot.captureSequence
    awaitingSinceMs = nowMs
    state = PostInputRefreshState.AwaitingSnapshot
  }

  /**
   * Record that a forwarded input failed. Settles immediately: the device did not change, so no
   * inspector state is stale and none is cleared.
   */
  public fun onInputFailed() {
    awaitingAfterCapture = null
    state = PostInputRefreshState.Settled
  }

  /**
   * Offer the newest snapshot. Settles the wait when [snapshot] comes from a strictly newer capture
   * than the one the input was dispatched through. Returns true when this call settled a pending
   * wait.
   */
  public fun onSnapshot(snapshot: DeviceFrameSnapshot, nowMs: Long): Boolean {
    val awaited = awaitingAfterCapture ?: return false
    // A NEWER CAPTURE, not merely a newer client-side source sequence. The client bumps its source
    // sequence for every screenshot it applies — including a duplicate or keepalive frame that
    // still belongs to the pre-input capture — so settling on that would report "the device caught
    // up" the moment any frame arrived, contradicting this policy's guarantee that both the
    // screenshot and the hierarchy moved on.
    if (snapshot.captureSequence <= awaited && nowMs - awaitingSinceMs < timeoutMs) return false
    awaitingAfterCapture = null
    state = PostInputRefreshState.Settled
    return true
  }

  /**
   * Settle a wait that has exceeded [timeoutMs] even though no snapshot arrived at all. Returns
   * true when this call settled a pending wait.
   */
  public fun onTick(nowMs: Long): Boolean {
    if (awaitingAfterCapture == null) return false
    if (nowMs - awaitingSinceMs < timeoutMs) return false
    awaitingAfterCapture = null
    state = PostInputRefreshState.Settled
    return true
  }

  /** Drop any pending wait, e.g. on a device switch, stream disconnect or mode change. */
  public fun reset() {
    awaitingAfterCapture = null
    state = PostInputRefreshState.Idle
  }

  public companion object {
    /**
     * How long a client waits for the observation stream to supersede the dispatched snapshot
     * before giving up. Comfortably longer than a device's response to a tap plus one observation
     * round trip, and shorter than [DeviceControlPolicy.SCREENSHOT_MAX_AGE_MS] would allow a frame
     * to look fresh.
     */
    public const val REFRESH_TIMEOUT_MS: Long = 3_000L
  }
}
