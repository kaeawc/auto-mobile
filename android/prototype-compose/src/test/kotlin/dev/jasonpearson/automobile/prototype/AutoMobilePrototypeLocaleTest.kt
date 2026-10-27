package dev.jasonpearson.automobile.prototype

import android.content.res.Configuration
import android.os.LocaleList
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.mutableStateOf
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.test.assertTextEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import kotlinx.coroutines.sync.Mutex
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.BeforeClass
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

@RunWith(RobolectricTestRunner::class)
class AutoMobilePrototypeLocaleTest {
  @get:Rule val compose = createComposeRule()
  private val host = EmbeddedPrototypeTestHost()

  companion object {
    @JvmStatic @BeforeClass fun warmValidator() = warmEmbeddedValidator()
  }

  @After fun close() = host.close()

  @Test
  fun `runtime is localized before publication and follows later configuration changes`() {
    val initialLocales = mutableListOf<List<String>>()
    val embeddedHost =
      EmbeddedPrototypeHost(host.scope.backgroundScope, Mutex(), host.dispatcher).apply {
        onRuntime = { initialLocales += it.current.locales }
      }
    val environment =
      EmbeddedPrototypeEnvironment(
        io = host.dispatcher,
        scope = host.scope.backgroundScope,
        host = embeddedHost,
      )
    val language = mutableStateOf("fr")
    val input =
      embeddedSpec(
        """{"type":"text","testTag":"greeting","text":"{t:hello}","semantics":{"liveRegion":"polite"}}""",
        """"strings":{"default":{"hello":"Hello"},"fr":{"hello":"Bonjour"}},""",
      )
    compose.setContent {
      val configuration = Configuration(LocalConfiguration.current)
      configuration.setLocales(LocaleList.forLanguageTags(language.value))
      host.Content {
        CompositionLocalProvider(
          LocalConfiguration provides configuration,
          LocalEmbeddedPrototypeEnvironment provides environment,
        ) {
          AutoMobilePrototype(input)
        }
      }
    }
    compose.onNodeWithTag("greeting").assertTextEquals("Bonjour")
    compose.runOnIdle {
      assertEquals(listOf(listOf("fr")), initialLocales)
      language.value = "en"
    }
    compose.onNodeWithTag("greeting").assertTextEquals("Hello")
    compose.runOnIdle { assertEquals(1, initialLocales.size) }
  }
}
