@testable import AutoMobilePrototypeAgentCore
import Foundation
import XCTest

final class PrototypeWebViewPolicyTests: XCTestCase {
    private let origins = ["https://example.com", "https://example.com:8443"]

    func testUsesDefaultHandlingForServerTrustChallenges() {
        XCTAssertEqual(
            PrototypeWebView.challengeDisposition(authenticationMethod: NSURLAuthenticationMethodServerTrust),
            .performDefaultHandling
        )
    }

    func testCancelsOtherAuthenticationChallenges() {
        for method in [
            NSURLAuthenticationMethodHTTPBasic, NSURLAuthenticationMethodHTTPDigest, NSURLAuthenticationMethodNTLM,
            NSURLAuthenticationMethodClientCertificate, NSURLAuthenticationMethodNegotiate,
        ] {
            XCTAssertEqual(
                PrototypeWebView.challengeDisposition(authenticationMethod: method),
                .cancelAuthenticationChallenge,
                method
            )
        }
    }

    func testAcceptsExactOriginsWithNormalizedHostAndPort() {
        for url in ["https://example.com", "https://EXAMPLE.com:443/x", "https://example.com:8443"] {
            XCTAssertEqual(PrototypeWebViewPolicy.check(url, allowedOrigins: origins), .allow, url)
        }
    }

    func testRefusesEveryOtherOrigin() {
        for url in [
            "https://other.com", "https://example.com.evil.com", "https://evilexample.com",
            "https://sub.example.com", "https://example.com:444", "https://example.com:3000",
            "https://example.com:8765", "http://example.com", "javascript:void(0)", "file:///tmp/page",
            "content://example.com/page", "data:text/plain,test", "intent://example.com", "about:blank",
            "blob:https://example.com/id", "https://user@example.com", "https:///page",
            "https://example.com:", "https://example.com:0443", "https://%65xample.com",
        ] {
            XCTAssertNotEqual(PrototypeWebViewPolicy.check(url, allowedOrigins: origins), .allow, url)
        }
    }

    func testRefusesPrivateHostsAndDaemonPortsEvenWhenListed() {
        for host in [
            "localhost", "foo.localhost", "localhost.", "127.0.0.1", "10.0.2.2", "169.254.169.254",
            "[::1]", "0x7f.1", "2130706433", "example.com:3000", "example.com:8765",
        ] {
            let url = "https://\(host)"
            XCTAssertNotEqual(PrototypeWebViewPolicy.check(url, allowedOrigins: [url]), .allow, url)
        }
        let custom = "https://example.com:9999"
        XCTAssertNotEqual(PrototypeWebViewPolicy.check(custom, allowedOrigins: [custom], daemonPorts: [9999]), .allow)
    }

    func testContentRulesBlockByDefaultAndExemptOnlyPermittedAuthorities() throws {
        let json = try PrototypeWebViewPolicy.contentRules(
            allowedOrigins: origins + ["https://localhost", "https://example.com:3000", "https://example.com/unsafe"]
        )
        let rules = try JSONDecoder().decode([JSONValue].self, from: Data(json.utf8))
        let actions = rules.compactMap { $0.objectFields?["action"]?.objectFields?["type"]?.stringValue }
        let filters = rules.compactMap { $0.objectFields?["trigger"]?.objectFields?["url-filter"]?.stringValue }
        XCTAssertEqual(actions.first, "block")
        XCTAssertEqual(filters.first, ".*")
        XCTAssertEqual(Array(actions.dropFirst()), Array(repeating: "ignore-previous-rules", count: 6))
        let exceptions = try filters.dropFirst().map { try NSRegularExpression(pattern: $0, options: .caseInsensitive) }
        for url in [
            "https://example.com", "https://EXAMPLE.com:443/path", "https://example.com:8443?q",
            "https://example.com/#f",
        ] {
            XCTAssertTrue(matches(url, exceptions), url)
        }
        for url in [
            "https://example.com.evil.com", "https://sub.example.com", "https://example.com:444",
            "https://example.com:3000", "https://example.com@evil.com", "https://user@example.com",
            "https://localhost", "http://example.com", "data:text/plain,https://example.com",
        ] {
            XCTAssertFalse(matches(url, exceptions), url)
        }
    }

    private func matches(_ url: String, _ filters: [NSRegularExpression]) -> Bool {
        filters.contains { $0.firstMatch(in: url, range: NSRange(url.startIndex..., in: url)) != nil }
    }
}
