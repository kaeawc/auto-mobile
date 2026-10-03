package dev.jasonpearson.automobile.mediaplayer

import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test

class VideoLookupTest {
  @Test
  fun knownIdReturnsEntry() {
    assertSame(VideoData.AUTO_MOBILE, findVideoById("auto-mobile"))
  }

  @Test
  fun unknownIdReturnsNull() {
    assertNull(findVideoById("unknown-video"))
  }

  @Test
  fun emptyCatalogueReturnsNull() {
    assertNull(findVideoById("auto-mobile", emptyList()))
  }

  @Test
  fun staleIdReturnsNull() {
    assertNull(findVideoById("removed-video", listOf(VideoData.AUTO_MOBILE)))
  }

  @Test
  fun emptyIdReturnsNull() {
    assertNull(findVideoById(""))
  }
}
