package dev.jasonpearson.automobile.desktop.core.platform

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.rules.TemporaryFolder

/**
 * Regression coverage for #3609: the file-save write path used to swallow failures (permissions,
 * disk full, invalid path) in an empty catch, so an export could silently do nothing. [writeFile]
 * now returns the outcome as a [Result] so callers can log/surface it.
 */
class FileSaverTest {
  @get:Rule val tempFolder = TemporaryFolder()

  @Test
  fun `writeFile writes content and returns the absolute path on success`() {
    val target = File(tempFolder.root, "export.json")

    val result = writeFile(target, "{\"ok\":true}")

    assertTrue(result.isSuccess, "a writable target should succeed")
    assertEquals(target.absolutePath, result.getOrNull())
    assertEquals("{\"ok\":true}", target.readText())
  }

  @Test
  fun `writeFile surfaces a failure instead of swallowing it when the write cannot complete`() {
    // Parent directory does not exist -> writeText throws; the old empty catch hid this.
    val target = File(tempFolder.root, "missing-subdir/export.json")

    val result = writeFile(target, "payload")

    assertTrue(result.isFailure, "an unwritable target should surface a failure, not be swallowed")
    assertFalse(target.exists())
  }
}
