package dev.jasonpearson.automobile.discover.ictrace

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class IcTraceComparisonTest {
  @Test
  fun `compares synthetic keyboard captures ignoring time and reporting identity`() {
    val result =
      IcTraceComparison.compareJsonl(
        fixture("gboard-reference.jsonl"),
        fixture("samsung-candidate.jsonl"),
      )

    assertEquals(
      IcTraceComparison.Result.Equivalent(
        eventCount = 2,
        referenceKeyboard =
          IcTraceComparison.KeyboardIdentity(
            "com.google.android.inputmethod.latin/.LatinIME",
            "fixture",
          ),
        candidateKeyboard =
          IcTraceComparison.KeyboardIdentity(
            "com.samsung.android.honeyboard/.service.HoneyBoardService",
            "fixture",
          ),
      ),
      result,
    )
  }

  @Test
  fun `reports operation result selection composition and metadata differences`() {
    val reference = event(call = "setComposingText", result = true)
    val candidate =
      event(call = "commitText", result = false).copy(selectionEnd = 4, composingEnd = -1)
    val environmentMismatch = candidate.copy(metadata = candidate.metadata.copy(inputType = 2))

    val result = IcTraceComparison.compare(listOf(reference), listOf(environmentMismatch))

    assertTrue(result is IcTraceComparison.Result.Different)
    assertEquals(
      listOf(
        "events[0].metadata",
        "events[0].call",
        "events[0].result",
        "events[0].selectionEnd",
        "events[0].composingEnd",
      ),
      (result as IcTraceComparison.Result.Different).mismatches.map { it.location },
    )
  }

  @Test
  fun `reports both keyboard identities when captures differ`() {
    val referenceIdentity = IcTraceComparison.KeyboardIdentity("reference.ime", "1.0")
    val candidateIdentity = IcTraceComparison.KeyboardIdentity("candidate.ime", "2.0")
    val reference =
      event(
        metadata =
          IcTraceMetadata(
            scenario = "scenario",
            keyboardId = referenceIdentity.id,
            keyboardVersion = referenceIdentity.version,
          ),
      )
    val candidate =
      event(
        call = "setComposingText",
        metadata =
          IcTraceMetadata(
            scenario = "scenario",
            keyboardId = candidateIdentity.id,
            keyboardVersion = candidateIdentity.version,
          ),
      )

    val result = IcTraceComparison.compare(listOf(reference), listOf(candidate))

    assertTrue(result is IcTraceComparison.Result.Different)
    val different = result as IcTraceComparison.Result.Different
    assertEquals(listOf("events[0].call"), different.mismatches.map { it.location })
    assertEquals(referenceIdentity, different.referenceKeyboard)
    assertEquals(candidateIdentity, different.candidateKeyboard)
  }

  @Test
  fun `reports incomplete and malformed captures as inconclusive`() {
    val dropped = event().copy(droppedEvents = 1)
    val droppedResult = IcTraceComparison.compare(listOf(dropped), listOf(event()))
    assertTrue(droppedResult is IcTraceComparison.Result.Inconclusive)
    assertTrue(
      (droppedResult as IcTraceComparison.Result.Inconclusive).reasons.any { "dropped" in it },
    )

    val sequenceGap =
      IcTraceComparison.compare(listOf(event(), event().copy(seq = 3)), listOf(event()))
    assertTrue(sequenceGap is IcTraceComparison.Result.Inconclusive)
    assertTrue(
      (sequenceGap as IcTraceComparison.Result.Inconclusive).reasons.any { "sequence gap" in it },
    )

    val afterClear =
      IcTraceComparison.compare(
        listOf(event().copy(seq = 2), event().copy(seq = 3)),
        listOf(event(), event().copy(seq = 2)),
      )
    assertTrue(afterClear is IcTraceComparison.Result.Equivalent)

    val changedKeyboard =
      IcTraceComparison.compare(
        listOf(event(), event().copy(seq = 2, metadata = IcTraceMetadata(keyboardId = "other"))),
        listOf(event(), event().copy(seq = 2)),
      )
    assertTrue(changedKeyboard is IcTraceComparison.Result.Inconclusive)
    assertTrue(
      (changedKeyboard as IcTraceComparison.Result.Inconclusive).reasons.any {
        "keyboard identity" in it
      },
    )

    val malformed =
      IcTraceComparison.compareJsonl("{not-json}", IcTraceFormatter.format(listOf(event())))
    assertTrue(malformed is IcTraceComparison.Result.Inconclusive)
    assertTrue((malformed as IcTraceComparison.Result.Inconclusive).reasons.any { "line 1" in it })
  }

  @Test
  fun `reads pre-extension JSONL using default outcome and metadata fields`() {
    val oldEvent =
      """{"seq":1,"elapsedMs":12,"call":"commitText","args":"","selectionStart":0,"selectionEnd":0,"composingStart":-1,"composingEnd":-1}"""

    val result = IcTraceComparison.compareJsonl(oldEvent, oldEvent)

    assertTrue(result is IcTraceComparison.Result.Equivalent)
  }

  private fun event(
    call: String = "commitText",
    result: Boolean? = true,
    metadata: IcTraceMetadata = IcTraceMetadata(scenario = "scenario"),
  ) = IcTraceEvent(1, 0, call, "", 0, 3, 0, 3, result, metadata = metadata)

  private fun fixture(name: String): String =
    javaClass.getResource("/ictrace/$name")!!.readText().trim()
}
