package dev.jasonpearson.automobile.demos

/** Row count of the shared-row-id list; enough rows that a page swipe replaces every visible row. */
const val SHARED_ROW_ID_ROW_COUNT = 60

/**
 * Visible labels for the shared-row-id list. Every row shares one resource id, so the label is the
 * only thing that tells rows apart. Numbers are zero-padded so no label is a prefix of another.
 */
fun sharedRowIdLabels(count: Int = SHARED_ROW_ID_ROW_COUNT): List<String> {
  val width = count.toString().length
  return (1..count).map { index -> "Shared row ${index.toString().padStart(width, '0')}" }
}
