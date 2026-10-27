@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeIconEffectsTests: XCTestCase {
    override class func setUp() {
        super.setUp()
        let input =
            Data(
                #"{"id":"warm","window":{"placement":{"type":"fullscreen"}},"root":{"type":"icon","name":"home","effect":{"type":"bounce"}}}"#
                    .utf8
            )
        XCTAssertNoThrow(try PrototypeSpecStrictValidator.validate(data: input))
    }

    func testSharedFixturesValidateAndDecode() throws {
        for name in ["icon-effects", "icon-effects-repeat"] {
            let input = try Data(
                contentsOf: PrototypeSpecFixtures.directory
                    .appendingPathComponent("valid/\(name).json")
            )
            try PrototypeSpecStrictValidator.validate(data: input)
            _ = try JSONDecoder().decode(PrototypeSpec.self, from: input)
        }
        for name in [
            "icon-effect-repeat-zero",
            "icon-effect-repeat-high",
            "icon-effect-repeat-fraction",
            "icon-effect-trigger-both",
            "icon-effect-trigger-repeat",
            "icon-effect-loop-limit",
            "icon-effect-expanded-loop-limit",
        ] {
            let invalid = try PrototypeSpecFixtures.invalid(name)
            XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(data: JSONEncoder().encode(invalid.spec)))
        }
    }

    func testEveryTypeAtEveryVersionTier() {
        for kind in PrototypeIconEffectKind.allCases {
            XCTAssertNil(kind.resolved(majorVersion: 16))
            XCTAssertEqual(kind.resolved(majorVersion: 26), kind)
            let ios17: PrototypeIconEffectKind? = switch kind {
            case .wiggle: .bounce
            case .rotate: nil
            case .breathe: .pulse
            case .drawOn: .replace
            default: kind
            }
            XCTAssertEqual(kind.resolved(majorVersion: 17), ios17)
            XCTAssertEqual(kind.resolved(majorVersion: 18), kind == .drawOn ? .replace : kind)
        }
    }

    func testCapabilityFloorUsesInjectedOS() {
        struct OS: OSVersionProvider { let majorVersion: Int }
        XCTAssertFalse(
            PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: 16))
                .contains("prototype_icon_effects_v1")
        )
        XCTAssertTrue(
            PrototypeAgentProtocol.advertisedCapabilities(os: OS(majorVersion: 17))
                .contains("prototype_icon_effects_v1")
        )
    }

    func testValidatorAcceptsEffectsAndRejectsExclusiveFields() throws {
        let prefix =
            #"{"id":"icons","window":{"placement":{"type":"fullscreen"}},"state":{"flag":false},"root":{"type":"icon","name":"home","effect":"#
        for kind in PrototypeIconEffectKind.allCases {
            let input = Data((prefix + #"{"type":"\#(kind.rawValue)","repeat":"infinite"}}}"#).utf8)
            try PrototypeSpecStrictValidator.validate(data: input)
            let spec = try JSONDecoder().decode(PrototypeSpec.self, from: input)
            XCTAssertEqual(spec.root.effect?.type, kind.rawValue)
        }
        XCTAssertThrowsError(try PrototypeSpecStrictValidator.validate(
            data: Data((prefix + #"{"type":"pulse","trigger":{"key":"flag"},"repeat":1}}}"#).utf8)
        ))
    }
}
