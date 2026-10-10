@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

private let token = "0123456789abcdef-launch-token"

private func line(_ object: [String: Any]) throws -> Data {
    try JSONSerialization.data(withJSONObject: object)
}

final class PrototypeAgentConfigurationTests: XCTestCase {
    func testReadsPortAndTokenFromEnvironment() {
        let result = PrototypeAgentConfiguration.from(environment: [
            "AUTOMOBILE_PROTOTYPE_PORT": "51234",
            "AUTOMOBILE_PROTOTYPE_TOKEN": token,
        ])
        XCTAssertEqual(result, .success(PrototypeAgentConfiguration(port: 51234, token: token)))
    }

    func testRequiresHostAllocatedPort() {
        XCTAssertEqual(
            PrototypeAgentConfiguration.from(environment: ["AUTOMOBILE_PROTOTYPE_TOKEN": token]),
            .failure(.missingPort)
        )
        for value in ["0", "70000", "-1", "abc", ""] {
            XCTAssertEqual(
                PrototypeAgentConfiguration.from(environment: [
                    "AUTOMOBILE_PROTOTYPE_PORT": value,
                    "AUTOMOBILE_PROTOTYPE_TOKEN": token,
                ]),
                .failure(.invalidPort(value)),
                value
            )
        }
    }

    func testRequiresALongEnoughToken() {
        XCTAssertEqual(
            PrototypeAgentConfiguration.from(environment: ["AUTOMOBILE_PROTOTYPE_PORT": "51234"]),
            .failure(.missingToken)
        )
        XCTAssertEqual(
            PrototypeAgentConfiguration.from(environment: [
                "AUTOMOBILE_PROTOTYPE_PORT": "51234",
                "AUTOMOBILE_PROTOTYPE_TOKEN": "",
            ]),
            .failure(.missingToken)
        )
        XCTAssertEqual(
            PrototypeAgentConfiguration.from(environment: [
                "AUTOMOBILE_PROTOTYPE_PORT": "51234",
                "AUTOMOBILE_PROTOTYPE_TOKEN": "short",
            ]),
            .failure(.tokenTooShort)
        )
    }
}

final class PrototypeLineFramerTests: XCTestCase {
    func testSplitsLinesAcrossChunks() {
        var framer = PrototypeLineFramer()
        framer.append(Data("{\"a\":1}\n{\"b\"".utf8))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(Data("{\"a\":1}".utf8)))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(nil))
        framer.append(Data(":2}\n".utf8))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(Data("{\"b\":2}".utf8)))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(nil))
        XCTAssertTrue(framer.buffered.isEmpty)
    }

    func testRejectsAnUnterminatedLineOverTheLimit() {
        var framer = PrototypeLineFramer()
        framer.append(Data(repeating: 0x41, count: 11))
        XCTAssertEqual(framer.nextLine(limit: 10), .failure(.init(limit: 10)))
    }

    func testRejectsATerminatedLineOverTheLimit() {
        var framer = PrototypeLineFramer()
        framer.append(Data(repeating: 0x41, count: 11) + Data([0x0A]))
        XCTAssertEqual(framer.nextLine(limit: 10), .failure(.init(limit: 10)))
    }

    func testLimitAppliesPerLineSoLaterFramesCanBeLarger() {
        var framer = PrototypeLineFramer()
        framer.append(Data("hi\n".utf8) + Data(repeating: 0x41, count: 50) + Data([0x0A]))
        XCTAssertEqual(framer.nextLine(limit: 10), .success(Data("hi".utf8)))
        XCTAssertEqual(framer.nextLine(limit: 100), .success(Data(repeating: 0x41, count: 50)))
    }
}

final class PrototypeConnectionGateTests: XCTestCase {
    func testHelloWithTheLaunchTokenAuthenticatesAndReportsVersions() throws {
        var gate = PrototypeConnectionGate(token: token)
        XCTAssertEqual(gate.frameLimit, PrototypeAgentProtocol.maxHelloBytes)
        guard case let .helloAccepted(result) = try gate.receive(line: line(["type": "hello", "token": token])) else {
            return XCTFail("hello was not accepted")
        }
        XCTAssertEqual(result["type"] as? String, "hello_result")
        XCTAssertEqual(result["protocolVersion"] as? Int, PrototypeAgentProtocol.protocolVersion)
        XCTAssertEqual(result["agentVersion"] as? String, PrototypeAgentProtocol.agentVersion)
        XCTAssertEqual(result["capabilities"] as? [String], PrototypeAgentProtocol.capabilities)
        XCTAssertTrue(gate.isAuthenticated)
        XCTAssertEqual(gate.frameLimit, PrototypeAgentProtocol.maxFrameBytes)
    }

    func testHelloResultAdvertisesTheCapabilitiesTheGateWasGiven() throws {
        let capabilities = PrototypeTestHooks.capabilities(enabled: true)
        var gate = PrototypeConnectionGate(token: token, capabilities: capabilities)
        guard case let .helloAccepted(result) = try gate.receive(line: line(["type": "hello", "token": token])) else {
            return XCTFail("hello was not accepted")
        }
        XCTAssertEqual(result["capabilities"] as? [String], capabilities)
    }

    func testCapabilitiesDoNotAdvertiseTheRemovedUpdatePath() {
        XCTAssertFalse(PrototypeAgentProtocol.capabilities.contains("update_prototype"))
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains("show_prototype"))
    }

    func testAdvertisesInPlaceShowWithReset() {
        XCTAssertEqual(PrototypeAgentProtocol.showInPlaceCapability, "prototype_show_in_place_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.showInPlaceCapability))
    }

    func testAdvertisesInspect() {
        XCTAssertEqual(PrototypeAgentProtocol.inspectCapability, "prototype_inspect_v1")
        XCTAssertTrue(PrototypeAgentProtocol.capabilities.contains(PrototypeAgentProtocol.inspectCapability))
    }

    func testWrongTokenClosesWithoutReply() throws {
        var gate = PrototypeConnectionGate(token: token)
        let action = try gate.receive(line: line(["type": "hello", "token": token + "x"]))
        guard case .close(.badToken) = action else { return XCTFail("expected close, got \(action)") }
        XCTAssertEqual(gate.state, .closed)
    }

    func testMissingTokenCloses() throws {
        var gate = PrototypeConnectionGate(token: token)
        guard case .close(.badToken) = try gate.receive(line: line(["type": "hello"])) else {
            return XCTFail("expected close")
        }
    }

    func testARequestBeforeHelloClosesAndIsNeverDispatched() throws {
        var gate = PrototypeConnectionGate(token: token)
        let action = try gate.receive(line: line(["type": "get_prototype_status", "token": token]))
        guard case .close(.notHello) = action else { return XCTFail("expected close, got \(action)") }
        // Later lines on the closed connection do nothing, even a valid hello.
        guard case .ignore = try gate.receive(line: line(["type": "hello", "token": token])) else {
            return XCTFail("closed gate reopened")
        }
        XCTAssertEqual(gate.state, .closed)
    }

    func testNonJSONBeforeHelloCloses() {
        var gate = PrototypeConnectionGate(token: token)
        guard case .close(.notJSON) = gate.receive(line: Data("hello".utf8)) else {
            return XCTFail("expected close")
        }
    }

    func testBlankLinesAreIgnoredBeforeAndAfterHello() throws {
        var gate = PrototypeConnectionGate(token: token)
        guard case .ignore = gate.receive(line: Data(" \r".utf8)) else { return XCTFail("expected ignore") }
        XCTAssertEqual(gate.state, .awaitingHello)
        _ = try gate.receive(line: line(["type": "hello", "token": token]))
        guard case .ignore = gate.receive(line: Data()) else { return XCTFail("expected ignore") }
    }

    func testAuthenticatedRequestsAreDispatched() throws {
        var gate = PrototypeConnectionGate(token: token)
        _ = try gate.receive(line: line(["type": "hello", "token": token]))
        guard case let .dispatch(message) = try gate.receive(line: line([
            "type": "get_prototype_status",
            "requestId": "r1",
        ])) else {
            return XCTFail("expected dispatch")
        }
        XCTAssertEqual(message["type"] as? String, "get_prototype_status")
        XCTAssertEqual(message["requestId"] as? String, "r1")
    }

    func testAuthenticatedNonObjectGetsAnErrorResultAndStaysOpen() throws {
        var gate = PrototypeConnectionGate(token: token)
        _ = try gate.receive(line: line(["type": "hello", "token": token]))
        guard case let .rejectMalformed(result) = gate.receive(line: Data("[1]".utf8)) else {
            return XCTFail("expected rejectMalformed")
        }
        XCTAssertEqual(result["success"] as? Bool, false)
        XCTAssertTrue(gate.isAuthenticated)
    }

    func testFailClosesOnceAndOnlyOnce() {
        var gate = PrototypeConnectionGate(token: token)
        guard case .close(.helloTimeout) = gate.fail(.helloTimeout) else { return XCTFail("expected close") }
        guard case .ignore = gate.fail(.frameTooLarge) else { return XCTFail("expected ignore") }
    }

    func testConstantTimeEquals() {
        XCTAssertTrue(PrototypeConnectionGate.constantTimeEquals(token, token))
        XCTAssertFalse(PrototypeConnectionGate.constantTimeEquals(token, String(token.dropLast()) + "X"))
        XCTAssertFalse(PrototypeConnectionGate.constantTimeEquals(token, token + "x"))
        XCTAssertFalse(PrototypeConnectionGate.constantTimeEquals("", token))
    }
}
