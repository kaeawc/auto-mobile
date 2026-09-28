package dev.jasonpearson.automobile.desktop.core.daemon

import dev.jasonpearson.automobile.desktop.core.video.VideoStreamClient
import kotlin.test.Test
import kotlin.test.assertEquals

class DesktopDaemonSessionStreamClientsTest {
  @Test
  fun `observation WebRTC and video requests use one session UUID for the same device`() {
    val session =
      DesktopDaemonSession(
        McpDaemonClient(socketPathValue = "/unused/test-socket", sessionUuid = "app-session")
      )
    val observationClient =
      ObservationStreamClient(sessionUuidProvider = session.sessionUuidProvider)
    val webRtcClient =
      WebRtcStreamSocketClient(
        socketPathValue = "/unused/webrtc-socket",
        sessionUuidProvider = session.sessionUuidProvider,
      )
    val videoClient =
      VideoStreamClient(
        socketPathValue = "/unused/video-socket",
        sessionUuidProvider = session.sessionUuidProvider,
      )

    val observationRequest = observationClient.observationRequest("emulator-5554")
    val webRtcRequest = webRtcClient.request("start", deviceId = "emulator-5554")
    val videoRequest = videoClient.subscribeRequest("emulator-5554")

    assertEquals("emulator-5554", observationRequest.deviceId)
    assertEquals("emulator-5554", webRtcRequest.deviceId)
    assertEquals("emulator-5554", videoRequest.deviceId)
    assertEquals("app-session", observationRequest.sessionUuid)
    assertEquals("app-session", webRtcRequest.sessionUuid)
    assertEquals("app-session", videoRequest.sessionUuid)

    videoClient.dispose()
  }
}
