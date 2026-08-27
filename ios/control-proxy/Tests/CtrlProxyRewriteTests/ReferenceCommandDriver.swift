@testable import CtrlProxy
import Foundation

/// Drives the REFERENCE `CommandHandler` (behavioral oracle) with the public `Fakes.swift`
/// doubles. Imports only `CtrlProxy`; `@testable` reaches the internal
/// `WebSocketServer.handleMessage` / `WebSocketResponding`.
enum ReferenceCommandDriver {
    private final class Responder: WebSocketResponding {
        var captured: [Data] = []
        func send(_ data: Data) { captured.append(data) }
    }

    /// A fresh reference `TimeProvider` so each driver call gets an uncontaminated
    /// `PerfProvider`. Defined locally because the reference's own `FakeTimeProvider` is
    /// shadowed by the test target's (rewrite) one, and `CtrlProxy.FakeTimeProvider` is
    /// unreachable (the module name collides with the `CtrlProxy` type — STATUS §4).
    private final class FixedClock: TimeProvider {
        func currentTimeMillis() -> Int64 { 0 }
    }

    private static func sortedEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = .sortedKeys
        return encoder
    }

    /// Route one request through a fresh `CommandHandler` and return the encoded response.
    static func handleEncoded(_ json: String) -> Data {
        guard let request = try? JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8)) else {
            return Data()
        }
        let handler = CommandHandler(
            elementLocator: FakeElementLocator(),
            gesturePerformer: FakeGesturePerformer(),
            perfProvider: PerfProvider.createForTesting(timeProvider: FixedClock())
        )
        let response = handler.handle(request)
        guard let encodable = response as? Encodable else { return Data() }
        return (try? sortedEncoder().encode(encodable)) ?? Data()
    }

    /// Drive one request through the real `WebSocketServer.handleMessage` and return the
    /// response `perfTiming`'s canonical name-tree (the reference side of the integration check).
    static func perfTimingTreeThroughServer(_ json: String) -> String? {
        let perf = PerfProvider.createForTesting(timeProvider: FixedClock())
        let handler = CommandHandler(
            elementLocator: FakeElementLocator(),
            gesturePerformer: FakeGesturePerformer(),
            perfProvider: perf
        )
        let server = WebSocketServer(port: 0, commandHandler: handler, perfProvider: perf)
        let responder = Responder()
        server.handleMessage(Data(json.utf8), responder: responder)
        guard let data = responder.captured.first,
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else {
            return nil
        }
        return PerfTimingTree.name(object["perfTiming"] as? [String: Any])
    }
}
