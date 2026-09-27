package dev.jasonpearson.automobile.ctrlproxy

import java.util.concurrent.atomic.AtomicLong

/** Local work counters; kept out of the wire protocol. */
internal class CtrlProxyWorkStats {
  val accessibilityEvents = AtomicLong()
  val extractions = AtomicLong()
  val unchangedCaptures = AtomicLong()
  val coalescedEvents = AtomicLong()
  val nodesVisited = AtomicLong()
  val occlusionCandidateComparisons = AtomicLong()
  val occlusionIndexEntriesVisited = AtomicLong()
  val forwardedLogLines = AtomicLong()
  val droppedInternalLogLines = AtomicLong()
  val droppedOverflowLogLines = AtomicLong()
}
