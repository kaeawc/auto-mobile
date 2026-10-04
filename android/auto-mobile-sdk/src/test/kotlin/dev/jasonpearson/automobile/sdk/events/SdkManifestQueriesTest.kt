package dev.jasonpearson.automobile.sdk.events

import dev.jasonpearson.automobile.sdk.SdkConstants
import java.io.File
import javax.xml.parsers.DocumentBuilderFactory
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import org.junit.Test
import org.w3c.dom.Element

class SdkManifestQueriesTest {
  @Test
  fun `manifest grants visibility only to the CtrlProxy package`() {
    // Gradle runs SDK unit tests with the SDK module as their working directory.
    val manifest = File(System.getProperty("user.dir"), "src/main/AndroidManifest.xml")
    val document =
      DocumentBuilderFactory.newInstance().run {
        isNamespaceAware = true
        newDocumentBuilder().parse(manifest)
      }
    val children = document.documentElement.childNodes
    val elements = (0 until children.length).map { children.item(it) }.filterIsInstance<Element>()
    val queries = elements.single { it.tagName == "queries" }.childNodes
    val queryEntries = (0 until queries.length).map { queries.item(it) }.filterIsInstance<Element>()

    assertEquals(listOf("package"), queryEntries.map { it.tagName })
    assertEquals(
      setOf(SdkConstants.CTRL_PROXY_PACKAGE),
      queryEntries.map { it.getAttributeNS(ANDROID_NAMESPACE, "name") }.toSet(),
    )
    assertFalse(
      elements.any {
        it.tagName.startsWith("uses-permission") &&
          it.getAttributeNS(ANDROID_NAMESPACE, "name") == "android.permission.QUERY_ALL_PACKAGES"
      }
    )
  }

  private companion object {
    const val ANDROID_NAMESPACE = "http://schemas.android.com/apk/res/android"
  }
}
