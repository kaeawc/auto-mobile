package dev.jasonpearson.automobile.ctrlproxy.prototype

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class HostPrototypeChannelTransportTest {
  private class FakeLink(var host: Any? = "host-a") : PrototypeChannelHostLink {
    val sent = mutableListOf<Pair<Any?, JsonObject>>()
    val gone = mutableSetOf<Any>()

    override fun send(frame: String): Any? {
      sent += host to Json.parseToJsonElement(frame).jsonObject
      return host
    }

    override fun sendTo(target: Any, frame: String): Boolean {
      if (target in gone) return false
      sent += target to Json.parseToJsonElement(frame).jsonObject
      return true
    }
  }

  private class Recorder : PrototypeChannelListener {
    val seen = mutableListOf<String>()
    var error: PrototypeChannelError? = null

    override fun onOpen(protocol: String?) {
      seen += "open:$protocol"
    }

    override fun onFrame(data: String, event: String?, id: String?) {
      seen += "frame:$data:$event:$id"
    }

    override fun onClosed(code: Int?, reason: String?, error: PrototypeChannelError?) {
      seen += "closed:$code:$reason"
      this.error = error
    }
  }

  private val request =
    PrototypeChannelOpenRequest(
      connectionId = "c1",
      prototypeId = "proto",
      channel = "feed",
      kind = PrototypeChannelKind.SSE,
      url = "https://example.com/feed",
      headers = mapOf("Authorization" to "Bearer t"),
      lastEventId = "9",
    )

  @Test
  fun `an open relays the request and the host's answers reach the listener`() {
    val link = FakeLink()
    val transport = HostPrototypeChannelTransport(link) {}
    val recorder = Recorder()
    transport.open(request, recorder)
    assertEquals(
      Json.parseToJsonElement(
        """{"type":"prototype_channel_open","connectionId":"c1","prototypeId":"proto",
          "channel":"feed","kind":"sse","url":"https://example.com/feed",
          "headers":{"Authorization":"Bearer t"},"lastEventId":"9"}""",
      ),
      link.sent.single().second,
    )
    transport.onFrame("""{"type":"prototype_channel_opened","connectionId":"c1"}""")
    transport.onFrame(
      """{"type":"prototype_channel_frame","connectionId":"c1","data":"x","event":"tick","id":"10"}""",
    )
    transport.onFrame("""{"type":"prototype_channel_frame","connectionId":"other","data":"y"}""")
    transport.onFrame(
      """{"type":"prototype_channel_closed","connectionId":"c1","error":
        {"code":"handshake_failed","message":"no","status":401}}""",
    )
    transport.onFrame("""{"type":"prototype_channel_frame","connectionId":"c1","data":"late"}""")
    assertEquals(listOf("open:null", "frame:x:tick:10", "closed:null:null"), recorder.seen)
    assertEquals(PrototypeChannelError("handshake_failed", "no", 401), recorder.error)
  }

  @Test
  fun `sends and closes go to the host the open went to`() {
    val link = FakeLink()
    val transport = HostPrototypeChannelTransport(link) {}
    val connection = transport.open(request.copy(kind = PrototypeChannelKind.WEBSOCKET), Recorder())
    link.host = "host-b"
    assertTrue(connection.send("hi"))
    connection.close(1000, "")
    assertFalse("closed connections take no sends", connection.send("late"))
    assertEquals(listOf("host-a", "host-a", "host-a"), link.sent.map { it.first })
    assertEquals(
      listOf("prototype_channel_open", "prototype_channel_send", "prototype_channel_close"),
      link.sent.map { it.second.getValue("type").toString().trim('"') },
    )
  }

  @Test
  fun `no host fails the open at once with network`() {
    val recorder = Recorder()
    HostPrototypeChannelTransport(FakeLink(host = null)) {}.open(request, recorder)
    assertEquals(PrototypeChannelError.NETWORK, recorder.error?.code)
    assertEquals(HostPrototypeChannelTransport.NO_HOST_MESSAGE, recorder.error?.message)
  }

  @Test
  fun `losing a host fails only the connections it held`() {
    val link = FakeLink()
    val transport = HostPrototypeChannelTransport(link) {}
    val first = Recorder()
    transport.open(request, first)
    link.host = "host-b"
    val second = Recorder()
    transport.open(request.copy(connectionId = "c2"), second)
    transport.onHostLost("host-a")
    assertEquals(HostPrototypeChannelTransport.HOST_LOST_MESSAGE, first.error?.message)
    assertTrue(second.seen.isEmpty())
    transport.onHostLost()
    assertEquals(PrototypeChannelError.NETWORK, second.error?.code)
  }

  @Test
  fun `malformed frames are ignored with a warning`() {
    val warnings = mutableListOf<String>()
    val transport = HostPrototypeChannelTransport(FakeLink()) { warnings += it }
    transport.onFrame("{not json")
    transport.onFrame("[1]")
    assertEquals(2, warnings.size)
  }
}
