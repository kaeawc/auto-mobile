@testable import AutoMobilePrototypeAgentCore
import XCTest
#if canImport(FoundationNetworking)
    import FoundationNetworking
#endif

struct FakeConnectionMetrics: PrototypeConnectionMetricsProviding {
    let values: [PrototypeConnectionMetric]
    static var allowed: FakeConnectionMetrics {
        FakeConnectionMetrics(values: [.init(remoteAddress: "8.8.8.8", url: URL(string: "https://public.example/"))])
    }

    func transactions(for _: URLSessionTaskMetrics?) -> [PrototypeConnectionMetric] { values }
}

final class PrototypeConnectionMetricsTests: XCTestCase {
    func testSessionDisablesProxies() {
        let configuration = PrototypeURLSessionClient.configuration()
        XCTAssertNotNil(configuration.connectionProxyDictionary)
        XCTAssertEqual(configuration.connectionProxyDictionary?.count, 0)
    }

    func testDefaultProviderDoesNotSupplyMissingMetrics() {
        XCTAssertTrue(PrototypeConnectionMetrics().transactions(for: nil).isEmpty)
    }

    func testMetricsRejectProxyMissingAddressAndBlockedAddressAndDiscardBody() async throws {
        let url = try XCTUnwrap(URL(string: "https://public.example/"))
        let allowed = PrototypeConnectionMetric(remoteAddress: "8.8.8.8", url: url)
        let cases: [(String, [PrototypeConnectionMetric], Bool)] = [
            ("allowed", [allowed], true),
            ("missing metrics", [], false),
            ("missing address", [.init(remoteAddress: nil, url: url)], false),
            ("missing URL", [.init(remoteAddress: "8.8.8.8", url: nil)], false),
            ("blocked address", [.init(remoteAddress: "127.0.0.1", url: url)], false),
            ("proxy", [.init(isProxyConnection: true, remoteAddress: "8.8.8.8", url: url)], false),
            ("proxy non-network", [allowed, .init(isNetworkLoad: false, isProxyConnection: true)], false),
            ("non-network only", [.init(isNetworkLoad: false)], false),
            ("non-network then allowed", [.init(isNetworkLoad: false), allowed], true),
            ("allowed then missing", [allowed, .init(remoteAddress: nil, url: url)], false),
            ("missing then allowed", [.init(remoteAddress: nil, url: url), allowed], false),
        ]
        let egress = PrototypeRequestEgressCheck(policy: PrototypeEgressPolicy(), resolver: FakeHostResolver())
        for (label, transactions, passes) in cases {
            let call = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 1000, request: URLRequest(url: url))
            XCTAssertTrue(call.accept(status: 200, headers: [:], expectedLength: 3))
            XCTAssertTrue(call.append(Data("abc".utf8)))
            do {
                let response: PrototypeHttpResponse = try await withCheckedThrowingContinuation { continuation in
                    call.install(continuation)
                    XCTAssertEqual(call.inspectMetrics(transactions, egress: egress), passes, label)
                    if !passes { XCTAssertFalse(call.append(Data("late".utf8)), label) }
                    call.finish(error: nil, measuredMs: 1)
                }
                XCTAssertTrue(passes, label)
                XCTAssertEqual(response.body, Data("abc".utf8), label)
            } catch {
                XCTAssertFalse(passes, label)
                XCTAssertEqual((error as? PrototypeHttpFailure)?.error.code, .blockedDestination, label)
            }
        }
    }

    func testStubResponsesRequireExplicitMetricsAndRejectProxyAndMissingAddress() async throws {
        let url = try XCTUnwrap(URL(string: "https://public.example/"))
        StubProtocol.reset { _ in .respond(status: 200, headers: [:], chunks: [Data("ok".utf8)]) }
        let request = PrototypeHttpRequest(job: PrototypeRequestJob(
            requestId: "r", prototypeId: "p", via: .device, method: .get, url: url.absoluteString,
            headers: [:], body: nil, timeoutMs: 1000
        ))
        let providers: [any PrototypeConnectionMetricsProviding] = [
            PrototypeConnectionMetrics(),
            FakeConnectionMetrics(values: [.init(remoteAddress: nil, url: url)]),
            FakeConnectionMetrics(values: [.init(isProxyConnection: true, remoteAddress: "8.8.8.8", url: url)]),
        ]
        for provider in providers {
            let client = PrototypeURLSessionClient(
                protocolClasses: [StubProtocol.self], resolver: FakeHostResolver(), metrics: provider
            )
            do {
                _ = try await client.perform(request)
                XCTFail("Delivered a response without acceptable network metrics")
            } catch {
                XCTAssertEqual((error as? PrototypeHttpFailure)?.error.code, .blockedDestination)
            }
        }
    }
}
