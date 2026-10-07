@testable import AutoMobileSDK
import Foundation
import os
import XCTest

final class SdkTriggerRouteHandlerTests: XCTestCase {
    private final class RecordingModule: SdkTriggerModule {
        let received = OSAllocatedUnfairLock<[String]>(initialState: [])
        let outcome: SdkTriggerOutcome

        init(outcome: SdkTriggerOutcome = .handled) {
            self.outcome = outcome
        }

        var triggers: [String] {
            ["ring"]
        }

        func handle(trigger: String, payload: [String: Any]) -> SdkTriggerOutcome {
            let number = payload["number"] as? String ?? ""
            received.withLock { $0.append("\(trigger):\(number)") }
            return trigger == "ring" ? outcome : .unknownTrigger
        }
    }

    private final class BiometricsSink: Sendable {
        let overrides = OSAllocatedUnfairLock<[String]>(initialState: [])
        let clears = OSAllocatedUnfairLock(initialState: 0)

        func module() -> SdkBiometricsTriggerModule {
            SdkBiometricsTriggerModule(
                override: { result, ttl in self.overrides.withLock { $0.append("\(result)/\(ttl)") } },
                clear: { self.clears.withLock { $0 += 1 } }
            )
        }
    }

    private func body(_ fields: [String: Any]) throws -> Data {
        try JSONSerialization.data(withJSONObject: fields)
    }

    private func json(_ response: SdkRouteResponse) throws -> [String: Any] {
        try XCTUnwrap(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
    }

    override func tearDown() {
        AutoMobileBiometrics.shared.reset()
        super.tearDown()
    }

    // MARK: - Route

    func testDeliversNamedTriggerAndPayloadToRegisteredModule() throws {
        let module = RecordingModule()
        let handler = SdkTriggerRouteHandler(registry: SdkTriggerRegistry(modules: ["calls": module]))

        let response = handler.handle(body: try body([
            "module": "calls", "trigger": "ring", "payload": ["number": "5551234567"],
        ]))

        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(try json(response) as NSDictionary, ["status": "ok", "module": "calls", "trigger": "ring"])
        XCTAssertEqual(module.received.withLock { $0 }, ["ring:5551234567"])
    }

    func testMissingPayloadIsDeliveredAsEmptyObject() throws {
        let module = RecordingModule()
        let handler = SdkTriggerRouteHandler(registry: SdkTriggerRegistry(modules: ["calls": module]))

        XCTAssertEqual(handler.handle(body: try body(["module": "calls", "trigger": "ring"])).statusCode, 200)
        XCTAssertEqual(module.received.withLock { $0 }, ["ring:"])
    }

    func testUnregisteredModuleIsAStructuredNotFound() throws {
        let handler = SdkTriggerRouteHandler(registry: SdkTriggerRegistry(modules: ["calls": RecordingModule()]))

        let response = handler.handle(body: try body(["module": "messages", "trigger": "sms"]))

        XCTAssertEqual(response.statusCode, 404)
        XCTAssertEqual(try json(response) as NSDictionary, [
            "error": "module_not_registered", "module": "messages", "registeredModules": ["calls"],
        ])
    }

    func testUnknownTriggerListsTheModulesTriggers() throws {
        let module = RecordingModule()
        let handler = SdkTriggerRouteHandler(registry: SdkTriggerRegistry(modules: ["calls": module]))

        let response = handler.handle(body: try body(["module": "calls", "trigger": "hangup"]))

        XCTAssertEqual(response.statusCode, 400)
        XCTAssertEqual(try json(response) as NSDictionary, [
            "error": "unknown_trigger", "module": "calls", "trigger": "hangup", "supportedTriggers": ["ring"],
        ])
    }

    func testInvalidPayloadCarriesTheModulesReason() throws {
        let handler = SdkTriggerRouteHandler(registry: SdkTriggerRegistry(modules: [
            "calls": RecordingModule(outcome: .invalidPayload("missing_number")),
        ]))

        let response = handler.handle(body: try body(["module": "calls", "trigger": "ring"]))

        XCTAssertEqual(response.statusCode, 400)
        XCTAssertEqual(try json(response)["reason"] as? String, "missing_number")
        XCTAssertEqual(try json(response)["error"] as? String, "invalid_payload")
    }

    func testMalformedBodiesAreBadRequestsAndReachNoModule() throws {
        let module = RecordingModule()
        let handler = SdkTriggerRouteHandler(registry: SdkTriggerRegistry(modules: ["calls": module]))
        let bodies: [Data] = [
            Data(),
            Data("not json".utf8),
            Data("[]".utf8),
            try body(["trigger": "ring"]),
            try body(["module": "calls"]),
            try body(["module": "", "trigger": "ring"]),
            try body(["module": "calls", "trigger": 7]),
            try body(["module": "calls", "trigger": "ring", "payload": "5551234567"]),
        ]
        for request in bodies {
            let response = handler.handle(body: request)
            XCTAssertEqual(response.statusCode, 400)
            XCTAssertEqual(try json(response) as NSDictionary, ["error": "bad_request"])
        }
        XCTAssertEqual(module.received.withLock { $0 }, [])
    }

    func testRegistryRegistersAndUnregistersModules() {
        let registry = SdkTriggerRegistry()
        registry.register("calls", module: RecordingModule())
        registry.register("messages", module: RecordingModule())
        XCTAssertEqual(registry.moduleNames, ["calls", "messages"])

        registry.unregister("calls")
        XCTAssertNil(registry.module(named: "calls"))
        XCTAssertEqual(registry.moduleNames, ["messages"])
    }

    func testSharedRegistryRegistersBiometricsAndHealthAdvertisesTheRoute() {
        XCTAssertNotNil(SdkTriggerRegistry.shared.module(named: "biometrics"))
        XCTAssertTrue(SdkHierarchyServer.capabilities.contains("sdk-trigger"))
    }

    // MARK: - Biometrics module

    func testBiometricsOverrideMapsAndroidBroadcastResults() {
        let sink = BiometricsSink()
        let module = sink.module()

        XCTAssertEqual(module.handle(trigger: "override", payload: ["result": "SUCCESS"]), .handled)
        XCTAssertEqual(module.handle(trigger: "override", payload: ["result": "failure", "ttlMs": 250]), .handled)
        XCTAssertEqual(module.handle(trigger: "override", payload: ["result": "CANCEL"]), .handled)
        XCTAssertEqual(
            module.handle(trigger: "override", payload: ["result": "ERROR", "errorCode": 7, "errorMessage": "lockout"]),
            .handled
        )
        XCTAssertEqual(module.handle(trigger: "override", payload: ["result": "ERROR"]), .handled)

        XCTAssertEqual(sink.overrides.withLock { $0 }, [
            "success/5000",
            "failure/250",
            "cancel/5000",
            "error(code: 7, message: \"lockout\")/5000",
            "error(code: -1, message: \"\")/5000",
        ])
    }

    func testBiometricsOverrideRejectsBadPayloadsWithoutOverriding() {
        let sink = BiometricsSink()
        let module = sink.module()
        let cases: [([String: Any], String)] = [
            ([:], "missing_result"),
            (["result": 1], "missing_result"),
            (["result": "MAYBE"], "unknown_result"),
            (["result": "SUCCESS", "ttlMs": 0], "invalid_ttl_ms"),
            (["result": "SUCCESS", "ttlMs": 1.5], "invalid_ttl_ms"),
            (["result": "SUCCESS", "ttlMs": true], "invalid_ttl_ms"),
            (["result": "SUCCESS", "ttlMs": "100"], "invalid_ttl_ms"),
            (["result": "ERROR", "errorCode": "7"], "invalid_error_code"),
        ]
        for (payload, reason) in cases {
            XCTAssertEqual(module.handle(trigger: "override", payload: payload), .invalidPayload(reason), reason)
        }
        XCTAssertEqual(sink.overrides.withLock { $0 }, [])
    }

    func testBiometricsClearAndUnknownTrigger() {
        let sink = BiometricsSink()
        let module = sink.module()

        XCTAssertEqual(module.handle(trigger: "clear", payload: [:]), .handled)
        XCTAssertEqual(module.handle(trigger: "enroll", payload: [:]), .unknownTrigger)
        XCTAssertEqual(sink.clears.withLock { $0 }, 1)
        XCTAssertEqual(module.triggers, ["override", "clear"])
    }

    func testRouteSetsTheRealBiometricOverride() throws {
        let handler = SdkTriggerRouteHandler(registry: SdkTriggerRegistry(modules: [
            "biometrics": SdkBiometricsTriggerModule(),
        ]))

        let response = handler.handle(body: try body([
            "module": "biometrics", "trigger": "override", "payload": ["result": "CANCEL", "ttlMs": 60000],
        ]))

        XCTAssertEqual(response.statusCode, 200)
        XCTAssertEqual(AutoMobileBiometrics.shared.consumeOverride(), .cancel)
    }
}
