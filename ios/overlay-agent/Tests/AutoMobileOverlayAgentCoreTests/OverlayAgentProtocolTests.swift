@testable import AutoMobileOverlayAgentCore
import Foundation
import XCTest

private let token = "0123456789abcdef-launch-token"

private func line(_ object: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: object)
}

final class OverlayAgentConfigurationTests: XCTestCase {
    func testReadsPortAndTokenFromEnvironment() {
        let result = OverlayAgentConfiguration.from(environment: [
            "AUTOMOBILE_OVERLAY_PORT": "51234",
            "AUTOMOBILE_OVERLAY_TOKEN": token,
        ])
        XCTAssertEqual(result, .success(OverlayAgentConfiguration(port: 51234, token: token)))
    }

    func testRequiresHostAllocatedPort() {
        XCTAssertEqual(
            OverlayAgentConfiguration.from(environment: ["AUTOMOBILE_OVERLAY_TOKEN": token]),
            .failure(.missingPort)
        )
        for value in ["0", "70000", "-1", "abc", ""] {
            XCTAssertEqual(
                OverlayAgentConfiguration.from(environment: [
                    "AUTOMOBILE_OVERLAY_PORT": value,
                    "AUTOMOBILE_OVERLAY_TOKEN": token,
                ]),
                .failure(.invalidPort(value)),
                value
            )
        }
    }

    func testRequiresALongEnoughToken() {
        XCTAssertEqual(
            OverlayAgentConfiguration.from(environment: ["AUTOMOBILE_OVERLAY_PORT": "51234"]),
            .failure(.missingToken)
        )
        XCTAssertEqual(
            OverlayAgentConfiguration.from(environment: [
                "AUTOMOBILE_OVERLAY_PORT": "51234",
                "AUTOMOBILE_OVERLAY_TOKEN": "",
            ]),
            .failure(.missingToken)
        )
        XCTAssertEqual(
            OverlayAgentConfiguration.from(environment: [
                "AUTOMOBILE_OVERLAY_PORT": "51234",
                "AUTOMOBILE_OVERLAY_TOKEN": "short",
            ]),
            .failure(.tokenTooShort)
        )
    }
}

final class OverlayLineFramerTests: XCTestCase {
    func testSplitsLinesAcrossChunks() {
        var framer = OverlayLineFramer()
        framer.append(Data("{\"a\":1}\n{\"b\"".utf8))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(Data("{\"a\":1}".utf8)))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(nil))
        framer.append(Data(":2}\n".utf8))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(Data("{\"b\":2}".utf8)))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(nil))
        XCTAssertTrue(framer.buffered.isEmpty)
    }

    func testRejectsAnUnterminatedLineOverTheLimit() {
        var framer = OverlayLineFramer()
        framer.append(Data(repeating: 0x41, count: 11))
        XCTAssertEqual(framer.nextLine(limit: 10), .failure(.init(limit: 10)))
    }

    func testRejectsATerminatedLineOverTheLimit() {
        var framer = OverlayLineFramer()
        framer.append(Data(repeating: 0x41, count: 11) + Data([0x0A]))
        XCTAssertEqual(framer.nextLine(limit: 10), .failure(.init(limit: 10)))
    }

    func testLimitAppliesPerLineSoLaterFramesCanBeLarger() {
        var framer = OverlayLineFramer()
        framer.append(Data("hi\n".utf8) + Data(repeating: 0x41, count: 50) + Data([0x0A]))
        XCTAssertEqual(framer.nextLine(limit: 10), .success(Data("hi".utf8)))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(Data(repeating: 0x41, count: 50)))
    }
}

final class OverlayConnectionGateTests: XCTestCase {
    func testHelloWithTheLaunchTokenAuthenticatesAndReportsVersions() throws {
        var gate = OverlayConnectionGate(token: token)
        XCTAssertEqual(gate.frameLimit, OverlayAgentProtocol.maxHelloBytes)
        guard case let .helloAccepted(result) = try gate.receive(line: line(["type": "hello", "token": token])) else {
            return XCTFail("hello was not accepted")
        }
        XCTAssertEqual(result["type"] as? String, "hello_result")
        XCTAssertEqual(result["protocolVersion"] as? Int, OverlayAgentProtocol.protocolVersion)
        XCTAssertEqual(result["agentVersion"] as? String, OverlayAgentProtocol.agentVersion)
        XCTAssertEqual(result["capabilities"] as? [String], OverlayAgentProtocol.capabilities)
        XCTAssertTrue(gate.isAuthenticated)
        XCTAssertEqual(gate.frameLimit, OverlayAgentProtocol.maxFrameBytes)
    }

    func testHelloResultAdvertisesTheCapabilitiesTheGateWasGiven() throws {
        let capabilities = OverlayTestHooks.capabilities(enabled: true)
        var gate = OverlayConnectionGate(token: token, capabilities: capabilities)
        guard case let .helloAccepted(result) = try gate.receive(line: line(["type": "hello", "token": token])) else {
            return XCTFail("hello was not accepted")
        }
        XCTAssertEqual(result["capabilities"] as? [String], capabilities)
    }

    func testCapabilitiesDoNotAdvertiseTheRemovedUpdatePath() {
        XCTAssertFalse(OverlayAgentProtocol.capabilities.contains("update_overlay"))
        XCTAssertTrue(OverlayAgentProtocol.capabilities.contains("show_overlay"))
    }

    func testAdvertisesInPlaceShowWithReset() {
        XCTAssertEqual(OverlayAgentProtocol.showInPlaceCapability, "overlay_show_in_place_v1")
        XCTAssertTrue(OverlayAgentProtocol.capabilities.contains(OverlayAgentProtocol.showInPlaceCapability))
    }

    func testAdvertisesInspect() {
        XCTAssertEqual(OverlayAgentProtocol.inspectCapability, "overlay_inspect_v1")
        XCTAssertTrue(OverlayAgentProtocol.capabilities.contains(OverlayAgentProtocol.inspectCapability))
    }

    func testWrongTokenClosesWithoutReply() throws {
        var gate = OverlayConnectionGate(token: token)
        let action = try gate.receive(line: line(["type": "hello", "token": token + "x"]))
        guard case .close(.badToken) = action else { return XCTFail("expected close, got \(action)") }
        XCTAssertEqual(gate.state, .closed)
    }

    func testMissingTokenCloses() throws {
        var gate = OverlayConnectionGate(token: token)
        guard case .close(.badToken) = try gate.receive(line: line(["type": "hello"])) else {
            return XCTFail("expected close")
        }
    }

    func testARequestBeforeHelloClosesAndIsNeverDispatched() throws {
        var gate = OverlayConnectionGate(token: token)
        let action = try gate.receive(line: line(["type": "get_overlay_status", "token": token]))
        guard case .close(.notHello) = action else { return XCTFail("expected close, got \(action)") }
        // Later lines on the closed connection do nothing, even a valid hello.
        guard case .ignore = try gate.receive(line: line(["type": "hello", "token": token])) else {
            return XCTFail("closed gate reopened")
        }
        XCTAssertEqual(gate.state, .closed)
    }

    func testNonJSONBeforeHelloCloses() {
        var gate = OverlayConnectionGate(token: token)
        guard case .close(.notJSON) = gate.receive(line: Data("hello".utf8)) else {
            return XCTFail("expected close")
        }
    }

    func testBlankLinesAreIgnoredBeforeAndAfterHello() throws {
        var gate = OverlayConnectionGate(token: token)
        guard case .ignore = gate.receive(line: Data(" \r".utf8)) else { return XCTFail("expected ignore") }
        XCTAssertEqual(gate.state, .awaitingHello)
        _ = try gate.receive(line: line(["type": "hello", "token": token]))
        guard case .ignore = gate.receive(line: Data()) else { return XCTFail("expected ignore") }
    }

    func testAuthenticatedRequestsAreDispatched() throws {
        var gate = OverlayConnectionGate(token: token)
        _ = try gate.receive(line: line(["type": "hello", "token": token]))
        guard case let .dispatch(message) = try gate.receive(line: line([
            "type": "get_overlay_status",
            "requestId": "r1",
        ])) else {
            return XCTFail("expected dispatch")
        }
        XCTAssertEqual(message["type"] as? String, "get_overlay_status")
        XCTAssertEqual(message["requestId"] as? String, "r1")
    }

    func testAuthenticatedNonObjectGetsAnErrorResultAndStaysOpen() throws {
        var gate = OverlayConnectionGate(token: token)
        _ = try gate.receive(line: line(["type": "hello", "token": token]))
        guard case let .rejectMalformed(result) = gate.receive(line: Data("[1]".utf8)) else {
            return XCTFail("expected rejectMalformed")
        }
        XCTAssertEqual(result["success"] as? Bool, false)
        XCTAssertTrue(gate.isAuthenticated)
    }

    func testFailClosesOnceAndOnlyOnce() {
        var gate = OverlayConnectionGate(token: token)
        guard case .close(.helloTimeout) = gate.fail(.helloTimeout) else { return XCTFail("expected close") }
        guard case .ignore = gate.fail(.frameTooLarge) else { return XCTFail("expected ignore") }
    }

    func testConstantTimeEquals() {
        XCTAssertTrue(OverlayConnectionGate.constantTimeEquals(token, token))
        XCTAssertFalse(OverlayConnectionGate.constantTimeEquals(token, String(token.dropLast()) + "X"))
        XCTAssertFalse(OverlayConnectionGate.constantTimeEquals(token, token + "x"))
        XCTAssertFalse(OverlayConnectionGate.constantTimeEquals("", token))
    }
}
