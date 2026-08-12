package dev.jasonpearson.automobile.desktop.core.update

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** Parsing of the GitHub `releases/latest` body (AC2/AC4) without a network round-trip. */
class GitHubReleaseParsingTest {

  private val body =
    """
    {
      "tag_name": "v0.0.53",
      "draft": false,
      "prerelease": false,
      "html_url": "https://github.com/kaeawc/auto-mobile/releases/tag/v0.0.53",
      "assets": [
        {"name": "AutoMobile-0.0.53-macos.dmg", "browser_download_url": "https://x/dmg", "size": 111, "extra": "ignored"},
        {"name": "AutoMobile-0.0.53-windows.msi", "browser_download_url": "https://x/msi", "size": 222},
        {"name": "AutoMobile-0.0.53-linux.deb", "browser_download_url": "https://x/deb", "size": 333}
      ],
      "unknown_top_level": true
    }
    """
      .trimIndent()

  @Test
  fun `parses tag, flags, notes url, and assets, ignoring unknown fields`() {
    val info = parseLatestRelease(body)
    assertEquals("v0.0.53", info.tagName)
    assertFalse(info.isDraft)
    assertFalse(info.isPrerelease)
    assertEquals("https://github.com/kaeawc/auto-mobile/releases/tag/v0.0.53", info.htmlUrl)
    assertEquals(3, info.assets.size)
    val mac = info.assets.first { it.name.endsWith("macos.dmg") }
    assertEquals("https://x/dmg", mac.downloadUrl)
    assertEquals(111L, mac.sizeBytes)
  }

  @Test
  fun `drops assets missing or blank a name or download url`() {
    val partial =
      """
      {"tag_name":"v1.0.0","assets":[
        {"name":"only-name.dmg"},
        {"browser_download_url":"https://x/nameless"},
        {"name":"blank-url.dmg","browser_download_url":"","size":1},
        {"name":"","browser_download_url":"https://x/blank-name","size":2},
        {"name":"AutoMobile-1.0.0-linux.deb","browser_download_url":"https://x/deb","size":9}
      ]}
      """
        .trimIndent()
    val info = parseLatestRelease(partial)
    assertEquals(1, info.assets.size)
    assertEquals("AutoMobile-1.0.0-linux.deb", info.assets.single().name)
  }

  @Test
  fun `a body without tag_name is a fetch failure`() {
    assertFailsWith<ReleaseFetchException> { parseLatestRelease("""{"draft":false}""") }
  }

  @Test
  fun `malformed json is a fetch failure`() {
    assertFailsWith<ReleaseFetchException> { parseLatestRelease("not json at all") }
  }

  @Test
  fun `prerelease flag is carried through`() {
    val info = parseLatestRelease("""{"tag_name":"v2.0.0-rc.1","prerelease":true}""")
    assertTrue(info.isPrerelease)
  }
}
