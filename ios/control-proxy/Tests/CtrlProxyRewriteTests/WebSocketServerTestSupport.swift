@testable import CtrlProxyRewrite
import Foundation
import os

// Fakes for driving WebSocketServer through its seams without a live socket.

struct FakeCommandHandling: CommandHandling {
    let handler: @Sendable (WebSocketRequest) -> any WebSocketResponsePayload
    func handle(_ request: WebSocketRequest) -> any WebSocketResponsePayload {
        handler(request)
    }
}

/// No-op perf tracker with a configurable `flush` result (perf timing is diagnostic;
/// the server's use of it is orchestration, so calls aren't recorded here).
struct FakePerfTracking: PerfTracking {
    let flushResult: [PerfTiming]?
    func serial(_ name: String) {}
    func end() {}
    func flush() -> [PerfTiming]? { flushResult }
    func clear() {}
    func withScope<T>(_ body: nonisolated(nonsending) () async throws -> T) async rethrows -> T {
        try await body()
    }
}

struct FakeFrameContextRecording: FrameContextRecording {
    let token: String?
    func recordTransition(to hierarchy: ViewHierarchy) -> String? { token }
}

/// Captures outbound frames pushed to a responder. Sends arrive on the command
/// queue, so the captured buffer is lock-guarded and `onEach` fulfills a test
/// expectation.
final class CapturingResponder: WebSocketResponding, @unchecked Sendable {
    private let buffer = OSAllocatedUnfairLock<[Data]>(initialState: [])
    private let onEach: (@Sendable () -> Void)?

    init(onEach: (@Sendable () -> Void)? = nil) {
        self.onEach = onEach
    }

    func send(_ data: Data) {
        buffer.withLock { $0.append(data) }
        onEach?()
    }

    var captured: [Data] { buffer.withLock { $0 } }
}

/// Lock-guarded recorder for values captured in `@Sendable` callbacks (presence
/// transitions, broadcast payloads).
final class ValueBox<Element: Sendable>: @unchecked Sendable {
    private let storage = OSAllocatedUnfairLock<[Element]>(initialState: [])
    func append(_ value: Element) { storage.withLock { $0.append(value) } }
    var values: [Element] { storage.withLock { $0 } }
}

func makeTestServer(
    handler: @escaping @Sendable (WebSocketRequest) -> any WebSocketResponsePayload = { _ in
        WebSocketResponse(type: "noop")
    },
    flush: [PerfTiming]? = nil,
    frameToken: String? = nil,
    onPresence: (@Sendable (Bool) -> Void)? = nil,
    broadcastSink: (@Sendable (Data) -> Void)? = nil
) -> WebSocketServer {
    WebSocketServer(
        port: 8765,
        commandHandler: FakeCommandHandling(handler: handler),
        perf: FakePerfTracking(flushResult: flush),
        frameContext: FakeFrameContextRecording(token: frameToken),
        onSdkEventBatch: nil,
        drainLogEvents: nil,
        onClientPresenceChanged: onPresence,
        broadcastSink: broadcastSink
    )
}
