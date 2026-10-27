package dev.jasonpearson.automobile.ctrlproxy.prototype

import dev.jasonpearson.automobile.protocol.PrototypePlatformAction
import dev.jasonpearson.automobile.protocol.PrototypePlatformCalls
import dev.jasonpearson.automobile.prototype.*
import kotlinx.coroutines.*
import kotlinx.coroutines.flow.collect
import kotlinx.serialization.json.*

/**
 * Runtime-owned subscriptions and calls; all mutations and callbacks execute under the host lock.
 */
@Suppress("LongParameterList") // Every collaborator is a seam the runtime and tests inject.
internal class PrototypePlatformDispatcher(
  private val registry: PrototypePlatformRegistry,
  private val scope: CoroutineScope,
  private val exclusively: suspend (suspend () -> Unit) -> Unit,
  private val newId: () -> String,
  private val clock: () -> Long,
  private val complete: suspend (Pending, PlatformCallResult) -> Unit,
  private val deliver: suspend (String, JsonObject) -> Unit,
  private val publish: (String, JsonObject) -> Unit,
  private val warn: (String) -> Unit,
  private val limiter: PrototypeRequestLimiter,
) {
  class Pending(
    val id: String,
    val action: PrototypePlatformAction,
    val startedAt: Long,
    val eventContext: JsonObject?,
  ) {
    var clipboardBytes: Int = 0
    lateinit var job: Job
  }

  private val pending = linkedMapOf<String, Pending>()
  private val subscriptions = mutableListOf<Job>()
  @Volatile private var closed = false
  private var subscribed = false

  fun subscribe() {
    if (subscribed || closed) return
    subscribed = true
    for (module in registry.modules) {
      // The host already publishes measured device state and debounced events under this lock.
      if (module is PrototypeDeviceModule) continue
      subscriptions +=
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
          module.state.collect { state -> exclusively { if (!closed) publish(module.name, state) } }
        }
      subscriptions +=
        scope.launch(start = CoroutineStart.UNDISPATCHED) {
          module.events.collect { event ->
            exclusively {
              if (!closed && PrototypePlatformCalls.eventOwner(event.name) == module.name) {
                deliver(event.name, event.data)
              }
            }
          }
        }
    }
  }

  suspend fun start(
    action: PrototypePlatformAction,
    args: JsonObject?,
    invalid: String? = null,
    eventContext: JsonObject? = null,
  ) {
    val call = Pending(newId(), action, clock(), eventContext)
    if (closed) return
    call.clipboardBytes =
      (args?.get("text") as? kotlinx.serialization.json.JsonPrimitive)
        ?.content
        ?.toByteArray(Charsets.UTF_8)
        ?.size ?: 0
    val refusal = refusal(action, args, invalid)
    if (refusal != null) {
      complete(call, refusal)
      return
    }
    call.job =
      scope.launch(start = CoroutineStart.LAZY) { runCall(call, action, args ?: return@launch) }
    val registered =
      synchronized(pending) {
        if (closed) false
        else {
          pending[call.id] = call
          true
        }
      }
    if (registered) call.job.start()
    else {
      limiter.release()
      call.job.cancel()
    }
  }

  /** Why a call cannot start, or null once it holds a limiter slot. */
  private fun refusal(
    action: PrototypePlatformAction,
    args: JsonObject?,
    invalid: String?,
  ): PlatformCallResult? {
    if (invalid != null || args == null) {
      return failure(PlatformErrorCode.INVALID_ARGS, invalid ?: "Invalid arguments")
    }
    val invalidArgs = PrototypePlatformCalls.argumentsError(action.call, args)
    if (invalidArgs != null) return failure(PlatformErrorCode.INVALID_ARGS, invalidArgs.message)
    if (limiter.tryAcquire()) return null
    return failure(
      PlatformErrorCode.TOO_MANY_IN_FLIGHT,
      "At most $MAX_IN_FLIGHT platform calls can be in flight",
    )
  }

  private suspend fun runCall(call: Pending, action: PrototypePlatformAction, args: JsonObject) {
    val result =
      try {
        withTimeoutOrNull((action.timeoutMs ?: DEFAULT_TIMEOUT_MS).toLong()) {
          invoke(call, action, args)
        } ?: failure(PlatformErrorCode.TIMEOUT, "Platform call timed out")
      } catch (cancelled: CancellationException) {
        withContext(NonCancellable) {
          exclusively {
            settle(call, failure(PlatformErrorCode.CANCELLED, "Platform call cancelled"))
          }
        }
        throw cancelled
      } catch (@Suppress("TooGenericExceptionCaught") error: Exception) {
        // A module may throw anything; the call reports it as a platform error.
        warn("Platform call ${action.call} failed: ${error.message}")
        failure(PlatformErrorCode.PLATFORM_ERROR, error.message ?: "Platform call failed")
      }
    exclusively { settle(call, result) }
  }

  private suspend fun invoke(
    call: Pending,
    action: PrototypePlatformAction,
    args: JsonObject,
  ): PlatformCallResult {
    val module =
      registry.module(action.call)
        ?: return failure(PlatformErrorCode.UNSUPPORTED, "No module registered for ${action.call}")
    return when (val available = module.availability()) {
      is PlatformAvailability.Unavailable ->
        failure(PlatformErrorCode.UNAVAILABLE, available.reason)
      is PlatformAvailability.NeedsPermission ->
        failure(
          PlatformErrorCode.PERMISSION_DENIED,
          "Missing permissions: ${available.names.sorted().joinToString()}",
        )
      PlatformAvailability.Ready -> module.call(PlatformCall(call.id, action.call, args))
    }
  }

  private suspend fun settle(call: Pending, result: PlatformCallResult) {
    if (call.action.call == "clipboard.paste" && result is PlatformCallResult.Success) {
      call.clipboardBytes =
        ((result.value as? JsonObject)?.get("text") as? kotlinx.serialization.json.JsonPrimitive)
          ?.content
          ?.toByteArray(Charsets.UTF_8)
          ?.size ?: 0
    }
    if (synchronized(pending) { pending.remove(call.id) } != null) {
      limiter.release()
      if (!closed) complete(call, result)
    }
  }

  /** Called under the interaction lock, before the old runtime is removed. */
  suspend fun cancel() {
    val calls = synchronized(pending) { pending.values.toList().also { pending.clear() } }
    calls.forEach {
      it.job.cancel()
      limiter.release()
    }
    for (call in calls) complete(
      call,
      failure(PlatformErrorCode.CANCELLED, "Prototype ended or was replaced"),
    )
  }

  fun close() {
    val calls =
      synchronized(pending) {
        closed = true
        pending.values.toList().also { pending.clear() }
      }
    subscriptions.forEach { it.cancel() }
    calls.forEach {
      it.job.cancel()
      limiter.release()
    }
    if (calls.isNotEmpty())
      scope.launch(NonCancellable) {
        exclusively {
          for (call in calls) complete(
            call,
            failure(PlatformErrorCode.CANCELLED, "Prototype closed"),
          )
        }
      }
  }

  companion object {
    val MAX_IN_FLIGHT = PrototypePlatformCalls.maxInFlight
    val DEFAULT_TIMEOUT_MS = PrototypePlatformCalls.defaultTimeoutMs

    fun failure(code: PlatformErrorCode, message: String) =
      PlatformCallResult.Failure(PlatformError(code, message.take(512)))
  }
}
