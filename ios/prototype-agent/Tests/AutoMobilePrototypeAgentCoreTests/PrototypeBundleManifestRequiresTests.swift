@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeBundleManifestRequiresTests: XCTestCase {
    private func manifest(_ requires: String) -> Data {
        let hash = String(repeating: "0", count: 64)
        return Data("""
        {"bundleFormatVersion":1,"specSha256":"\(hash)","assets":[],"fonts":[],"requires":\(requires)}
        """.utf8)
    }

    func testCamelCaseGeneratedCapabilityNamesAreAccepted() throws {
        let names = ["prototype_platform_deviceStatus_v1", "prototype_platform_secureStorage_v1"]
        let requires = "[\"\(names[0])\",\"\(names[1])\"]"
        XCTAssertEqual(try PrototypeBundleManifest(manifest(requires)).requires, names)
    }

    func testInvalidUnsortedAndDuplicateRequiresAreRejected() {
        for requires in [
            #"["SecureStorage"]"#,
            #"["prototype_platform_secure-storage_v1"]"#,
            #"["prototype_platform_secureStorage_v1","prototype_platform_deviceStatus_v1"]"#,
            #"["prototype_platform_secureStorage_v1","prototype_platform_secureStorage_v1"]"#,
        ] {
            XCTAssertThrowsError(try PrototypeBundleManifest(manifest(requires)), requires) { error in
                XCTAssertEqual((error as? PrototypeBundleFailure)?.code, .requiresInvalid, requires)
            }
        }
    }
}
