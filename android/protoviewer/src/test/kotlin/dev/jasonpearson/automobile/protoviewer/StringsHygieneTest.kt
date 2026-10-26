package dev.jasonpearson.automobile.protoviewer

import java.io.File
import javax.xml.XMLConstants
import javax.xml.parsers.DocumentBuilderFactory
import org.junit.Assert.assertTrue
import org.junit.Test
import org.w3c.dom.Node

class StringsHygieneTest {
  @Test
  fun everyStringHasAnAdjacentTranslatorComment() {
    val source = File(System.getProperty("user.dir"), "src/main/res/values/strings.xml")
    val factory = DocumentBuilderFactory.newInstance().apply {
      setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true)
      setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
    }
    val strings = factory.newDocumentBuilder().parse(source).getElementsByTagName("string")
    assertTrue("No strings found in $source", strings.length > 0)
    for (index in 0 until strings.length) {
      val string = strings.item(index)
      val name = string.attributes.getNamedItem("name").nodeValue
      var previous = string.previousSibling
      while (previous?.nodeType == Node.TEXT_NODE && previous.textContent.isBlank()) {
        previous = previous.previousSibling
      }
      val comment = previous?.takeIf { it.nodeType == Node.COMMENT_NODE }?.textContent.orEmpty()
      assertTrue("$name needs an immediately preceding translator comment", comment.isNotBlank())
      if (string.attributes.getNamedItem("translatable")?.nodeValue == "false") {
        assertTrue(
          "$name needs a reason for translatable=false",
          comment.contains("because", ignoreCase = true) ||
            comment.contains("reason:", ignoreCase = true),
        )
      }
    }
  }
}
