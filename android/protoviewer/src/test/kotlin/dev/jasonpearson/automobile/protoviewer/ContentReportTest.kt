package dev.jasonpearson.automobile.protoviewer

import android.content.Intent
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class ContentReportTest {
  @Test
  fun detailsIdentifyContentWithoutCarryingIt() {
    val entry = Fixtures.entry()
    assertEquals(
      "label: ${entry.label}\nspecSha256: ${entry.specSha256}\nsource: file",
      reportDetails(entry),
    )
    assertEquals(
      "label: ${entry.label}\nspecSha256: ${entry.specSha256}\nsource: share\nhost: proto.example.com",
      reportDetails(entry.copy(source = LibrarySource.share, sourceHost = "proto.example.com")),
    )
  }

  @Test
  fun intentAddressesThePublishedContact() {
    val intent = reportIntent("Subject", "Body")
    assertEquals(Intent.ACTION_SENDTO, intent.action)
    assertEquals("mailto:", intent.dataString)
    assertArrayEquals(arrayOf(REPORT_CONTACT_EMAIL), intent.getStringArrayExtra(Intent.EXTRA_EMAIL))
    assertEquals("Subject", intent.getStringExtra(Intent.EXTRA_SUBJECT))
    assertEquals("Body", intent.getStringExtra(Intent.EXTRA_TEXT))
  }
}
