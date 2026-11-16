@testable import CtrlProxy
import Foundation
import XCTest

@MainActor
private final class FakeStoreKitTestSession: StoreKitTestSessioning {
    var disableDialogs = false
    var resetCount = 0
    var clearCount = 0
    var refunded: [Int] = []
    var expired: [String] = []
    var rates: [StoreKitTimeRate] = []
    var errors: [Int] = []
    var transactions: [StoreKitTransaction] = []
    var failure: String?
    var beforeBuy: (() async -> Void)?

    func resetToDefaultState() {
        resetCount += 1
        disableDialogs = false
    }

    func clearTransactions() {
        clearCount += 1
        transactions = []
    }

    func buy(productId: String) async throws {
        await beforeBuy?()
        if let failure { throw VerbatimLocalizedError(message: failure) }
        transactions.append(StoreKitTransaction(
            identifier: 42,
            productId: productId,
            state: "purchased",
            originalIdentifier: 41
        ))
    }

    func refund(transactionId: Int) { refunded.append(transactionId) }
    func expire(subscriptionId: String) { expired.append(subscriptionId) }
    func setTimeRate(_ rate: StoreKitTimeRate) { rates.append(rate) }
    func setSimulatedError(_ code: Int) async { errors.append(code) }
    func allTransactions() -> [StoreKitTransaction] { transactions }
}

@MainActor
final class StoreKitCommandTests: XCTestCase {
    private func handler(_ store: any StoreKitSessionProviding) -> CommandHandler {
        CommandHandler(
            elementLocator: FakeElementLocator(),
            gesturePerformer: FakeGesturePerformer(),
            perf: PerfProvider(),
            storeKitSessions: store
        )
    }

    private func request(
        _ action: String,
        bundle: String = "com.example.app",
        fields: [String: Any] = [:]
    )
        throws -> WebSocketRequest
    {
        var wire: [String: Any] = [
            "type": "request_storekit",
            "requestId": "sk-1",
            "action": action,
            "bundleId": bundle,
        ]
        wire.merge(fields) { _, new in new }
        return try JSONDecoder().decode(WebSocketRequest.self, from: JSONSerialization.data(withJSONObject: wire))
    }

    private func run(
        _ handler: CommandHandler,
        _ action: String,
        bundle: String = "com.example.app",
        fields: [String: Any] = [:]
    )
        async throws -> StoreKitResultResponse
    {
        let response = try await handler.handle(request(action, bundle: bundle, fields: fields))
        return try XCTUnwrap(response as? StoreKitResultResponse)
    }

    private func load(_ handler: CommandHandler, bundle: String = "com.example.app") async throws {
        let response = try await run(handler, "load", bundle: bundle, fields: ["configPath": "/tmp/test.storekit"])
        XCTAssertTrue(response.success, response.error ?? "")
        XCTAssertNil(response.transactions)
    }

    func testDecodeEveryActionAndAllWireFields() throws {
        for action in [
            "load",
            "buy",
            "refund",
            "expire",
            "setTimeRate",
            "setSimulatedError",
            "disableDialogs",
            "clear",
            "list",
        ] {
            let decoded = try request(action, fields: [
                "configPath": "/tmp/test.storekit",
                "productId": "premium",
                "transactionId": 42,
                "subscriptionId": "monthly",
                "timeRate": "realTime",
                "simulatedError": 2,
                "enabled": false,
            ])
            guard case let .storeKit(payload) = decoded else { return XCTFail("wrong request case") }
            XCTAssertEqual(decoded.requestType, .requestStoreKit)
            XCTAssertEqual(RequestType.requestStoreKit.responseType, .storeKitResult)
            XCTAssertEqual(decoded.payload.requestId, "sk-1")
            XCTAssertEqual(payload.action, action)
            XCTAssertEqual(payload.bundleId, "com.example.app")
            XCTAssertEqual(payload.configPath, "/tmp/test.storekit")
            XCTAssertEqual(payload.productId, "premium")
            XCTAssertEqual(payload.transactionId, 42)
            XCTAssertEqual(payload.subscriptionId, "monthly")
            XCTAssertEqual(payload.timeRate, "realTime")
            XCTAssertEqual(payload.simulatedError, 2)
            XCTAssertEqual(payload.enabled, false)
        }
    }

    func testRequiredEnvelopeFieldsAndIntegerTransactionId() throws {
        for json in [
            #"{"type":"request_storekit","action":"list"}"#,
            #"{"type":"request_storekit","bundleId":"app"}"#,
            #"{"type":"request_storekit","action":"refund","bundleId":"app","transactionId":1.5}"#,
        ] {
            XCTAssertThrowsError(try JSONDecoder().decode(WebSocketRequest.self, from: Data(json.utf8)))
        }
        let minimal = #"{"type":"request_storekit","action":"list","bundleId":"app"}"#
        XCTAssertNil(try JSONDecoder().decode(WebSocketRequest.self, from: Data(minimal.utf8)).payload.requestId)
    }

    func testLoadBuyListAndHandlerReplacementRetainSession() async throws {
        let session = FakeStoreKitTestSession()
        let store = StoreKitSessionStore(supported: true) { path in
            XCTAssertEqual(path, "/tmp/test.storekit")
            return session
        }
        let first = handler(store)
        try await load(first)
        XCTAssertEqual(session.resetCount, 1)
        XCTAssertEqual(session.clearCount, 1)
        XCTAssertTrue(session.disableDialogs)
        let buy = try await run(first, "buy", fields: ["productId": "premium"])
        XCTAssertTrue(buy.success)
        XCTAssertEqual(buy.transactions, [StoreKitTransaction(
            identifier: 42,
            productId: "premium",
            state: "purchased",
            originalIdentifier: 41
        )])
        let list = try await run(handler(store), "list")
        XCTAssertEqual(list.transactions, buy.transactions)
    }

    func testRefundAndExpireReturnCurrentTransactions() async throws {
        let session = FakeStoreKitTestSession()
        let handler = handler(StoreKitSessionStore(supported: true) { _ in session })
        try await load(handler)
        let buy = try await run(handler, "buy", fields: ["productId": "monthly"])
        let refund = try await run(handler, "refund", fields: ["transactionId": 42])
        let expire = try await run(handler, "expire", fields: ["subscriptionId": "monthly"])
        XCTAssertTrue(refund.success)
        XCTAssertTrue(expire.success)
        XCTAssertEqual(session.refunded, [42])
        XCTAssertEqual(session.expired, ["monthly"])
        XCTAssertEqual(refund.transactions, buy.transactions)
        XCTAssertEqual(expire.transactions, buy.transactions)
    }

    func testClearResetsAndDropsOnlyTheRequestedBundle() async throws {
        let firstBundle = FakeStoreKitTestSession()
        let secondBundle = FakeStoreKitTestSession()
        let handler = handler(StoreKitSessionStore(supported: true) { path in
            path == "/tmp/a.storekit" ? firstBundle : secondBundle
        })
        for bundle in ["a", "b"] {
            let response = try await run(
                handler,
                "load",
                bundle: bundle,
                fields: ["configPath": "/tmp/\(bundle).storekit"]
            )
            XCTAssertTrue(response.success)
        }
        _ = try await run(handler, "buy", bundle: "a", fields: ["productId": "only-a"])
        XCTAssertEqual(firstBundle.transactions.count, 1)
        XCTAssertTrue(secondBundle.transactions.isEmpty)
        _ = try await run(handler, "buy", bundle: "b", fields: ["productId": "only-b"])
        let clear = try await run(handler, "clear", bundle: "a")
        XCTAssertTrue(clear.success)
        XCTAssertEqual(clear.transactions, [])
        XCTAssertEqual(firstBundle.resetCount, 2)
        XCTAssertEqual(firstBundle.clearCount, 2)
        let missing = try await run(handler, "list", bundle: "a")
        XCTAssertFalse(missing.success)
        let remaining = try await run(handler, "list", bundle: "b")
        XCTAssertEqual(remaining.transactions?.map(\.productId), ["only-b"])
    }

    func testEveryOperationWithoutLoadFails() async throws {
        let handler = handler(StoreKitSessionStore(supported: true) { _ in FakeStoreKitTestSession() })
        for action in [
            "buy",
            "list",
            "refund",
            "expire",
            "clear",
            "setTimeRate",
            "setSimulatedError",
            "disableDialogs",
        ] {
            let result = try await run(handler, action)
            XCTAssertFalse(result.success)
            XCTAssertEqual(result.error, "no storekit session for bundleId; call load first")
            XCTAssertEqual(result.action, action)
            XCTAssertEqual(result.bundleId, "com.example.app")
        }
    }

    func testSettingsAndUnknownValues() async throws {
        let session = FakeStoreKitTestSession()
        let handler = handler(StoreKitSessionStore(supported: true) { _ in session })
        try await load(handler)
        for rate in StoreKitTimeRate.allCases {
            let result = try await run(handler, "setTimeRate", fields: ["timeRate": rate.rawValue])
            XCTAssertTrue(result.success)
            XCTAssertNil(result.transactions)
        }
        XCTAssertEqual(session.rates, StoreKitTimeRate.allCases)
        for code in [0, 2, 5] {
            let result = try await run(handler, "setSimulatedError", fields: ["simulatedError": code])
            XCTAssertTrue(result.success)
        }
        XCTAssertEqual(session.errors, [0, 2, 5])
        for enabled in [false, true] {
            let result = try await run(handler, "disableDialogs", fields: ["enabled": enabled])
            XCTAssertTrue(result.success)
            XCTAssertEqual(session.disableDialogs, enabled)
        }
        for (action, fields) in [
            ("setTimeRate", ["timeRate": "oneHourEveryThirtySeconds"] as [String: Any]),
            ("setSimulatedError", ["simulatedError": 99]),
            ("refund", ["transactionId": -1]),
            ("unknown", [:]),
        ] {
            let result = try await run(handler, action, fields: fields)
            XCTAssertFalse(result.success)
            XCTAssertNotNil(result.error)
        }
        XCTAssertEqual(session.rates.count, StoreKitTimeRate.allCases.count)
        XCTAssertEqual(session.refunded, [])
    }

    func testMissingParametersInvalidPathsAndSessionErrors() async throws {
        let session = FakeStoreKitTestSession()
        let handler = handler(StoreKitSessionStore(supported: true) { _ in session })
        for path in ["relative.storekit", "/tmp/wrong.json", ""] {
            let result = try await run(handler, "load", fields: ["configPath": path])
            XCTAssertFalse(result.success)
        }
        try await load(handler)
        for action in ["load", "buy", "refund", "expire", "setTimeRate", "setSimulatedError", "disableDialogs"] {
            let result = try await run(handler, action)
            XCTAssertFalse(result.success)
            XCTAssertTrue(result.error?.hasPrefix("Missing required parameter:") == true)
        }
        session.failure = "purchase failed"
        let result = try await run(handler, "buy", fields: ["productId": "premium"])
        XCTAssertFalse(result.success)
        XCTAssertEqual(result.error, "purchase failed")
        let emptyBundle = try await run(handler, "list", bundle: "")
        XCTAssertFalse(emptyBundle.success)
    }

    func testLoadFactoryFailureIsContained() async throws {
        let handler = handler(StoreKitSessionStore(supported: true) { _ in
            throw VerbatimLocalizedError(message: "file unreadable")
        })
        let result = try await run(handler, "load", fields: ["configPath": "/tmp/missing.storekit"])
        XCTAssertFalse(result.success)
        XCTAssertEqual(result.error, "file unreadable")
        let list = try await run(handler, "list")
        XCTAssertFalse(list.success)
    }

    func testUnsupportedResult() async throws {
        let handler = handler(StoreKitSessionStore(supported: false) { _ in
            XCTFail("unsupported platform must not construct a session")
            return FakeStoreKitTestSession()
        })
        let result = try await run(handler, "load", fields: ["configPath": "/tmp/test.storekit"])
        XCTAssertFalse(result.success)
        XCTAssertTrue(result.error?.hasPrefix("unsupported:") == true)
        #if !os(iOS)
            XCTAssertFalse(DefaultStoreKitTestSession.isSupported)
        #endif
    }

    func testReentrantCommandCannotClearAnActiveBuy() async throws {
        let session = FakeStoreKitTestSession()
        let store = StoreKitSessionStore(supported: true) { _ in session }
        let handler = handler(store)
        try await load(handler)
        session.beforeBuy = {
            let result = await handler.handle(.storeKit(RequestStoreKit(action: "clear", bundleId: "com.example.app")))
            let response = result as? StoreKitResultResponse
            XCTAssertFalse(response?.success ?? true)
            XCTAssertEqual(response?.error, "storekit operation in progress for bundleId; retry after it completes")
        }
        let buy = try await run(handler, "buy", fields: ["productId": "premium"])
        session.beforeBuy = nil
        XCTAssertTrue(buy.success)
        XCTAssertEqual(session.clearCount, 1)
        let clear = try await run(handler, "clear")
        XCTAssertTrue(clear.success)
    }

    func testReloadReplacesSessionAndResetsDefaults() async throws {
        let first = FakeStoreKitTestSession()
        let second = FakeStoreKitTestSession()
        let handler = handler(StoreKitSessionStore(supported: true) { path in
            path == "/tmp/test.storekit" ? first : second
        })
        try await load(handler)
        _ = try await run(handler, "buy", fields: ["productId": "old"])
        let reload = try await run(handler, "load", fields: ["configPath": "/tmp/new.storekit"])
        XCTAssertTrue(reload.success)
        XCTAssertTrue(second.disableDialogs)
        XCTAssertEqual(second.resetCount, 1)
        XCTAssertEqual(second.clearCount, 1)
        let list = try await run(handler, "list")
        XCTAssertEqual(list.transactions, [])
    }

    func testResponseWireGolden() throws {
        guard case let .storeKit(payload) = try request("list") else { return XCTFail("wrong request case") }
        let transaction = StoreKitTransaction(
            identifier: 42,
            productId: "premium",
            state: "purchased",
            originalIdentifier: 41
        )
        let response = StoreKitResultResponse(
            request: payload,
            success: true,
            transactions: [transaction],
            totalTimeMs: 3
        )
        let actual = try JSONSerialization.jsonObject(with: JSONEncoder().encode(response)) as? NSDictionary
        let expected =
            #"{"type":"storekit_result","requestId":"sk-1","success":true,"action":"list","bundleId":"com.example.app","transactions":[{"identifier":42,"productId":"premium","state":"purchased","originalIdentifier":41}],"totalTimeMs":3}"#
        XCTAssertEqual(actual, try JSONSerialization.jsonObject(with: Data(expected.utf8)) as? NSDictionary)
        let failure = StoreKitResultResponse(request: payload, success: false, error: "failure", totalTimeMs: 0)
        let failed = try JSONSerialization.jsonObject(with: JSONEncoder().encode(failure)) as? NSDictionary
        let expectedFailure =
            #"{"type":"storekit_result","requestId":"sk-1","success":false,"action":"list","bundleId":"com.example.app","error":"failure","totalTimeMs":0}"#
        XCTAssertEqual(failed, try JSONSerialization.jsonObject(with: Data(expectedFailure.utf8)) as? NSDictionary)
    }
}
