package dev.jasonpearson.automobile.desktop.core.daemon

internal class AllocatingStorageClient(
  private val delegate: AutoMobileClient,
  private val allocation: DesktopInputAllocation,
  private val sessionUuidProvider: () -> String?,
) : AutoMobileClient by delegate {
  // Key-value edits are device mutations (#10827): claim the device for the desktop session, then
  // send as it. A refused claim reports a typed failure instead of reaching the daemon. The reads
  // (resources) never come through here, so they only watch.
  override fun setKeyValue(input: SetKeyValueRequest): SetKeyValueResult =
    with(input) {
      if (!allocation.awaitInputAllowed(deviceId)) {
        SetKeyValueResult(success = false, message = INPUT_NOT_ALLOCATED_ERROR)
      } else {
        delegate.setKeyValue(
          input =
            SetKeyValueRequest(
              deviceId = deviceId,
              appId = appId,
              fileName = fileName,
              key = key,
              value = value,
              type = type,
              platform = platform,
              sessionUuid = sessionUuid ?: sessionUuidProvider(),
            ),
        )
      }
    }

  override fun removeKeyValue(input: RemoveKeyValueRequest): RemoveKeyValueResult =
    with(input) {
      if (!allocation.awaitInputAllowed(deviceId)) {
        RemoveKeyValueResult(success = false, message = INPUT_NOT_ALLOCATED_ERROR)
      } else {
        delegate.removeKeyValue(
          input =
            RemoveKeyValueRequest(
              deviceId = deviceId,
              appId = appId,
              fileName = fileName,
              key = key,
              platform = platform,
              sessionUuid = sessionUuid ?: sessionUuidProvider(),
            ),
        )
      }
    }

  override fun clearKeyValueFile(
    deviceId: String,
    appId: String,
    fileName: String,
    platform: String,
    sessionUuid: String?,
  ): ClearKeyValueResult =
    if (!allocation.awaitInputAllowed(deviceId)) {
      ClearKeyValueResult(success = false, message = INPUT_NOT_ALLOCATED_ERROR)
    } else {
      delegate.clearKeyValueFile(
        deviceId,
        appId,
        fileName,
        platform,
        sessionUuid ?: sessionUuidProvider(),
      )
    }
}
