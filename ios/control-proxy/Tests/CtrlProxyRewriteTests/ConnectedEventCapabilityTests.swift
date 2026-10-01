@testable import CtrlProxyRewrite
import Foundation
import XCTest

final class ConnectedEventCapabilityTests: XCTestCase {
    func testAdvertisedCommandsHaveDispatchPaths() {
        for environment in [RunnerEnvironment.simulator, .device] {
            let advertised = ConnectedEvent(id: 1, environment: environment).supportedCommands
            let dispatchable = Set(CommandHandler.supportedRequestTypes(in: environment))
            XCTAssertEqual(Set(advertised), Set(dispatchable.map(\.rawValue)))
            for command in advertised {
                guard let requestType = RequestType(rawValue: command) else {
                    XCTFail("Unknown advertised command: \(command)")
                    continue
                }
                XCTAssertTrue(dispatchable.contains(requestType))
                XCTAssertEqual(requestType.rawValue, command)
            }
        }

        // These commands use the minimal RequestEnvelope payload, so the same
        // discriminator can also be checked through the wire decoder.
        for requestType in [RequestType.requestScreenshot, .getSdkCapabilities, .getCurrentFocus] {
            let envelope = #"{"type":"\#(requestType.rawValue)","requestId":"capability-test"}"#
            let decoded = try? JSONDecoder().decode(WebSocketRequest.self, from: Data(envelope.utf8))
            XCTAssertEqual(decoded?.requestType, requestType)
        }
    }

    func testEnvironmentSpecificCapabilities() {
        let simulator = Set(ConnectedEvent(id: 1, environment: .simulator).supportedCommands)
        let device = Set(ConnectedEvent(id: 1, environment: .device).supportedCommands)

        XCTAssertFalse(simulator.contains(RequestType.setVoiceOverState.rawValue))
        XCTAssertTrue(device.contains(RequestType.setVoiceOverState.rawValue))
        XCTAssertTrue(simulator.contains(RequestType.setHingeAngle.rawValue))
        XCTAssertFalse(device.contains(RequestType.setHingeAngle.rawValue))

        // The button request remains supported in both environments: Home and
        // Back can succeed even when some button payloads cannot.
        XCTAssertTrue(simulator.contains(RequestType.requestPressButton.rawValue))
        XCTAssertTrue(device.contains(RequestType.requestPressButton.rawValue))
    }

    func testListsAreSortedAndNonEmpty() {
        for environment in [RunnerEnvironment.simulator, .device] {
            let commands = ConnectedEvent(id: 1, environment: environment).supportedCommands
            XCTAssertFalse(commands.isEmpty)
            XCTAssertEqual(commands, commands.sorted())
            XCTAssertEqual(commands.count, Set(commands).count)
        }
    }
}
