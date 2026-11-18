@testable import AutoMobilePrototypeAgentCore
import XCTest

final class PrototypeRemoteImageEgressTests: XCTestCase {
    private func check(development: Bool = false, addresses: [String] = ["8.8.8.8"]) -> PrototypeRequestEgressCheck {
        PrototypeRequestEgressCheck(
            policy: PrototypeEgressPolicy(), resolver: FakeHostResolver(addresses), remoteImageDevelopment: development
        )
    }

    func testStaticAndDNSPrivateHostsRefused() async throws {
        for host in ["10.0.0.1", "169.254.169.254", "192.168.1.1", "172.16.1.1", "[fd00::1]", "127.0.0.1"] {
            do {
                try await check().validate(URLRequest(url: XCTUnwrap(URL(string: "https://\(host)/"))))
                XCTFail("Private host accepted")
            } catch {}
        }
        for addresses in [["10.0.0.1"], ["8.8.8.8", "192.168.1.1"], ["fd00::1"]] {
            do {
                try await check(addresses: addresses)
                    .validate(URLRequest(url: XCTUnwrap(URL(string: "https://public.example/"))))
                XCTFail("Private DNS answer accepted")
            } catch {}
        }
    }

    func testLoopbackExceptionIsDevelopmentAndImageOnly() async throws {
        for host in ["localhost", "127.0.0.1", "[::1]"] {
            let request = try URLRequest(url: XCTUnwrap(URL(string: "http://\(host):8080/image")))
            try await check(development: true, addresses: ["127.0.0.1", "::1"]).validate(request)
            do {
                try await check().validate(request)
                XCTFail("Production loopback accepted")
            } catch {}
            let requests = PrototypeRequestEgressCheck(policy: PrototypeEgressPolicy(), resolver: FakeHostResolver())
            do {
                try await requests.validate(request)
                XCTFail("Request policy was loosened")
            } catch {}
        }
        XCTAssertThrowsError(try check(development: true).validateImageURL("http://public.example/image"))
    }

    func testResolvedWholeFieldBindingRevalidated() async throws {
        let bound = interpolatePrototypeText("{photo}", state: ["photo": .string("https://10.0.0.1/image")], pager: nil)
        XCTAssertEqual(bound, "https://10.0.0.1/image")
        let loader = PrototypeRemoteImageLoader(
            memory: PrototypeRemoteImageMemory(),
            resolver: FakeHostResolver(),
            directory: nil
        )
        do {
            _ = try await loader.load(bound)
            XCTFail("Bound private destination accepted")
        } catch {}
        for url in [
            "https://user:pass@public.example/image",
            "https://public.example/a b",
            "{photo}",
            "ftp://public.example/a",
        ] {
            XCTAssertThrowsError(try check().validateImageURL(url))
        }
    }

    func testRedirectPolicyAndFiveHopCap() async throws {
        let egress = check()
        let request = try URLRequest(url: XCTUnwrap(URL(string: "https://public.example/image")))
        for target in [
            "https://10.0.0.1/image",
            "http://public.example/image",
            "https://user:pass@public.example/image",
        ] {
            let call = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 30000, request: request)
            do {
                _ = try await call.redirect(to: XCTUnwrap(URL(string: target)), status: 302, egress: egress)
                XCTFail("Unsafe redirect accepted")
            } catch {}
        }
        let call = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 30000, request: request)
        for _ in 0 ..< 5 {
            _ = try await call.redirect(to: XCTUnwrap(request.url), status: 302, egress: egress)
        }
        do {
            _ = try await call.redirect(to: XCTUnwrap(request.url), status: 302, egress: egress)
            XCTFail("Redirect loop exceeded cap")
        } catch {}
    }

    func testRedirectStripsHeadersAndAllowsOnlyDevelopmentLoopbackDowngrade() async throws {
        var request = try URLRequest(url: XCTUnwrap(URL(string: "https://public.example/image")))
        for name in ["Authorization", "Cookie", "Referer"] { request.setValue("secret", forHTTPHeaderField: name) }
        let call = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 30000, request: request)
        let next = try await call.redirect(
            to: XCTUnwrap(URL(string: "http://localhost:8080/image")), status: 302,
            egress: check(development: true, addresses: ["127.0.0.1"])
        )
        for name in ["Authorization", "Cookie", "Referer"] {
            XCTAssertNil(next.value(forHTTPHeaderField: name))
        }
        let requests = PrototypeRequestEgressCheck(policy: PrototypeEgressPolicy(), resolver: FakeHostResolver())
        let ordinary = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 30000, request: request)
        do {
            _ = try await ordinary.redirect(to: XCTUnwrap(next.url), status: 302, egress: requests)
            XCTFail("Request downgrade policy was loosened")
        } catch {}
    }

    func testConnectedAddressCannotBypassPreflight() throws {
        let url = try XCTUnwrap(URL(string: "https://public.example/image"))
        XCTAssertFalse(check().checkConnected(address: "10.0.0.1", url: url))
        XCTAssertFalse(check().checkConnected(address: "169.254.169.254", url: url))
        XCTAssertTrue(check().checkConnected(address: "8.8.8.8", url: url))
        let loopback = try XCTUnwrap(URL(string: "http://localhost:8080/image"))
        XCTAssertTrue(check(development: true).checkConnected(address: "::1", url: loopback))
        XCTAssertFalse(check(development: true).checkConnected(address: "192.168.1.1", url: loopback))
    }
}
