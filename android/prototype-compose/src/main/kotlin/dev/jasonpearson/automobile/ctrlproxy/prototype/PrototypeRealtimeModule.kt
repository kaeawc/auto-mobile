package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.prototype.PlatformAvailability
import dev.jasonpearson.automobile.prototype.PlatformCall
import dev.jasonpearson.automobile.prototype.PlatformCallResult
import dev.jasonpearson.automobile.prototype.PlatformError
import dev.jasonpearson.automobile.prototype.PlatformErrorCode
import dev.jasonpearson.automobile.prototype.PlatformEvent
import dev.jasonpearson.automobile.prototype.PrototypePlatformModule
import kotlin.random.Random
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** What a runtime needs to own realtime channels (#14269): a transport per `via` and jitter. */
@InternalAutoMobilePrototypeApi
class PrototypeRealtimeConfig(
  val transports: PrototypeChannelTransports,
  val random: Random = Random.Default,
)

/**
 * The `realtime` module of one runtime (#14269), constructed per runtime like the device module, so
 * two shown prototypes never share a channel.
 *
 * Lock order: the controller's lock is outer and the runtime's interaction lock inner. The runtime
 * never calls the controller while it holds its lock: [update], [show] and [close] are posted to
 * one ordered inbox on the request scope, and `realtime.*` calls go through the same inbox, outside
 * the interaction lock, so a call made in the same interaction as a show sees its declarations. The
 * controller's effects reach the runtime through the [PrototypeChannelSink] the runtime passes,
 * which takes the interaction lock itself.
 *
 * Its [state] and [events] stay empty: the sink publishes `/platform/realtime` and delivers
 * `realtime.*` events directly, inside the same lock as the actions they accompany, so a status
 * event and its `statusKey` write cannot reorder against frames.
 */
internal class PrototypeRealtimeModule(
  prototypeId: String,
  config: PrototypeRealtimeConfig,
  sink: PrototypeChannelSink,
  scope: CoroutineScope,
  private val onError: (Throwable) -> Unit,
  newId: () -> String,
) : PrototypePlatformModule {
  override val name = NAME
  override val capability = CAPABILITY

  override fun availability() = PlatformAvailability.Ready

  override val state = MutableStateFlow(JsonObject(emptyMap())).asStateFlow()
  override val events = emptyFlow<PlatformEvent>()

  private val controller =
    PrototypeChannelController(
      prototypeId,
      config.transports,
      sink,
      scope,
      config.random,
      onError,
      newId,
    )
  private val inbox = Channel<suspend () -> Unit>(Channel.UNLIMITED)

  init {
    scope.launch {
      for (work in inbox) {
        try {
          work()
        } catch (cancelled: CancellationException) {
          throw cancelled
        } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
          // One failed operation must not stop the inbox: later calls and close() still run.
          onError(error)
        }
      }
    }
  }

  /** The spec's channels as declared at a show or patch; unchanged ones are left alone. */
  fun update(channels: Map<String, PrototypeChannelDeclaration>) {
    inbox.trySend { controller.update(channels) }
  }

  /** The prototype is shown: connect its `onShow` channels. */
  fun show() {
    inbox.trySend { controller.show() }
  }

  /** Dismissal or replacement: closes every connection, then stops the inbox. */
  override fun close() {
    controller.beginClose()
    inbox.trySend { controller.close() }
    inbox.close()
  }

  override suspend fun call(call: PlatformCall): PlatformCallResult {
    val channel = (call.args["channel"] as? JsonPrimitive)?.content ?: return invalid("channel")
    val body = if (call.call == SEND) sendText(call.args) ?: return invalid("body") else null
    val result = CompletableDeferred<PrototypeChannelError?>()
    val caller = currentCoroutineContext()[Job]
    val queued =
      inbox
        .trySend {
          // A call cancelled (timed out or dismissed) while it waited in the inbox does nothing.
          if (caller?.isActive == false) return@trySend
          try {
            result.complete(
              when (call.call) {
                CONNECT -> controller.connect(channel)
                DISCONNECT -> controller.disconnect(channel)
                // Checked again under the controller lock: the caller may time out waiting for it.
                SEND -> controller.send(channel, checkNotNull(body)) { caller?.isActive != false }
                else -> unsupported(call.call)
              },
            )
          } catch (cancelled: CancellationException) {
            result.cancel(cancelled)
            throw cancelled
          } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
            result.complete(failed(call.call, error))
            throw error
          }
        }
        .isSuccess
    if (!queued) {
      return PlatformCallResult.Failure(
        PlatformError(PlatformErrorCode.CANCELLED, "The prototype's channels are closed"),
      )
    }
    return result.await()?.let { PlatformCallResult.Failure(it.toPlatformError()) }
      ?: PlatformCallResult.Success(JsonObject(emptyMap()))
  }

  private fun failed(call: String, error: Exception) =
    PrototypeChannelError(PLATFORM_ERROR, error.message ?: "$call failed")

  private fun unsupported(call: String) =
    PrototypeChannelError(PrototypeChannelError.INVALID_REQUEST, "$call is not a realtime call")

  private fun invalid(arg: String) =
    PlatformCallResult.Failure(
      PlatformError(PlatformErrorCode.INVALID_ARGS, "realtime calls require $arg"),
    )

  companion object {
    const val NAME = "realtime"
    const val CAPABILITY = "prototype_platform_realtime_v1"
    const val CONNECT = "realtime.connect"
    const val DISCONNECT = "realtime.disconnect"
    const val SEND = "realtime.send"
    private const val PLATFORM_ERROR = "platform_error"

    /** A string body goes on the wire as written and any other JSON as compact JSON text. */
    internal fun sendText(args: JsonObject): String? =
      when (val body = args["body"]) {
        null -> null
        is JsonPrimitive -> if (body.isString) body.content else body.toString()
        else -> body.toString()
      }
  }
}

/** Refusals keep their channel code as the reason; only the shared ones map one to one. */
internal fun PrototypeChannelError.toPlatformError(): PlatformError =
  when (code) {
    PrototypeChannelError.INVALID_REQUEST ->
      PlatformError(PlatformErrorCode.INVALID_ARGS, message, code)
    PrototypeChannelError.TOO_MANY_IN_FLIGHT ->
      PlatformError(PlatformErrorCode.TOO_MANY_IN_FLIGHT, message, code)
    else -> PlatformError(PlatformErrorCode.PLATFORM_ERROR, message, code)
  }
