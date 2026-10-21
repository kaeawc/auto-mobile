/**
 * Task-header line patterns of `dumpsys activity activities`, shared by the back-stack
 * parser (`GetBackStack`) and the windowing parser (`TaskWindowing`, #14115).
 */

/**
 * Legacy task header, printed by the pre-Android-10 `dumpsys` layout as either
 * "Task id #123" or `ActivityStack.dumpActivitiesLocked`'s `"    * " + task`,
 * i.e. "* TaskRecord{1d3813b #14418 A=com.example U=0 StackId=436 sz=2}".
 *
 * Anchored to the start of the line (issue #4263). `TaskRecord{...}` is printed
 * verbatim in at least two NON-header positions in real legacy output:
 *
 *     * Hist #1: ActivityRecord{...}
 *         frontOfTask=false task=TaskRecord{1d3813b #14418 A=... sz=2}
 *
 *     Running activities (most recent first):
 *       TaskRecord{1d3813b #14418 A=... sz=2}
 *
 * The first sits BETWEEN two `Hist` rows, so read as a header it splits one
 * task's activities across two headers and (before #4263) blanked the affinity
 * of every activity below it. Line-anchoring rejects it: it is always preceded
 * by `frontOfTask=<bool> task=`.
 *
 * The second IS at the start of its line, only without the bullet, so anchoring
 * alone cannot tell it apart from a real header -- and the bullet-less form is
 * itself pinned as a header by the #4223 suite. It is instead defused in
 * `parseTasks`, which resumes an already-seen task id rather than restarting
 * it, so a repeat cannot discard what was already parsed.
 *
 * The id is taken from the token right after the identity hash rather than by
 * the previous greedy scan, which captured the last "#number" on the line.
 */
export const LEGACY_TASK_HEADER =
  /^\s*(?:Task\s+id\s+#(\d+)\b|\*?\s*TaskRecord\{\S+\s+#(\d+)\b(.*))$/;

/**
 * Modern task header (issue #4223). `TaskFragment.dumpInner` prints
 *
 *     pw.print(prefix); pw.print("* "); pw.println(toFullString());
 *
 * and `Task.toString()` -- which `Task.toFullString()` extends -- opens with
 * "Task{" + hex identity hash + " #" + mTaskId before any optional field. The
 * id is therefore the only positionally stable token after the hash: `A=` /
 * `I=` / `aI=` are mutually exclusive and `rootTaskId=` appears only for
 * non-root tasks, so everything past the id is matched by key instead.
 *
 * The leading "* " is required. `Task{...}` also appears inline elsewhere in
 * dumpsys output (adjacent-task-fragment references, child lists), and an
 * unanchored match would invent tasks out of those references. `TaskFragment{`
 * is a different `toString()` with no "#id" and does not match "Task\{".
 *
 * Source: AOSP android15-release,
 * services/core/java/com/android/server/wm/Task.java (toString, toFullString)
 * and .../TaskFragment.java (dumpInner).
 */
export const MODERN_TASK_HEADER = /^\s*\*\s*Task\{\S+\s+#(\d+)\b(.*)$/;
