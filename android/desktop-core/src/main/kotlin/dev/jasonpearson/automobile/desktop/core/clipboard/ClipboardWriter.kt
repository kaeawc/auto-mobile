package dev.jasonpearson.automobile.desktop.core.clipboard

import androidx.compose.runtime.staticCompositionLocalOf
import java.awt.Toolkit
import java.awt.datatransfer.StringSelection

/**
 * Narrow seam for writing text to the system clipboard. Introduced for the inspector export
 * affordances (#5205) so the copy actions can be unit-tested behind a fake instead of touching the
 * real AWT clipboard.
 */
interface ClipboardWriter {
  fun writeText(text: String)
}

/** Production [ClipboardWriter] backed by the AWT system clipboard. */
class AwtClipboardWriter : ClipboardWriter {
  override fun writeText(text: String) {
    Toolkit.getDefaultToolkit().systemClipboard.setContents(StringSelection(text), null)
  }
}

/**
 * Test/fake [ClipboardWriter] that records every write and never touches the system clipboard.
 * Co-located with the interface per the repo's interface+fake convention.
 */
class FakeClipboardWriter : ClipboardWriter {
  val writes: MutableList<String> = mutableListOf()

  val lastText: String?
    get() = writes.lastOrNull()

  override fun writeText(text: String) {
    writes.add(text)
  }
}

/**
 * Composition-local [ClipboardWriter]. Defaults to the real AWT clipboard so production composables
 * work with no wiring; tests (or a headless host) can provide a [FakeClipboardWriter] instead.
 */
val LocalClipboardWriter = staticCompositionLocalOf<ClipboardWriter> { AwtClipboardWriter() }
