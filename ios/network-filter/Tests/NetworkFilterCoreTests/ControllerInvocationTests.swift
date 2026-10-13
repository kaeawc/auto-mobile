import Foundation
@testable import NetworkFilterCore
import XCTest

final class ControllerInvocationTests: XCTestCase {
    func testDefaultAndExplicitVersionsForEveryCommand() throws {
        for command in ControllerContract.commands {
            XCTAssertEqual(try ControllerInvocation.parse([command]).version, 3)
            for version in [3, 4] {
                for arguments in [
                    [command, "--contract-version", "\(version)", "--unknown", "value"],
                    [command, "--unknown", "value", "--contract-version", "\(version)"],
                    [command, "--unknown", "--contract-version", "\(version)", "value"],
                ] {
                    let invocation = try ControllerInvocation.parse(arguments)
                    XCTAssertEqual(invocation.command, command)
                    XCTAssertEqual(invocation.version, version)
                    XCTAssertEqual(invocation.arguments, ["--unknown", "value"])
                }
            }
        }
    }

    func testNegotiationErrorsUseNewestVersionAndNameSupportedVersions() throws {
        for suffix in [
            ["--contract-version"], ["--contract-version", "no"], ["--contract-version", "9"],
            ["--contract-version", "3", "--contract-version", "4"],
        ] {
            XCTAssertThrowsError(try ControllerInvocation.parse(["status"] + suffix)) { error in
                guard let error = error as? ControllerInvocationError else { return XCTFail("typed error") }
                XCTAssertEqual(error.result.version, 4)
                XCTAssertEqual(error.result.state, .unavailable)
                XCTAssertTrue(error.description.contains("Supported contract versions: 3, 4"))
            }
        }
    }

    func testUnknownFlagsRemainArgumentErrorsInBothModes() throws {
        for version in [3, 4] {
            let invocation = try ControllerInvocation.parse(["status", "--contract-version", "\(version)", "--unknown"])
            XCTAssertThrowsError(try ManagedSimulatorArguments.parse(invocation.arguments, canonicalize: { $0 }))
            for kind in NetworkRuleCommandKind.allCases {
                XCTAssertThrowsError(try NetworkRuleArguments.parse(kind, ["--unknown"], version: version) { $0 })
            }
        }
        XCTAssertThrowsError(try ManagedSimulatorArguments.parse(["--contract-version", "4"], canonicalize: { $0 }))
        XCTAssertThrowsError(try NetworkRuleArguments.parse(.apply, ["--contract-version", "4"]) { $0 })
    }
}
