import Foundation
@testable import NetworkFilterCore
import XCTest

final class ControllerInvocationTests: XCTestCase {
    func testDefaultAndExplicitVersionsForEveryCommand() throws {
        for command in ControllerContract.commands {
            XCTAssertEqual(try ControllerInvocation.parse([command]).version, 3)
            for version in [3, 4] {
                let invocation = try ControllerInvocation.parse([command, "--contract-version", "\(version)"])
                XCTAssertEqual(invocation.command, command)
                XCTAssertEqual(invocation.version, version)
                XCTAssertEqual(invocation.arguments, [])
            }
        }
    }

    func testNegotiationErrorsUseNewestVersionAndNameSupportedVersions() throws {
        for suffix in [
            ["--contract-version"], ["--contract-version", "x"], ["--contract-version", "9"],
            ["--contract-version", "+4"], ["--contract-version", "04"],
        ] {
            XCTAssertThrowsError(try ControllerInvocation.parse(["status"] + suffix)) { error in
                guard let error = error as? ControllerInvocationError else { return XCTFail("typed error") }
                XCTAssertEqual(error.result.version, 4)
                XCTAssertEqual(error.result.state, .unavailable)
                XCTAssertEqual(
                    error.description,
                    "Invalid or repeated --contract-version. Supported contract versions: 3, 4."
                )
            }
        }
    }

    func testLaterFlagIsPassedUnchangedForEveryCommand() throws {
        for command in ControllerContract.commands {
            for prefix in [[], ["--contract-version", "3"], ["--contract-version", "4"]] {
                if command == "activate", prefix.last == "4" { continue }
                let remaining = ["extra", "--contract-version", "4"]
                let invocation = try ControllerInvocation.parse([command] + prefix + remaining)
                XCTAssertEqual(invocation.version, prefix.last == "4" ? 4 : 3)
                XCTAssertEqual(invocation.arguments, remaining)
            }
        }
        for version in [3, 4] {
            let invocation = try ControllerInvocation.parse([
                "status", "--contract-version", "\(version)", "--contract-version", "4",
            ])
            XCTAssertEqual(invocation.version, version)
            XCTAssertEqual(invocation.arguments, ["--contract-version", "4"])
            XCTAssertThrowsError(try ManagedSimulatorArguments.parse(invocation.arguments, canonicalize: { $0 })) {
                XCTAssertEqual($0 as? ManagedSimulatorArgumentError, .unexpectedArgument("--contract-version"))
            }
        }
    }

    func testLegacyOwnerCanBeContractVersionToken() throws {
        let arguments = [
            "--managed", "/fixture/Devices", "DFBF2D27-6674-42EA-AFC4-AB702275D1D4",
            "--bundle-id", "dev.example.app", "--owner", "--contract-version", "--owner-generation", "1",
            "--revision", "1", "--lease-ms", "15000",
        ]
        let invocation = try ControllerInvocation.parse(["apply"] + arguments)
        XCTAssertEqual(invocation.version, 3)
        XCTAssertEqual(invocation.arguments, arguments)
        let command = try NetworkRuleArguments.parse(.apply, invocation.arguments, version: invocation.version) { $0 }
        XCTAssertEqual(command.ownership.owner, "--contract-version")
    }

    func testLegacyManagedProbeKeepsMainArgumentError() throws {
        let invocation = try ControllerInvocation.parse(["status", "--managed", "--contract-version", "4"])
        XCTAssertEqual(invocation.version, 3)
        XCTAssertEqual(invocation.arguments, ["--managed", "--contract-version", "4"])
        XCTAssertThrowsError(try ManagedSimulatorArguments.parse(invocation.arguments, canonicalize: { $0 })) {
            XCTAssertEqual(
                String(describing: $0),
                "--managed '--contract-version' '4' needs an absolute device-set path and a UUID"
            )
        }
    }

    func testActivateIgnoresTrailingArgumentsInVersionThree() throws {
        for prefix in [[], ["--contract-version", "3"]] {
            let invocation = try ControllerInvocation
                .parse(["activate"] + prefix + ["extra", "--contract-version", "4"])
            XCTAssertEqual(invocation.version, 3)
            XCTAssertEqual(invocation.arguments, ["extra", "--contract-version", "4"])
        }
    }

    func testActivateRejectsTrailingArgumentsInVersionFour() throws {
        for argument in ["extra", "--contract-version"] {
            XCTAssertThrowsError(try ControllerInvocation.parse(["activate", "--contract-version", "4", argument])) {
                guard let error = $0 as? ControllerInvocationError else { return XCTFail("typed error") }
                XCTAssertEqual(error.result.version, 4)
                XCTAssertEqual(error.result.state, .unavailable)
                XCTAssertEqual(
                    error.description,
                    "Unexpected argument '\(argument)'; use activate [--contract-version <3|4>]"
                )
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
