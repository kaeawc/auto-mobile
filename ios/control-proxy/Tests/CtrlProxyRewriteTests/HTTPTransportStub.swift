@testable import CtrlProxyRewrite
import Foundation
import os

// Test fixtures fail-fast on malformed setup data, so force-unwrap is idiomatic here
// (blanket-allowed for force_unwrapping in test targets — see .swiftlint.yml).
// swiftlint:disable force_unwrapping

/// A scripted outcome for `StubHTTPTransport`. `Sendable` (no `any Error`) so the stub
/// stays lock-confined-`Sendable` with no escape hatch.
enum StubOutcome: Sendable {
    case respond(status: Int, body: Data)
    /// Simulate a transport failure (server absent, connection refused, …).
    case transportError
    /// Simulate a completion that is not an `HTTPURLResponse`.
    case nonHTTPResponse
}

/// Deterministic `HTTPRequesting` stub for SDK-client behavior tests: records every
/// request and replays the next scripted outcome (defaulting to `.nonHTTPResponse` once
/// the script is exhausted). Lock-confined, so genuinely `Sendable`.
final class StubHTTPTransport: HTTPRequesting {
    private let state: OSAllocatedUnfairLock<(outcomes: [StubOutcome], recorded: [URLRequest])>

    init(_ outcomes: [StubOutcome]) {
        state = OSAllocatedUnfairLock(initialState: (outcomes, []))
    }

    convenience init(status: Int, body: Data = Data()) {
        self.init([.respond(status: status, body: body)])
    }

    var recordedRequests: [URLRequest] {
        state.withLock { $0.recorded }
    }

    func data(for request: URLRequest) async throws -> (Data, URLResponse) {
        let outcome: StubOutcome = state.withLock {
            $0.recorded.append(request)
            return $0.outcomes.isEmpty ? .nonHTTPResponse : $0.outcomes.removeFirst()
        }
        // Force-unwrap: every SDK-client request carries a localhost URL.
        let url = request.url!
        switch outcome {
        case let .respond(status, body):
            let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
            return (body, response)
        case .transportError:
            throw URLError(.cannotConnectToHost)
        case .nonHTTPResponse:
            return (Data(), URLResponse(url: url, mimeType: nil, expectedContentLength: 0, textEncodingName: nil))
        }
    }
}
