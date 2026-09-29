package dev.jasonpearson.automobile.desktop.core.daemon

import kotlin.test.Test
import kotlin.test.assertEquals

class AutoMobileSocketPathsTest {

  private val userHome = "/test/home"
  private val userDir = "/test/working"

  @Test
  fun `absolute override selects auxiliary socket directory`() {
    assertEquals(
      "/tmp/custom-aux",
      AutoMobileSocketPaths.resolveSocketDir(
        envProvider = { if (it == "AUTOMOBILE_AUX_SOCKET_DIR") "/tmp/custom-aux" else null },
        userHome = userHome,
        userDir = userDir,
      ),
    )
  }

  @Test
  fun `blank override falls back to home directory`() {
    assertEquals(
      "/test/home/.auto-mobile",
      AutoMobileSocketPaths.resolveSocketDir(
        envProvider = { if (it == "AUTOMOBILE_AUX_SOCKET_DIR") "   " else null },
        userHome = userHome,
        userDir = userDir,
      ),
    )
  }

  @Test
  fun `unset override falls back to home directory`() {
    assertEquals(
      "/test/home/.auto-mobile",
      AutoMobileSocketPaths.resolveSocketDir(
        envProvider = { null },
        userHome = userHome,
        userDir = userDir,
      ),
    )
  }

  @Test
  fun `absolute override preserves trailing slash verbatim`() {
    assertEquals(
      "/tmp/custom-aux/",
      AutoMobileSocketPaths.resolveSocketDir(
        envProvider = { if (it == "AUTOMOBILE_AUX_SOCKET_DIR") "/tmp/custom-aux/" else null },
        userHome = userHome,
        userDir = userDir,
      ),
    )
  }
}
