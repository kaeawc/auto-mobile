@testable import AutoMobilePrototypeAgentCore
import XCTest

@MainActor
final class FakeChannelTransport: PrototypeChannelTransport {
    final class Connection: PrototypeChannelConnection {
        let listener: PrototypeChannelListener
        var sent: [String] = []
        var closes: [Int] = []
        init(_ listener: PrototypeChannelListener) { self.listener = listener }
        func send(_ text: String) -> Bool {
            guard closes.isEmpty else { return false }
            sent.append(text)
            return true
        }

        func close(code: Int, reason _: String) {
            if closes.isEmpty { closes.append(code) }
        }
    }

    var requests: [PrototypeChannelOpenRequest] = []
    var connections: [Connection] = []
    var failOpen: Error?
    func open(
        _ request: PrototypeChannelOpenRequest,
        listener: PrototypeChannelListener
    )
        throws -> any PrototypeChannelConnection
    {
        if let failOpen { throw failOpen }
        requests.append(request)
        let connection = Connection(listener)
        connections.append(connection)
        return connection
    }
}

/// A real non-reentrant mutex. MainActor alone is reentrant across an await; this is not.
@MainActor
final class RealtimeMutex {
    private var held = false
    private var waiters: [CheckedContinuation<Void, Never>] = []
    var onWait: (() -> Void)?
    func lock() async {
        if !held { held = true; return }
        await withCheckedContinuation { continuation in
            waiters.append(continuation)
            onWait?()
        }
    }

    func unlock() {
        if waiters.isEmpty { held = false }
        else { waiters.removeFirst().resume() }
    }

    func exclusively(_ work: @MainActor () throws -> Void) async throws {
        await lock()
        defer { unlock() }
        try work()
    }
}

/// Reuse the manual request scheduler, with deterministic elapsed time for driver deadlines.
final class RealtimeClock: PrototypeClock {
    var nowMilliseconds = 0
    private let scheduler = ManualRequestClock()
    var live: [ManualRequestClock.Handle] { scheduler.live }
    func schedule(afterMilliseconds: Int, _ fire: @escaping () -> Void) -> any PrototypeTimerHandle {
        scheduler.schedule(afterMilliseconds: afterMilliseconds, fire)
    }
}

@MainActor
final class RealtimeHarness {
    let clock = RealtimeClock()
    let transport = FakeChannelTransport()
    let mutex = RealtimeMutex()
    var session = PrototypeSession()
    private var document: [String: JSONValue] = [:]
    var effects: [PrototypeChannelEffect] = []
    var events: [PrototypeEvent] = []
    var failures = 0
    var throwNext = false
    lazy var module = PrototypeRealtimeModule(
        config: PrototypeRealtimeConfig(host: transport, device: transport, random: { 0.5 }, newID: { "connection" }),
        sink: PrototypeChannelSink(
            exclusively: { [weak self] work in
                guard let self else { return }
                try await mutex.exclusively(work)
            },
            isCurrent: { [weak self] channel in
                self?.session.isShown == true && self?.session.spec?.channels?.objectFields?[channel] != nil
            },
            apply: { [weak self] effect in
                guard let self else { return }
                if throwNext { throwNext = false; throw Failure.injected }
                effects.append(effect)
                var failure: Error?
                events += session.transition { session in
                    do { return try session.applyChannelEffect(effect) }
                    catch { failure = error; return [] }
                }
                if let failure { throw failure }
            }
        ),
        clock: clock
    )
    enum Failure: Error { case injected }

    init(
        manual: Bool = false,
        secondChannel: Bool = false,
        raw: Bool = false,
        coalesced: Bool = false,
        sse: Bool = false,
        maxAttempts: Int = PrototypeChannelBackoff.defaultMaxAttempts
    )
        throws
    {
        let route = coalesced ? """
        [{"actions":[{"type":"setData","path":"/data/latest","value":{"event":""}}]}]
        """ : """
        [{"actions":[{"type":"appendData","path":"/data/frames","value":{"event":""}}]}]
        """
        let channel = """
        {"kind":"\(sse ? "sse" : "websocket")","url":"\(sse ? "https" :
            "wss")://example.com/{room}","headers":{"X-Room":"{room}"},
         "statusKey":"status","connect":"\(manual ? "manual" : "onShow")","decode":"\(raw ? "text" : "json")",
         "reconnect":{"maxAttempts":\(maxAttempts)},
         "routes":\(route)}
        """
        let bytes = Data("""
        {"id":"rt","window":{"placement":{"type":"fullscreen"}},
         "requires":{"platform":["realtime"]},"state":{"status":"idle","room":"one","n":0},
         "data":{"frames":[]},"channels":{"a":\(channel)\(secondChannel ? ",\"b\":" + channel : "")},
         "root":{"type":"text","text":"{status}"}}
        """.utf8)
        document = try JSONDecoder().decode(JSONValue.self, from: bytes).objectFields ?? [:]
        let spec = try JSONDecoder().decode(PrototypeSpec.self, from: bytes)
        session.show(spec)
        module.onError = { [weak self] _ in self?.failures += 1 }
        module.begin(prototypeID: "rt")
        module.update(session.resolvedChannels)
        module.show()
    }

    /// Channel declarations change through a same-id show. Public patch paths remain /state/data.
    func replaceChannels(_ channels: [String: JSONValue]) throws {
        document["channels"] = .object(channels)
        document["state"] = .object(session.state)
        document["data"] = .object(session.data ?? [:])
        let decoded = try JSONDecoder().decode(PrototypeSpec.self, from: JSONEncoder().encode(document))
        var platform = session.spec?.platformState ?? [:]
        if let realtime = platform["realtime"]?.objectFields {
            platform["realtime"] = .object(realtime.filter { channels[$0.key] != nil })
        }
        try session.show(decoded.replacingPlatform(platform))
        module.begin(prototypeID: "rt")
        module.update(session.resolvedChannels)
        module.show()
    }

    func opened() async {
        await module.settled()
        for connection in transport.connections {
            connection.listener.opened()
        }
        await module.settled()
    }

    func flush() async {
        for timer in clock.live where timer.delay == PrototypeChannelLimits.flushMs {
            timer.run()
        }
        await module.settled()
    }

    func call(_ name: String, body: JSONValue? = nil) -> PlatformCall {
        var args: [String: JSONValue] = ["channel": .string("a")]
        if let body { args["body"] = body }
        return PlatformCall(callId: "call", call: "realtime." + name, args: args)
    }
}
