@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeBundleSecretsTests: XCTestCase {
    private func scan(_ text: String) -> [PrototypeBundleSecretWarning] { PrototypeBundleSecrets.scan(Data(text.utf8)) }

    func testCredentialNamesAndQueryKeysIgnoreCaseAndNeverExposeValues() {
        let warnings =
            scan(
                #"{"root":{"onTap":{"type":"request","url":"https://example.com/?ToKeN=hidden&KEY=x&Secret=y&SIG=z","headers":{"aUtHoRiZaTiOn":"do-not-return","COOKIE":"secret","X-Api-Key":"secret","Accept":"ok"}}}}"#
            )
        XCTAssertEqual(warnings.map(\.path), [
            "$.root.onTap.headers.aUtHoRiZaTiOn", "$.root.onTap.headers.COOKIE", "$.root.onTap.headers.X-Api-Key",
            "$.root.onTap.url.query.ToKeN", "$.root.onTap.url.query.KEY", "$.root.onTap.url.query.Secret",
            "$.root.onTap.url.query.SIG",
        ])
        XCTAssertEqual(warnings.filter { $0.code == .credentialHeader }.count, 3)
        XCTAssertEqual(warnings.filter { $0.code == .credentialQuery }.count, 4)
        XCTAssertFalse(String(describing: warnings).contains("do-not-return"))
    }

    func testPrivateAndLoopbackHostsIncludingLegacyAndMappedLiterals() {
        for host in [
            "localhost",
            "sub.localhost.",
            "127.0.0.1",
            "10.0.2.2",
            "192.168.1.1",
            "169.254.1.2",
            "[::1]",
            "[fe80::1]",
            "[::ffff:7f00:1]",
            "0x7f000001",
        ] {
            XCTAssertEqual(
                scan("{\"type\":\"request\",\"url\":\"http://\(host)/\"}"),
                [.init(code: .privateHost, path: "$.url")],
                host
            )
        }
    }

    func testPublicHostsAndOpaqueText() {
        XCTAssertEqual(
            scan(#"[{"type":"request","url":"https://1.1.1.1/"},{"type":"request","url":"https://example.com/"}]"#),
            []
        )
        XCTAssertEqual(scan(#"{"text":"{\"type\":\"request\",\"headers\":{\"Authorization\":\"x\"}}"}"#), [])
    }

    func testInvalidAndTemplatedURLsNeverBlockScan() {
        for text in ["{", #"{"type":"request","url":"{data:/url}"}"#, #"{"type":"request","type":"request"}"#] {
            XCTAssertEqual(scan(text), [])
        }
    }

    func testStackTraversalMatchesTSReverseChildOrder() {
        XCTAssertEqual(
            scan(
                #"[{"type":"request","url":"http://localhost/?token=x"},{"type":"request","url":"http://127.0.0.1/?sig=x"}]"#
            )
            .map(\.path),
            ["$.1.url.query.sig", "$.1.url", "$.0.url.query.token", "$.0.url"]
        )
    }
}
