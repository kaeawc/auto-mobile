package dev.jasonpearson.automobile.protoviewer

import java.io.File
import org.junit.Assert.*
import org.junit.Test

internal fun webViewFixture(): String =
  generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
    .map { File(it, "test/fixtures/prototype-spec/valid/webview-node.json") }
    .first { it.isFile }
    .readText()

class ViewerImportTest {
  @Test
  fun savedSpecDecisionTracksFakeSettings() {
    val settings = FakeSettingsStore()
    val spec = webViewFixture()
    assertEquals("root.children[1]", viewerImportError(spec, settings.allowNetwork.value)?.path)
    settings.setAllowNetwork(true)
    assertNull(viewerImportError(spec, settings.allowNetwork.value))
    settings.setAllowNetwork(false)
    assertNotNull(viewerImportError(spec, settings.allowNetwork.value))
    assertNull(viewerImportError(SPEC, settings.allowNetwork.value))
  }
}
