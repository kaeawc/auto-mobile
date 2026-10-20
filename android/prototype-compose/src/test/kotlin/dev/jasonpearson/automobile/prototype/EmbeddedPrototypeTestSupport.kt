package dev.jasonpearson.automobile.prototype

import androidx.activity.OnBackPressedDispatcher
import androidx.activity.OnBackPressedDispatcherOwner
import androidx.activity.compose.LocalOnBackPressedDispatcherOwner
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleRegistry
import androidx.lifecycle.compose.LocalLifecycleOwner
import dev.jasonpearson.automobile.protocol.PrototypeRequestResponse
import dev.jasonpearson.automobile.protocol.PrototypeSpecValidator
import dev.jasonpearson.automobile.protocol.PrototypeStoredValues
import java.io.File
import kotlinx.coroutines.cancel
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.serialization.json.JsonPrimitive

internal class FakePrototypeStorage(private val loadFailure: Exception? = null) : PrototypeStorage {
  private val values = mutableMapOf<String, PrototypeStoredValues>()
  var saves = 0
    private set

  @Synchronized
  override fun load(id: String): PrototypeStoredValues? {
    loadFailure?.let { throw it }
    return values[id]
  }

  @Synchronized
  override fun save(id: String, values: PrototypeStoredValues) {
    saves++
    this.values[id] = values
  }

  @Synchronized
  override fun delete(id: String) {
    values.remove(id)
  }
}

internal class FakePrototypeHttp : PrototypeHttpClient {
  val requests = mutableListOf<PrototypeHttpRequest>()

  override suspend fun execute(request: PrototypeHttpRequest): PrototypeRequestResponse {
    requests += request
    return PrototypeRequestResponse.Received(200, emptyMap(), JsonPrimitive("ok"), 9)
  }
}

internal class EmbeddedPrototypeTestHost {
  val dispatcher = UnconfinedTestDispatcher()
  val scope = TestScope(dispatcher)
  var unhandledBacks = 0
    private set

  val owner =
    object : OnBackPressedDispatcherOwner {
      override val onBackPressedDispatcher = OnBackPressedDispatcher(Runnable { unhandledBacks++ })
      override val lifecycle =
        LifecycleRegistry.createUnsafe(this).apply { currentState = Lifecycle.State.RESUMED }
    }
  private var requestId = 0
  private val environment =
    EmbeddedPrototypeEnvironment(
      io = dispatcher,
      clock = { scope.testScheduler.currentTime },
      scope = scope.backgroundScope,
      requestId = { "request-${++requestId}" },
    )

  @Composable
  fun Content(content: @Composable () -> Unit) {
    CompositionLocalProvider(
      LocalEmbeddedPrototypeEnvironment provides environment,
      LocalLifecycleOwner provides owner,
      LocalOnBackPressedDispatcherOwner provides owner,
      content = content,
    )
  }

  fun close() {
    scope.backgroundScope.cancel()
    scope.cancel()
  }
}

internal fun fixtureFile(path: String): File =
  generateSequence(File(System.getProperty("user.dir") ?: ".").absoluteFile) { it.parentFile }
    .map { File(it, "test/fixtures/$path") }
    .first { it.exists() }

internal fun warmEmbeddedValidator() {
  PrototypeSpecValidator.validate("{}")
}

internal fun embeddedSpec(root: String, extra: String = ""): String =
  """{"id":"embedded","motion":"none","window":{"placement":{"type":"fullscreen"}},$extra"root":$root}"""

internal fun requestSpec(via: String? = null): String {
  val route = via?.let { """, "via":"$it"""" }.orEmpty()
  return embeddedSpec(
    """{"type":"button","testTag":"go","label":"Go","onTap":[{"type":"request","url":"https://example.test/feed","into":"/data/feed","statusKey":"status"$route}]}""",
    """"state":{"status":"idle"},"data":{},""",
  )
}
