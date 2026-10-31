package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.PermissionResult

/** The permission lookup [PermissionController] needs; [PermissionManager] in production. */
internal fun interface PermissionStateSource {
  fun permissionState(
    permission: String?,
    requestPermission: Boolean,
  ): PermissionManager.PermissionState
}

/** Reports a permission's state, optionally requesting it, as a correlated `permission_result`. */
internal class PermissionController(
  private val permissions: PermissionStateSource,
  private val asyncActionRunner: AsyncActionRunner,
  private val timeProvider: TimeProvider,
  private val resultSender: ResultSender,
) {
  /** A missing [requestPermission] requests the permission, matching the wire default. */
  fun getPermission(requestId: String?, permission: String?, requestPermission: Boolean?) {
    val startTime = timeProvider.currentTimeMillis()
    Log.d(
      TAG,
      "handleGetPermission (requestId: $requestId, permission: $permission, requestPermission: $requestPermission)",
    )

    asyncActionRunner.launch(requestId, "get_permission") {
      val result = permissions.permissionState(permission, requestPermission ?: true)
      val totalTime = timeProvider.currentTimeMillis() - startTime
      sendResult(requestId, result, totalTime)
    }
  }

  private suspend fun sendResult(
    requestId: String?,
    result: PermissionManager.PermissionState,
    totalTimeMs: Long,
  ) {
    resultSender.send(requestId, "permission_result") { perfTiming ->
      PermissionResult(
        timestamp = timeProvider.currentTimeMillis(),
        requestId = requestId,
        success = result.error == null,
        permission = result.permission,
        granted = result.granted,
        requestLaunched = result.requestLaunched,
        canRequest = result.canRequest,
        requiresSettings = result.requiresSettings,
        instructions = result.instructions,
        adbCommand = result.adbCommand,
        totalTimeMs = totalTimeMs,
        error = result.error,
        perfTiming = perfTiming,
      )
    }
  }

  private companion object {
    const val TAG = "CtrlProxy"
  }
}
