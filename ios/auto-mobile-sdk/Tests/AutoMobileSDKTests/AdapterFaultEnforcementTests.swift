@testable import AutoMobileSDK
import Foundation
import Network
import os
import XCTest

#if DEBUG
    /// #5163: the WebSocket and NWConnection adapters apply delay and fail rules, with one-shot or
    /// count expiry, and record every decision.
    final class AdapterFaultEnforcementTests: XCTestCase {
        private final class ManualScheduler: FaultScheduling {
            private let pending = OSAllocatedUnfairLock<[(Int, @Sendable () -> Void)]>(initialState: [])
            var delays: [Int] { pending.withLock { $0.map(\.0) } }
            func schedule(delayMs: Int, work: @escaping @Sendable () -> Void) {
                pending.withLock { $0.append((delayMs, work)) }
            }

            func fireAll() {
                let work = pending.withLock { queued -> [@Sendable () -> Void] in
                    defer { queued.removeAll() }
                    return queued.map(\.1)
                }
                work.forEach { $0() }
            }
        }

        /// Collects calls from the fake transports and records; mutated from the test thread only.
        private final class Log: @unchecked Sendable {
            private let lock = NSLock()
            private var _entries: [String] = []
            private var _records: [NetworkRequestRecord] = []
            var entries: [String] { lock.withLock { _entries } }
            var records: [NetworkRequestRecord] { lock.withLock { _records } }
            func add(_ entry: String) { lock.withLock { _entries.append(entry) } }
            func add(_ record: NetworkRequestRecord) { lock.withLock { _records.append(record) } }
        }

        private let url = "wss://api.example.com/socket"
        private let endpoint = "tcp://api.example.com:443"

        private func makeStore(_ rules: [NetworkFaultRuleDTO]) -> NetworkMockRuleStore {
            let clock = FakeDateProvider(initialDate: Date(timeIntervalSince1970: 100))
            let store = NetworkMockRuleStore(dateProvider: clock)
            store.setFaultRules(rules)
            return store
        }

        private func rule(
            _ transport: NetworkFaultTransport,
            action: NetworkFaultAction,
            errorType: String? = nil,
            delayMs: Int? = nil,
            limit: Int? = 1,
            method: String? = nil
        )
            -> NetworkFaultRuleDTO
        {
            NetworkFaultRuleDTO(
                faultId: "fault-1", transport: transport, host: "^api\\.example\\.com$", port: nil,
                scheme: nil, path: nil, method: method, headers: nil, origin: nil, connectionId: nil,
                sessionId: nil, action: action, statusCode: nil, responseHeaders: nil, responseBody: nil,
                contentType: nil, errorType: errorType, delayMs: delayMs, bandwidthBytesPerSecond: nil,
                dropBytes: nil, limit: limit, expiresAtEpochMs: nil, scope: nil, dryRun: false
            )
        }

        private func recorder(_ log: Log) -> NetworkCaptureRecorder {
            NetworkCaptureRecorder(emit: { log.add($0) })
        }

        private func webSocketOperations(_ log: Log) -> WebSocketOperations {
            WebSocketOperations(
                url: url,
                send: { _, done in
                    log.add("send")
                    done(nil)
                },
                receive: { done in
                    log.add("receive")
                    done(.success(.text("hello")))
                },
                close: { reset, _ in log.add(reset ? "reset" : "close") }
            )
        }

        private func connectionOperations(_ log: Log) -> ConnectionOperations {
            ConnectionOperations(start: { log.add("start") }, cancel: { log.add("cancel") })
        }

        // MARK: - Outcome mapping

        func testOnlyLatencyErrorAndCloseAreApplied() {
            func outcome(_ action: NetworkFaultAction, delayMs: Int? = nil) -> AdapterFaultOutcome {
                let store = makeStore([rule(.webSocket, action: action, delayMs: delayMs)])
                return AdapterFaultOutcome(store.evaluate(.init(
                    transport: .webSocket, host: "api.example.com", port: nil, scheme: "wss", path: "/socket",
                    method: "SEND", headers: [:], origin: nil, connectionId: nil, sessionId: nil
                )))
            }
            XCTAssertEqual(outcome(.latency, delayMs: 250), .delay(faultId: "fault-1", delayMs: 250))
            XCTAssertEqual(outcome(.latency), .proceed)
            XCTAssertEqual(
                outcome(.error, delayMs: 10), .fail(faultId: "fault-1", action: .error, errorType: nil, delayMs: 10)
            )
            XCTAssertEqual(
                outcome(.closeConnection),
                .fail(faultId: "fault-1", action: .closeConnection, errorType: nil, delayMs: 0)
            )
            for action in [NetworkFaultAction.response, .status, .bandwidth, .dropBytes, .rejectFrame] {
                XCTAssertEqual(outcome(action), .unsupported(faultId: "fault-1", action: action), action.rawValue)
            }
            XCTAssertEqual(AdapterFaultOutcome(nil), .proceed)
        }

        func testPosixCodesFollowTheRuleErrorType() {
            XCTAssertEqual(AdapterFaultOutcome.posixCode(for: "reset"), .ECONNRESET)
            XCTAssertEqual(AdapterFaultOutcome.posixCode(for: "timeout"), .ETIMEDOUT)
            XCTAssertEqual(AdapterFaultOutcome.posixCode(for: "dnsFailure"), .EHOSTUNREACH)
            XCTAssertEqual(AdapterFaultOutcome.posixCode(for: nil), .ECONNREFUSED)
        }

        // MARK: - WebSocket

        func testWebSocketFailRuleClosesTheTaskOnceThenExpires() {
            let log = Log()
            let adapter = WebSocketNetworkCaptureAdapter(
                recorder: recorder(log),
                faultStore: makeStore([rule(.webSocket, action: .closeConnection, limit: 1)]),
                faultScheduler: ManualScheduler()
            )
            let errors = Log()
            for _ in 0 ..< 2 {
                adapter.send(.text("hi"), operations: webSocketOperations(log), connectionId: "c1", sessionId: nil) {
                    errors.add(($0 as? URLError).map { "\($0.code.rawValue)" } ?? "ok")
                }
            }
            XCTAssertEqual(log.entries, ["close", "send"], "the one-shot rule fails the first send only")
            XCTAssertEqual(errors.entries, ["\(URLError.networkConnectionLost.rawValue)", "ok"])
            XCTAssertTrue(log.records.contains { $0.error == "fault:fault-1:closeConnection" })
        }

        func testWebSocketResetErrorTypeResetsTheTask() {
            let log = Log()
            let adapter = WebSocketNetworkCaptureAdapter(
                recorder: recorder(log),
                faultStore: makeStore([rule(.webSocket, action: .error, errorType: "reset")]),
                faultScheduler: ManualScheduler()
            )
            adapter.send(.text("hi"), operations: webSocketOperations(log), connectionId: nil, sessionId: nil) { _ in }
            XCTAssertEqual(log.entries, ["reset"])
        }

        func testWebSocketLatencyDelaysTheSendUntilTheSchedulerFires() {
            let log = Log()
            let scheduler = ManualScheduler()
            let adapter = WebSocketNetworkCaptureAdapter(
                recorder: recorder(log),
                faultStore: makeStore([rule(.webSocket, action: .latency, delayMs: 300)]),
                faultScheduler: scheduler
            )
            adapter.send(.text("hi"), operations: webSocketOperations(log), connectionId: nil, sessionId: nil) { _ in }
            XCTAssertEqual(log.entries, [])
            XCTAssertEqual(scheduler.delays, [300])
            scheduler.fireAll()
            XCTAssertEqual(log.entries, ["send"])
            let decision = log.records.first { $0.metadata?["fault_outcome"] == "delayed" }
            XCTAssertEqual(decision?.metadata?["fault_id"], "fault-1")
        }

        func testWebSocketReceiveRuleMatchesOnlyReceivedFrames() {
            let log = Log()
            let adapter = WebSocketNetworkCaptureAdapter(
                recorder: recorder(log),
                faultStore: makeStore([rule(.webSocket, action: .error, method: "RECEIVE")]),
                faultScheduler: ManualScheduler()
            )
            adapter.send(.text("hi"), operations: webSocketOperations(log), connectionId: nil, sessionId: nil) { _ in }
            let results = Log()
            adapter.receive(operations: webSocketOperations(log), connectionId: nil, sessionId: nil) { result in
                results.add((try? result.get()) == nil ? "failed" : "delivered")
            }
            XCTAssertEqual(log.entries, ["send", "receive", "close"])
            XCTAssertEqual(results.entries, ["failed"])
        }

        func testUnsupportedActionIsRecordedAndTrafficIsUnchanged() {
            let log = Log()
            let adapter = WebSocketNetworkCaptureAdapter(
                recorder: recorder(log),
                faultStore: makeStore([rule(.webSocket, action: .rejectFrame)]),
                faultScheduler: ManualScheduler()
            )
            adapter.send(.text("hi"), operations: webSocketOperations(log), connectionId: nil, sessionId: nil) { _ in }
            XCTAssertEqual(log.entries, ["send"])
            let decision = log.records.first { $0.metadata?["fault_outcome"] == "unsupported" }
            XCTAssertEqual(decision?.metadata?["fault_action"], "rejectFrame")
        }

        func testNoRulesLeaveTrafficUnchangedAndRecordNoDecision() {
            let log = Log()
            let adapter = WebSocketNetworkCaptureAdapter(
                recorder: recorder(log), faultStore: makeStore([]), faultScheduler: ManualScheduler()
            )
            adapter.send(.text("hi"), operations: webSocketOperations(log), connectionId: nil, sessionId: nil) { _ in }
            XCTAssertEqual(log.entries, ["send"])
            XCTAssertFalse(log.records.contains { $0.metadata?["fault_id"] != nil })
        }

        // MARK: - NWConnection

        func testConnectionFailRuleNeverStartsAndReportsPosixThenExpires() {
            let log = Log()
            let adapter = NWConnectionNetworkCaptureAdapter(
                recorder: recorder(log),
                faultStore: makeStore([rule(.nwConnection, action: .error, errorType: "timeout", limit: 1)]),
                faultScheduler: ManualScheduler()
            )
            let faults = Log()
            for _ in 0 ..< 2 {
                adapter.start(
                    operations: connectionOperations(log), endpoint: endpoint, connectionId: "c1",
                    requestId: nil, sessionId: nil
                ) { faults.add(String(describing: $0)) }
            }
            XCTAssertEqual(log.entries, ["cancel", "start"])
            XCTAssertEqual(faults.entries, [String(describing: NWError.posix(.ETIMEDOUT))])
            XCTAssertTrue(log.records.contains { $0.error == "fault:fault-1:error" })
        }

        func testConnectionLatencyDelaysTheStart() {
            let log = Log()
            let scheduler = ManualScheduler()
            let adapter = NWConnectionNetworkCaptureAdapter(
                recorder: recorder(log),
                faultStore: makeStore([rule(.nwConnection, action: .latency, delayMs: 120, limit: 2)]),
                faultScheduler: scheduler
            )
            for _ in 0 ..< 3 {
                adapter.start(
                    operations: connectionOperations(log), endpoint: endpoint, connectionId: "c1",
                    requestId: nil, sessionId: nil
                ) { _ in XCTFail("no fault") }
            }
            XCTAssertEqual(log.entries, ["start"], "the count-limited rule delays the first two starts only")
            XCTAssertEqual(scheduler.delays, [120, 120])
            scheduler.fireAll()
            XCTAssertEqual(log.entries, ["start", "start", "start"])
        }

        func testConnectionFailIsRecordedOnTheHostRequest() {
            let log = Log()
            let capture = recorder(log)
            let adapter = NWConnectionNetworkCaptureAdapter(
                recorder: capture,
                faultStore: makeStore([rule(.nwConnection, action: .closeConnection)]),
                faultScheduler: ManualScheduler()
            )
            let requestId = adapter.begin(endpoint: endpoint, connectionId: "c1")
            adapter.start(
                operations: connectionOperations(log), endpoint: endpoint, connectionId: "c1",
                requestId: requestId, sessionId: nil
            ) { _ in }
            let failed = log.records.filter { $0.error == "fault:fault-1:closeConnection" }
            XCTAssertEqual(failed.count, 1)
            XCTAssertEqual(failed.first?.metadata?["fault_outcome"], "failed")
        }

        func testWebSocketRecordsKeepTheWebSocketScheme() {
            XCTAssertEqual(WebSocketOperations.webSocketURL(URL(string: "http://127.0.0.1:9/c")), "ws://127.0.0.1:9/c")
            XCTAssertEqual(
                WebSocketOperations.webSocketURL(URL(string: "https://example.com/s?q=1")),
                "wss://example.com/s?q=1"
            )
            XCTAssertEqual(WebSocketOperations.webSocketURL(URL(string: "ws://example.com/s")), "ws://example.com/s")
            XCTAssertEqual(WebSocketOperations.webSocketURL(nil), "")

            let session = URLSession(configuration: .ephemeral)
            defer { session.invalidateAndCancel() }
            let task = session.webSocketTask(with: URL(string: "ws://127.0.0.1:9/contract/run/case")!)
            XCTAssertEqual(WebSocketOperations(task: task).url, "ws://127.0.0.1:9/contract/run/case")
        }
    }
#endif
