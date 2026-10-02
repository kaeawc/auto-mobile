@testable import AutoMobileSDK
import Foundation
import os
import XCTest

#if DEBUG
    final class NetworkMockRuleStoreConcurrencyTests: XCTestCase {
        func testConcurrentEvaluateConsumesExactlyTheLimit() {
            let dateProvider = FakeDateProvider(initialDate: Date(timeIntervalSince1970: 100))
            let store = NetworkMockRuleStore(dateProvider: dateProvider)
            let limit = 8
            store.setFaultRules([makeRule(limit: limit)])
            let request = makeRequest()
            let decisions = OSAllocatedUnfairLock(initialState: 0)

            DispatchQueue.concurrentPerform(iterations: 32) { _ in
                if store.evaluate(request) != nil {
                    decisions.withLock { $0 += 1 }
                }
            }

            XCTAssertEqual(decisions.withLock { $0 }, limit)
            XCTAssertNil(store.evaluate(request))
        }

        func testConcurrentSetFaultRulesAndEvaluateLeavesDeterministicFinalState() {
            let dateProvider = FakeDateProvider(initialDate: Date(timeIntervalSince1970: 100))
            let store = NetworkMockRuleStore(dateProvider: dateProvider)
            let rule = makeRule(limit: 1, scope: "session")
            let request = makeRequest()
            store.setFaultRules([rule])

            DispatchQueue.concurrentPerform(iterations: 32) { index in
                if index.isMultiple(of: 2) {
                    store.setFaultRules([rule])
                } else {
                    _ = store.evaluate(request)
                }
            }

            // Establish the final state after all concurrent calls have joined.
            store.setFaultRules([rule])
            XCTAssertEqual(store.evaluate(request)?.faultId, rule.faultId)
            XCTAssertNil(store.evaluate(request))
            store.clearFaultRules()
            XCTAssertNil(store.evaluate(request))
        }

        func testNetworkRuleStoreTypesAreSendable() {
            func requireSendable<T: Sendable>(_: T.Type) {}

            requireSendable(NetworkFaultTransport.self)
            requireSendable(NetworkFaultAction.self)
            requireSendable(NetworkFaultRuleDTO.self)
            requireSendable(NetworkMockRuleStore.self)
            requireSendable(NetworkMockRuleStore.FaultRequest.self)
            requireSendable(NetworkMockRuleStore.FaultDecision.self)
            requireSendable(NetworkMockRuleDTO.self)
            requireSendable(NetworkErrorSimulationDTO.self)
            requireSendable(NetworkMockRuleStore.ErrorSimulation.self)
            requireSendable(NetworkMockRuleStore.MatchedRule.self)
            requireSendable(NSRegularExpression.self)
        }

        private func makeRule(limit: Int, scope: String? = nil) -> NetworkFaultRuleDTO {
            NetworkFaultRuleDTO(
                faultId: "concurrent-fault",
                transport: .urlSession,
                host: "^api\\.example\\.com$",
                port: 443,
                scheme: "https",
                path: "^/v1$",
                method: "GET",
                headers: nil,
                origin: nil,
                connectionId: nil,
                sessionId: nil,
                action: .error,
                statusCode: nil,
                responseHeaders: nil,
                responseBody: nil,
                contentType: nil,
                errorType: "timeout",
                delayMs: nil,
                bandwidthBytesPerSecond: nil,
                dropBytes: nil,
                limit: limit,
                expiresAtEpochMs: 101_000,
                scope: scope,
                dryRun: false
            )
        }

        private func makeRequest() -> NetworkMockRuleStore.FaultRequest {
            NetworkMockRuleStore.FaultRequest(
                transport: .urlSession, host: "api.example.com", port: 443, scheme: "https",
                path: "/v1", method: "GET", headers: [:], origin: nil,
                connectionId: "connection", sessionId: "session"
            )
        }
    }
#endif
