package dev.jasonpearson.automobile.prototype.appshell

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [35], manifest = Config.NONE)
class PrototypeLaunchLinkTest {
  private fun link() = Intent(Intent.ACTION_VIEW, Uri.parse("amp-demo://post/41"))

  @Test
  fun `launch intent is consumed once even without a saved state`() {
    val intent = link()
    assertEquals("amp-demo://post/41", intent.takePrototypeLaunchLink(null))
    assertNull(intent.takePrototypeLaunchLink(null))
    assertNull(Intent(intent).takePrototypeLaunchLink(null))
  }

  @Test
  fun `recreation and recents history do not deliver the launch URL`() {
    assertNull(link().takePrototypeLaunchLink(Bundle()))
    assertNull(
      link().addFlags(Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY).takePrototypeLaunchLink(null),
    )
  }

  @Test
  fun `a fresh warm intent may deliver the same URL again`() {
    assertEquals(link().takePrototypeLaunchLink(null), link().takePrototypeLaunchLink(null))
  }
}
