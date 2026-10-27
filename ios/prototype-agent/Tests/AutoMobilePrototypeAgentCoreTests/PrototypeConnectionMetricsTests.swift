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

    /// #14557: a policy rejection that lands after the caller's cancel does not replace the
    /// promised `cancelled` outcome.
    func testCallerCancelOutranksALatePolicyRejection() async throws {
        let (call, handle, session) = try Self.unstartedCall()
        defer { session.invalidateAndCancel() }
        call.cancelByCaller(handle)
        let code = await Self.codeAfterLateRejection(call)
        XCTAssertEqual(code, .cancelled)
    }

    /// #14557: a policy rejection that lands after the total deadline does not replace the
    /// promised `timeout` outcome.
    func testDeadlineOutranksALatePolicyRejection() async throws {
        let (call, handle, session) = try Self.unstartedCall()
        defer { session.invalidateAndCancel() }
        call.armDeadline(cancelling: handle)
        // The deadline marks the call timed out before it cancels the task.
        for _ in 0 ..< 1000 where handle.task.state == .suspended {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        XCTAssertNotEqual(handle.task.state, .suspended)
        let code = await Self.codeAfterLateRejection(call)
        XCTAssertEqual(code, .timeout)
    }

    private static func unstartedCall() throws -> (PrototypeURLSessionCall, PrototypeURLSessionTaskHandle, URLSession) {
        let url = try XCTUnwrap(URL(string: "https://public.example/"))
        let session = URLSession(configuration: .ephemeral)
        let call = PrototypeURLSessionCall(maxBytes: 100, timeoutMs: 1, request: URLRequest(url: url))
        return (call, PrototypeURLSessionTaskHandle(session.dataTask(with: url)), session)
    }

    private static func codeAfterLateRejection(_ call: PrototypeURLSessionCall) async -> PrototypeRequestErrorCode? {
        do {
            let _: PrototypeHttpResponse = try await withCheckedThrowingContinuation { continuation in
                call.install(continuation)
                call.reject()
                call.finish(error: URLError(.cancelled), measuredMs: 1)
            }
            return nil
        } catch {
            return (error as? PrototypeHttpFailure)?.error.code
        }
    }
}
