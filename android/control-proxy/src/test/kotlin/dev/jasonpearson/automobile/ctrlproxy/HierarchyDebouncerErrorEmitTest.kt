package dev.jasonpearson.automobile.ctrlproxy

import dev.jasonpearson.automobile.ctrlproxy.models.ViewHierarchy
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class HierarchyDebouncerErrorEmitTest {

  /**
   * When extraction fails (returns null), a HierarchyResult.Error must be emitted on the flow.
   * Pre-fix an early `return` inside the try skipped the post-finally emit, so consumers never saw
   * the Error (#3608).
   */
  @Test
  fun `extraction failure emits an Error on the flow`() {
    val debouncer =
      HierarchyDebouncer(
        scope = CoroutineScope(Dispatchers.Unconfined),
        extractHierarchy = { _: Boolean, _: HierarchySnapshotOptions -> null as ViewHierarchy? },
      )

    debouncer.extractNowBlocking()

    val last = debouncer.hierarchyFlow.replayCache.lastOrNull()
    assertTrue("expected a HierarchyResult.Error, got $last", last is HierarchyResult.Error)
    assertTrue((last as HierarchyResult.Error).message.contains("Failed to extract"))
  }
}
