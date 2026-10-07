@testable import AutoMobileSDK
import Foundation
import os
import XCTest

// swiftlint:disable force_unwrapping

final class SdkTelephonyTriggerModulesTests: XCTestCase {
    private final class FakeCallReporter: SdkCallReporting {
        let calls = OSAllocatedUnfairLock<[String]>(initialState: [])
        let failure = OSAllocatedUnfairLock<String?>(initialState: nil)

        private func record(_ entry: String) -> String? {
            calls.withLock { $0.append(entry) }
            return failure.withLock { $0 }
        }

        func reportIncomingCall(id: UUID, phoneNumber: String) -> String? {
            record("incoming:\(id.uuidString.prefix(1)):\(phoneNumber)")
        }

        func answerCall(id: UUID) -> String? {
            record("answer:\(id.uuidString.prefix(1))")
        }

        func endCall(id: UUID, reason: SdkCallEndReason) -> String? {
            record("end:\(id.uuidString.prefix(1)):\(reason)")
        }

        func holdCall(id: UUID) -> String? {
            record("hold:\(id.uuidString.prefix(1))")
        }
    }

    /// Deterministic ids: the first call gets `1...`, the second `2...`.
    private func module(_ reporter: FakeCallReporter) -> SdkCallKitTriggerModule {
        let counter = OSAllocatedUnfairLock(initialState: 0)
        return SdkCallKitTriggerModule(reporter: reporter) {
            let next = counter.withLock { value -> Int in
                value += 1
                return value
            }
            return UUID(uuidString: "\(next)0000000-0000-0000-0000-000000000000")!
        }
    }

    // MARK: - CallKit

    func testCallAcceptHoldAndCancelDriveTheSameCall() {
        let reporter = FakeCallReporter()
        let calls = module(reporter)

        XCTAssertEqual(calls.handle(trigger: "call", payload: ["phoneNumber": "5551234567"]), .handled)
        XCTAssertEqual(calls.handle(trigger: "accept", payload: ["phoneNumber": "5551234567"]), .handled)
        XCTAssertEqual(calls.handle(trigger: "hold", payload: [:]), .handled)
        XCTAssertEqual(calls.handle(trigger: "cancel", payload: ["phoneNumber": "5551234567"]), .handled)

        XCTAssertEqual(reporter.calls.withLock { $0 }, [
            "incoming:1:5551234567", "answer:1", "hold:1", "end:1:remoteEnded",
        ])
    }

    func testBusyEndsUnansweredAndForgetsTheCall() {
        let reporter = FakeCallReporter()
        let calls = module(reporter)

        XCTAssertEqual(calls.handle(trigger: "call", payload: ["phoneNumber": "555"]), .handled)
        XCTAssertEqual(calls.handle(trigger: "busy", payload: ["phoneNumber": "555"]), .handled)
        XCTAssertEqual(calls.handle(trigger: "accept", payload: ["phoneNumber": "555"]), .failed("no_call_for_number"))
        XCTAssertEqual(calls.handle(trigger: "hold", payload: [:]), .failed("no_active_call"))

        XCTAssertEqual(reporter.calls.withLock { $0 }, ["incoming:1:555", "end:1:unanswered"])
    }

    func testCallsAreTrackedPerNumber() {
        let reporter = FakeCallReporter()
        let calls = module(reporter)

        XCTAssertEqual(calls.handle(trigger: "call", payload: ["phoneNumber": "111"]), .handled)
        XCTAssertEqual(calls.handle(trigger: "call", payload: ["phoneNumber": "222"]), .handled)
        XCTAssertEqual(calls.handle(trigger: "cancel", payload: ["phoneNumber": "111"]), .handled)
        XCTAssertEqual(calls.handle(trigger: "hold", payload: [:]), .handled)

        XCTAssertEqual(reporter.calls.withLock { $0 }, [
            "incoming:1:111", "incoming:2:222", "end:1:remoteEnded", "hold:2",
        ])
    }

    func testMissingNumberAndUnknownTriggerReachNoReporter() {
        let reporter = FakeCallReporter()
        let calls = module(reporter)

        XCTAssertEqual(calls.handle(trigger: "call", payload: [:]), .invalidPayload("missing_phone_number"))
        XCTAssertEqual(
            calls.handle(trigger: "call", payload: ["phoneNumber": ""]),
            .invalidPayload("missing_phone_number")
        )
        XCTAssertEqual(
            calls.handle(trigger: "accept", payload: ["phoneNumber": 5]),
            .invalidPayload("missing_phone_number")
        )
        XCTAssertEqual(calls.handle(trigger: "ring", payload: ["phoneNumber": "555"]), .unknownTrigger)
        XCTAssertEqual(calls.handle(trigger: "accept", payload: ["phoneNumber": "555"]), .failed("no_call_for_number"))

        XCTAssertEqual(reporter.calls.withLock { $0 }, [])
    }

    func testCallKitFailureIsReturnedAndTheCallIsNotTracked() {
        let reporter = FakeCallReporter()
        reporter.failure.withLock { $0 = "callkit_error: blocked" }
        let calls = module(reporter)

        XCTAssertEqual(
            calls.handle(trigger: "call", payload: ["phoneNumber": "555"]), .failed("callkit_error: blocked")
        )
        XCTAssertEqual(calls.handle(trigger: "accept", payload: ["phoneNumber": "555"]), .failed("no_call_for_number"))
    }

    func testCallKitFailureReachesTheHostAsTriggerFailed() throws {
        let reporter = FakeCallReporter()
        let handler = SdkTriggerRouteHandler(registry: SdkTriggerRegistry(modules: ["callkit": module(reporter)]))

        let response = try handler.handle(body: JSONSerialization.data(withJSONObject: [
            "module": "callkit", "trigger": "accept", "payload": ["phoneNumber": "555"],
        ]))

        XCTAssertEqual(response.statusCode, 409)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: response.body) as? NSDictionary)
        XCTAssertEqual(json, [
            "error": "trigger_failed", "module": "callkit", "trigger": "accept", "reason": "no_call_for_number",
        ])
    }

    // MARK: - Messages

    func testSmsPostsANotificationTitledWithTheSender() {
        let posted = OSAllocatedUnfairLock<[String]>(initialState: [])
        let messages = SdkMessagesTriggerModule { title, body in posted.withLock { $0.append("\(title)|\(body)") } }

        XCTAssertEqual(
            messages.handle(trigger: "sms", payload: ["phoneNumber": "555", "message": "hi\nthere"]),
            .handled
        )
        XCTAssertEqual(messages.handle(trigger: "sms", payload: ["phoneNumber": "555", "message": ""]), .handled)

        XCTAssertEqual(posted.withLock { $0 }, ["555|hi\nthere", "555|"])
    }

    func testSmsRejectsBadPayloadsWithoutPosting() {
        let posted = OSAllocatedUnfairLock(initialState: 0)
        let messages = SdkMessagesTriggerModule { _, _ in posted.withLock { $0 += 1 } }

        XCTAssertEqual(
            messages.handle(trigger: "sms", payload: ["message": "hi"]),
            .invalidPayload("missing_phone_number")
        )
        XCTAssertEqual(
            messages.handle(trigger: "sms", payload: ["phoneNumber": "555"]),
            .invalidPayload("missing_message")
        )
        XCTAssertEqual(
            messages.handle(trigger: "mms", payload: ["phoneNumber": "555", "message": "hi"]),
            .unknownTrigger
        )

        XCTAssertEqual(posted.withLock { $0 }, 0)
    }

    func testDefaultRegistryRegistersMessages() {
        XCTAssertNotNil(SdkTriggerRegistry.shared.module(named: "messages"))
        XCTAssertNotNil(SdkTriggerRegistry.shared.module(named: "biometrics"))
    }
}
