import Foundation

// MARK: - FakeElementLocator

/// Fake implementation of ElementLocating for testing
public class FakeElementLocator: ElementLocating {
    // MARK: - Configurable State

    private var hierarchyData: ViewHierarchy?
    private var elements: [String: Any] = [:]
    private var shouldThrow: Error?
    public var onHierarchyRead: (() -> Void)?

    // MARK: - Call History

    private var getHierarchyCallCount = 0
    private var findByIdHistory: [String] = []
    private var findByTextHistory: [String] = []
    public private(set) var trackedBundleIds: [String] = []

    /// Tracks the last value of disableAllFiltering passed to getViewHierarchy
    public private(set) var lastDisableAllFiltering: Bool?

    public init() {}

    // MARK: - Configuration

    /// Set the hierarchy to return
    public func setHierarchy(_ hierarchy: ViewHierarchy?) {
        hierarchyData = hierarchy
    }

    /// Set an element to be found by ID
    public func setElement(id: String, element: Any) {
        elements[id] = element
    }

    /// Configure to throw an error
    public func setShouldThrow(_ error: Error?) {
        shouldThrow = error
    }

    // MARK: - Assertions

    public var hierarchyRequestCount: Int {
        getHierarchyCallCount
    }

    public func getFindByIdHistory() -> [String] {
        findByIdHistory
    }

    public func getFindByTextHistory() -> [String] {
        findByTextHistory
    }

    public func clearHistory() {
        getHierarchyCallCount = 0
        findByIdHistory.removeAll()
        findByTextHistory.removeAll()
        trackedBundleIds.removeAll()
        lastDisableAllFiltering = nil
    }

    // MARK: - ElementLocating

    public func getViewHierarchy(disableAllFiltering: Bool = false) throws -> ViewHierarchy {
        getHierarchyCallCount += 1
        lastDisableAllFiltering = disableAllFiltering

        if let error = shouldThrow {
            throw error
        }

        let hierarchy = hierarchyData ?? ViewHierarchy(
            packageName: "com.test.app",
            hierarchy: UIElementInfo(
                text: "Fake Root",
                className: "UIView",
                bounds: ElementBounds(left: 0, top: 0, right: 375, bottom: 812)
            ),
            windowInfo: WindowInfo(id: 0, type: 1, isActive: true, isFocused: true)
        )
        onHierarchyRead?()
        return hierarchy
    }

    public func findElement(byResourceId resourceId: String) -> Any? {
        findByIdHistory.append(resourceId)
        return elements[resourceId]
    }

    public func findElement(byText text: String) -> Any? {
        findByTextHistory.append(text)
        return elements.values.first
    }

    public func trackObservedBundleId(_ bundleId: String) {
        trackedBundleIds.append(bundleId)
    }

    // MARK: - Explicit State Transitions

    public private(set) var switchedBundleIds: [String] = []
    public private(set) var awaitStateCalls: [(bundleId: String, expectedState: AppStateExpectation)] = []
    public var awaitAppStateResult = true
    public private(set) var getAppStateCalls: [String] = []
    public var getAppStateResult: ObservedAppState = .notRunning

    public func switchForegroundApp(bundleId: String) {
        switchedBundleIds.append(bundleId)
        foregroundBundleId = bundleId
    }

    /// Bundle ID of the currently tracked foreground app.
    /// Updated automatically by `switchForegroundApp`; tests can also set
    /// it directly to simulate an out-of-band transition (e.g. MCP-side
    /// `simctl launch` that bypasses handleLaunchApp).
    public var foregroundBundleId: String?

    public func getAppState(bundleId: String) -> ObservedAppState {
        getAppStateCalls.append(bundleId)
        return getAppStateResult
    }

    public func awaitAppState(bundleId: String, expectedState: AppStateExpectation) -> Bool {
        awaitStateCalls.append((bundleId: bundleId, expectedState: expectedState))
        return awaitAppStateResult
    }
}

// MARK: - FakeGesturePerformer

/// Fake implementation of GesturePerforming for testing
public class FakeGesturePerformer: GesturePerforming {
    // MARK: - Configurable State

    private var screenshotData: Data?
    private var screenshotCapture: ScreenshotCapture?
    public var onScreenshot: (() -> Void)?
    private var currentOrientation = "portrait"
    private var failureMap: [String: Error] = [:]

    // MARK: - Call History

    public struct TapCall {
        public let x: Double
        public let y: Double
        public let duration: TimeInterval
    }

    public struct SwipeCall {
        public let startX: Double
        public let startY: Double
        public let endX: Double
        public let endY: Double
        public let duration: TimeInterval
    }

    public struct MultiFingerSwipeCall {
        public let startX: Double
        public let startY: Double
        public let endX: Double
        public let endY: Double
        public let fingerCount: Int
        public let fingerSpacing: Double
        public let duration: TimeInterval
    }

    public struct DragCall {
        public let startX: Double
        public let startY: Double
        public let endX: Double
        public let endY: Double
        public let pressDuration: TimeInterval
        public let dragDuration: TimeInterval
        public let holdDuration: TimeInterval
    }

    public struct PinchCall {
        public let centerX: Double
        public let centerY: Double
        public let distanceStart: Double
        public let distanceEnd: Double
        public let rotationDegrees: Double
        public let duration: TimeInterval
    }

    public struct TextCall {
        public let text: String
        public let resourceId: String?
    }

    public struct ResetAuthorizationsCall {
        public let bundleId: String
        public let resources: [String]
    }

    private var tapHistory: [TapCall] = []
    private var doubleTapHistory: [(x: Double, y: Double)] = []
    private var longPressHistory: [(x: Double, y: Double, duration: TimeInterval)] = []
    private var swipeHistory: [SwipeCall] = []
    private var multiFingerSwipeHistory: [MultiFingerSwipeCall] = []
    private var dragHistory: [DragCall] = []
    private var pinchHistory: [PinchCall] = []
    private var typeTextHistory: [String] = []
    private var appendTextHistory: [String] = []
    private var focusedFieldText = ""
    private var setTextHistory: [TextCall] = []
    private var clearTextHistory: [String?] = []
    private var selectAllCallCount = 0
    private var imeActionHistory: [String] = []
    private var keyboardHistory: [String] = []
    private var keyboardOpen = false
    private var nextKeyboardResult: Bool?
    private var actionHistory: [(action: String, resourceId: String?, label: String?)] = []
    private var screenshotCallCount = 0
    private var pressHomeCallCount = 0
    private var pressBackCallCount = 0
    private var shakeCallCount = 0
    private var pressButtonHistory: [String] = []
    private var openRecentAppsCallCount = 0
    private var openRecentAppsResult = true
    private var appLaunchHistory: [String] = []
    private var appTerminateHistory: [String] = []
    private var clipboardHistory: [(action: String, text: String?)] = []
    private var clipboardContents: String?
    private var resetAuthorizationsHistory: [ResetAuthorizationsCall] = []

    public init() {}

    // MARK: - Configuration

    public func setScreenshotData(_ data: Data?) {
        screenshotData = data
    }

    public func setScreenshotCapture(_ capture: ScreenshotCapture?) {
        screenshotCapture = capture
    }

    public func setFailure(for operation: String, error: Error?) {
        if let error = error {
            failureMap[operation] = error
        } else {
            failureMap.removeValue(forKey: operation)
        }
    }

    // MARK: - Assertions

    public func getTapHistory() -> [TapCall] {
        tapHistory
    }

    public func getSwipeHistory() -> [SwipeCall] {
        swipeHistory
    }

    public func getMultiFingerSwipeHistory() -> [MultiFingerSwipeCall] {
        multiFingerSwipeHistory
    }

    public func getDragHistory() -> [DragCall] {
        dragHistory
    }

    public func getPinchHistory() -> [PinchCall] {
        pinchHistory
    }

    public func getTypeTextHistory() -> [String] {
        typeTextHistory
    }

    public func getAppendTextHistory() -> [String] {
        appendTextHistory
    }

    public func getFocusedFieldText() -> String {
        focusedFieldText
    }

    public func getSetTextHistory() -> [TextCall] {
        setTextHistory
    }

    public func getClearTextHistory() -> [String?] {
        clearTextHistory
    }

    public func getSelectAllCallCount() -> Int {
        selectAllCallCount
    }

    public func getImeActionHistory() -> [String] {
        imeActionHistory
    }

    public func getKeyboardHistory() -> [String] {
        keyboardHistory
    }

    public func setKeyboardOpen(_ open: Bool) {
        keyboardOpen = open
    }

    public func setNextKeyboardResult(_ open: Bool) {
        nextKeyboardResult = open
    }

    public func setOpenRecentAppsResult(_ result: Bool) {
        openRecentAppsResult = result
    }

    public func getActionHistory() -> [(action: String, resourceId: String?, label: String?)] {
        actionHistory
    }

    public func getScreenshotCallCount() -> Int {
        screenshotCallCount
    }

    public func getPressHomeCallCount() -> Int {
        pressHomeCallCount
    }

    public func getPressBackCallCount() -> Int {
        pressBackCallCount
    }

    public func getShakeCallCount() -> Int {
        shakeCallCount
    }

    public func getPressButtonHistory() -> [String] {
        pressButtonHistory
    }

    public func getOpenRecentAppsCallCount() -> Int {
        openRecentAppsCallCount
    }

    public func getAppLaunchHistory() -> [String] {
        appLaunchHistory
    }

    public func getAppTerminateHistory() -> [String] {
        appTerminateHistory
    }

    public func getClipboardHistory() -> [(action: String, text: String?)] {
        clipboardHistory
    }

    public func setClipboardContents(_ text: String?) {
        clipboardContents = text
    }

    public func getResetAuthorizationsHistory() -> [ResetAuthorizationsCall] {
        resetAuthorizationsHistory
    }

    public func clearHistory() {
        tapHistory.removeAll()
        doubleTapHistory.removeAll()
        longPressHistory.removeAll()
        swipeHistory.removeAll()
        multiFingerSwipeHistory.removeAll()
        dragHistory.removeAll()
        pinchHistory.removeAll()
        typeTextHistory.removeAll()
        appendTextHistory.removeAll()
        focusedFieldText = ""
        setTextHistory.removeAll()
        clearTextHistory.removeAll()
        selectAllCallCount = 0
        imeActionHistory.removeAll()
        keyboardHistory.removeAll()
        keyboardOpen = false
        nextKeyboardResult = nil
        actionHistory.removeAll()
        screenshotCallCount = 0
        pressHomeCallCount = 0
        pressBackCallCount = 0
        shakeCallCount = 0
        pressButtonHistory.removeAll()
        openRecentAppsCallCount = 0
        openRecentAppsResult = true
        appLaunchHistory.removeAll()
        appTerminateHistory.removeAll()
        clipboardHistory.removeAll()
        resetAuthorizationsHistory.removeAll()
    }

    // MARK: - Private Helpers

    private func checkFailure(_ operation: String) throws {
        if let error = failureMap[operation] {
            throw error
        }
    }

    // MARK: - GesturePerforming

    public func tap(x: Double, y: Double, duration: TimeInterval) throws {
        try checkFailure("tap")
        tapHistory.append(TapCall(x: x, y: y, duration: duration))
    }

    public func doubleTap(x: Double, y: Double) throws {
        try checkFailure("doubleTap")
        doubleTapHistory.append((x: x, y: y))
    }

    public func longPress(x: Double, y: Double, duration: TimeInterval) throws {
        try checkFailure("longPress")
        longPressHistory.append((x: x, y: y, duration: duration))
    }

    public func swipe(startX: Double, startY: Double, endX: Double, endY: Double, duration: TimeInterval) throws {
        try checkFailure("swipe")
        swipeHistory.append(SwipeCall(startX: startX, startY: startY, endX: endX, endY: endY, duration: duration))
    }

    public func multiFingerSwipe(
        startX: Double,
        startY: Double,
        endX: Double,
        endY: Double,
        fingerCount: Int,
        fingerSpacing: Double,
        duration: TimeInterval
    )
        throws
    {
        try checkFailure("multiFingerSwipe")
        multiFingerSwipeHistory.append(MultiFingerSwipeCall(
            startX: startX,
            startY: startY,
            endX: endX,
            endY: endY,
            fingerCount: fingerCount,
            fingerSpacing: fingerSpacing,
            duration: duration
        ))
    }

    public func drag(
        startX: Double,
        startY: Double,
        endX: Double,
        endY: Double,
        pressDuration: TimeInterval,
        dragDuration: TimeInterval,
        holdDuration: TimeInterval
    )
        throws
    {
        try checkFailure("drag")
        dragHistory.append(DragCall(
            startX: startX,
            startY: startY,
            endX: endX,
            endY: endY,
            pressDuration: pressDuration,
            dragDuration: dragDuration,
            holdDuration: holdDuration
        ))
    }

    /// Path returned by `pinch`; defaults to the private event-path synthesis.
    /// Set to `.elementAnchored` to simulate the public-API fallback (issue #2910).
    public var pinchPathToReturn: PinchGesturePath = .eventPath

    @discardableResult
    public func pinch(
        centerX: Double,
        centerY: Double,
        distanceStart: Double,
        distanceEnd: Double,
        rotationDegrees: Double,
        duration: TimeInterval
    )
        throws -> PinchGesturePath
    {
        try checkFailure("pinch")
        pinchHistory.append(PinchCall(
            centerX: centerX,
            centerY: centerY,
            distanceStart: distanceStart,
            distanceEnd: distanceEnd,
            rotationDegrees: rotationDegrees,
            duration: duration
        ))
        return pinchPathToReturn
    }

    public func typeText(text: String) throws {
        try checkFailure("typeText")
        typeTextHistory.append(text)
    }

    public func appendText(text: String) throws {
        try checkFailure("appendText")
        appendTextHistory.append(text)
        focusedFieldText += text
    }

    public func setText(resourceId: String, text: String) throws {
        try checkFailure("setText")
        setTextHistory.append(TextCall(text: text, resourceId: resourceId))
    }

    public func clearText(resourceId: String?) throws {
        try checkFailure("clearText")
        clearTextHistory.append(resourceId)
    }

    public func selectAll() throws {
        try checkFailure("selectAll")
        selectAllCallCount += 1
    }

    public func performImeAction(_ action: String) throws {
        try checkFailure("imeAction")
        imeActionHistory.append(action)
    }

    public func keyboard(action: String) throws -> Bool {
        try checkFailure("keyboard")
        keyboardHistory.append(action)
        if let result = nextKeyboardResult {
            nextKeyboardResult = nil
            keyboardOpen = result
            return result
        }
        switch action {
        case "open":
            keyboardOpen = true
        case "close":
            keyboardOpen = false
        default:
            break
        }
        return keyboardOpen
    }

    public func clipboard(action: String, text: String?) throws -> String? {
        try checkFailure("clipboard")
        clipboardHistory.append((action: action, text: text))
        switch action {
        case "get":
            return clipboardContents
        case "copy":
            clipboardContents = text
            return nil
        case "clear":
            clipboardContents = nil
            return nil
        case "paste":
            return nil
        default:
            return nil
        }
    }

    public func performAction(_ action: String, resourceId: String?, label: String?) throws {
        try checkFailure("action")
        actionHistory.append((action: action, resourceId: resourceId, label: label))
    }

    public func getScreenshot() throws -> Data {
        try checkFailure("screenshot")
        screenshotCallCount += 1
        onScreenshot?()
        return screenshotData ?? Data()
    }

    public func getScreenshotCapture() throws -> ScreenshotCapture {
        try checkFailure("screenshot")
        screenshotCallCount += 1
        onScreenshot?()
        return screenshotCapture ?? ScreenshotCapture(
            data: screenshotData ?? Data(),
            rotation: DeviceRotation.fromOrientationName(currentOrientation)
        )
    }

    public func setOrientation(_ orientation: String) throws {
        try checkFailure("setOrientation")
        currentOrientation = orientation
    }

    public func getOrientation() -> String {
        return currentOrientation
    }

    public func pressHome() throws {
        try checkFailure("pressHome")
        pressHomeCallCount += 1
    }

    public func pressBack() throws {
        try checkFailure("pressBack")
        pressBackCallCount += 1
    }

    public func shake() throws {
        try checkFailure("shake")
        shakeCallCount += 1
    }

    public func pressButton(_ button: String) throws {
        try checkFailure("pressButton")
        pressButtonHistory.append(button)
    }

    public func openRecentApps() throws -> Bool {
        try checkFailure("openRecentApps")
        openRecentAppsCallCount += 1
        return openRecentAppsResult
    }

    public func launchApp(bundleId: String) throws {
        try checkFailure("launchApp")
        appLaunchHistory.append(bundleId)
    }

    public func terminateApp(bundleId: String) throws {
        try checkFailure("terminateApp")
        appTerminateHistory.append(bundleId)
    }

    public private(set) var activateAppHistory: [String] = []

    public func activateApp(bundleId: String) throws {
        try checkFailure("activateApp")
        activateAppHistory.append(bundleId)
    }

    public private(set) var updateApplicationHistory: [String] = []

    public func updateApplication(bundleId: String) {
        updateApplicationHistory.append(bundleId)
    }

    public func resetAuthorizations(bundleId: String, resources: [String]) throws {
        try checkFailure("resetAuthorizations")
        resetAuthorizationsHistory.append(ResetAuthorizationsCall(bundleId: bundleId, resources: resources))
    }
}

// MARK: - FakeStorageInspecting

/// Fake implementation of StorageInspecting for testing
public class FakeStorageInspecting: StorageInspecting {
    // MARK: - Configurable State

    private var suites: [StorageSuiteInfo] = []
    private var entries: [String?: [StorageEntry]] = [:] // keyed by suiteName
    private var shouldThrow: Error?

    // MARK: - Call History

    public struct SetEntryCall {
        public let suiteName: String?
        public let key: String
        public let value: String?
        public let type: String
    }

    public struct RemoveEntryCall {
        public let suiteName: String?
        public let key: String
    }

    public private(set) var listSuitesCallCount = 0
    public private(set) var getEntriesHistory: [String?] = []
    public private(set) var getEntryHistory: [(suiteName: String?, key: String)] = []
    public private(set) var setEntryHistory: [SetEntryCall] = []
    public private(set) var removeEntryHistory: [RemoveEntryCall] = []
    public private(set) var clearEntriesHistory: [String?] = []

    public init() {}

    // MARK: - Configuration

    public func setSuites(_ suites: [StorageSuiteInfo]) {
        self.suites = suites
    }

    public func setEntries(_ entries: [StorageEntry], forSuite suiteName: String? = nil) {
        self.entries[suiteName] = entries
    }

    public func setShouldThrow(_ error: Error?) {
        shouldThrow = error
    }

    public func clearHistory() {
        listSuitesCallCount = 0
        getEntriesHistory.removeAll()
        getEntryHistory.removeAll()
        setEntryHistory.removeAll()
        removeEntryHistory.removeAll()
        clearEntriesHistory.removeAll()
    }

    // MARK: - StorageInspecting

    public func listSuites() -> [StorageSuiteInfo] {
        listSuitesCallCount += 1
        return suites
    }

    public func getEntries(suiteName: String?) -> [StorageEntry] {
        getEntriesHistory.append(suiteName)
        return entries[suiteName] ?? []
    }

    public func getEntry(suiteName: String?, key: String) -> StorageEntry? {
        getEntryHistory.append((suiteName: suiteName, key: key))
        return entries[suiteName]?.first { $0.key == key }
    }

    public func setEntry(suiteName: String?, key: String, value: String?, type: String) throws {
        if let error = shouldThrow { throw error }
        setEntryHistory.append(SetEntryCall(suiteName: suiteName, key: key, value: value, type: type))
    }

    public func removeEntry(suiteName: String?, key: String) throws {
        if let error = shouldThrow { throw error }
        removeEntryHistory.append(RemoveEntryCall(suiteName: suiteName, key: key))
    }

    public func clearEntries(suiteName: String?) throws {
        if let error = shouldThrow { throw error }
        clearEntriesHistory.append(suiteName)
    }
}

// MARK: - FakeWebSocketServer

/// Fake implementation of WebSocketServing for testing
public class FakeWebSocketServer: WebSocketServing {
    // MARK: - State

    private var running = false
    private var shouldStartFail = false
    private var startError: Error?

    // MARK: - Call History

    private var broadcastHistory: [Data] = []
    private var startCallCount = 0
    private var stopCallCount = 0

    public init() {}

    // MARK: - Configuration

    public func setShouldStartFail(_ shouldFail: Bool, error: Error? = nil) {
        shouldStartFail = shouldFail
        startError = error
    }

    // MARK: - Assertions

    public func getBroadcastHistory() -> [Data] {
        broadcastHistory
    }

    public func getStartCallCount() -> Int {
        startCallCount
    }

    public func getStopCallCount() -> Int {
        stopCallCount
    }

    public func clearHistory() {
        broadcastHistory.removeAll()
        startCallCount = 0
        stopCallCount = 0
    }

    // MARK: - WebSocketServing

    public var isRunning: Bool {
        running
    }

    public func start() throws {
        startCallCount += 1

        if shouldStartFail {
            throw startError ?? NSError(
                domain: "FakeWebSocketServer",
                code: -1,
                userInfo: [NSLocalizedDescriptionKey: "Fake start failure"]
            )
        }

        running = true
    }

    public func stop() {
        stopCallCount += 1
        running = false
    }

    public func broadcast(_ data: Data) {
        broadcastHistory.append(data)
    }
}

// MARK: - FakeSdkHierarchyFetcher

/// Fake implementation of SdkHierarchyFetching for testing
public class FakeSdkHierarchyFetcher: SdkHierarchyFetching {
    private let lock = NSLock()
    private var _cachedHierarchy: SdkViewHierarchy?
    private var _freshHierarchy: SdkViewHierarchy?
    private var _serverInfo: SdkHierarchyServerInfo?
    private var _isAvailable = false
    private var _fetchCallCount = 0
    private var _fetchFreshCallCount = 0
    private var _fetchServerInfoCallCount = 0
    private var _isAvailableCallCount = 0
    private var _setMockRulesCallCount = 0
    private var _setNetworkErrorSimulationCallCount = 0
    private var _addHighlightCallCount = 0
    private var _lastMockRules: [NetworkMockRuleDTO]?
    private var _lastNetworkErrorSimulation: NetworkErrorSimulationDTO?
    private var _lastHighlight: (id: String, shape: HighlightShape)?
    public var setMockRulesResult = true
    public var setNetworkErrorSimulationResult = true
    public var setNetworkFaultRulesResult = true
    public var addHighlightResult: SdkHighlightOutcome = .unavailable

    public init() {}

    // MARK: - Configuration

    public func setCachedHierarchy(_ hierarchy: SdkViewHierarchy?) {
        lock.lock()
        _cachedHierarchy = hierarchy
        lock.unlock()
    }

    public func setFreshHierarchy(_ hierarchy: SdkViewHierarchy?) {
        lock.lock()
        _freshHierarchy = hierarchy
        lock.unlock()
    }

    public func setIsAvailable(_ available: Bool) {
        lock.lock()
        _isAvailable = available
        lock.unlock()
    }

    public func setServerInfo(_ serverInfo: SdkHierarchyServerInfo?) {
        lock.lock()
        _serverInfo = serverInfo
        lock.unlock()
    }

    // MARK: - Assertions

    public var fetchCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _fetchCallCount
    }

    public var fetchFreshCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _fetchFreshCallCount
    }

    public var fetchServerInfoCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _fetchServerInfoCallCount
    }

    public var isAvailableCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _isAvailableCallCount
    }

    public var setMockRulesCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _setMockRulesCallCount
    }

    public var setNetworkErrorSimulationCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _setNetworkErrorSimulationCallCount
    }

    public var addHighlightCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _addHighlightCallCount
    }

    public var lastMockRules: [NetworkMockRuleDTO]? {
        lock.lock()
        defer { lock.unlock() }
        return _lastMockRules
    }

    public var lastNetworkErrorSimulation: NetworkErrorSimulationDTO? {
        lock.lock()
        defer { lock.unlock() }
        return _lastNetworkErrorSimulation
    }

    public var lastHighlight: (id: String, shape: HighlightShape)? {
        lock.lock()
        defer { lock.unlock() }
        return _lastHighlight
    }

    public func clearHistory() {
        lock.lock()
        _fetchCallCount = 0
        _fetchFreshCallCount = 0
        _fetchServerInfoCallCount = 0
        _isAvailableCallCount = 0
        _setMockRulesCallCount = 0
        _setNetworkErrorSimulationCallCount = 0
        _addHighlightCallCount = 0
        _lastMockRules = nil
        _lastNetworkErrorSimulation = nil
        _lastHighlight = nil
        lock.unlock()
    }

    // MARK: - SdkHierarchyFetching

    public func fetchHierarchy() -> SdkViewHierarchy? {
        lock.lock()
        _fetchCallCount += 1
        let result = _cachedHierarchy
        lock.unlock()
        return result
    }

    public func fetchFreshHierarchy() -> SdkViewHierarchy? {
        lock.lock()
        _fetchFreshCallCount += 1
        let result = _freshHierarchy
        lock.unlock()
        return result
    }

    public func fetchServerInfo() -> SdkHierarchyServerInfo? {
        lock.lock()
        _fetchServerInfoCallCount += 1
        let result = _serverInfo
        lock.unlock()
        return result
    }

    public func isAvailable() -> Bool {
        lock.lock()
        _isAvailableCallCount += 1
        let result = _serverInfo != nil || _isAvailable
        lock.unlock()
        return result
    }

    public func setMockRules(_ rules: [NetworkMockRuleDTO]) -> Bool {
        lock.lock()
        _setMockRulesCallCount += 1
        _lastMockRules = rules
        let result = setMockRulesResult
        lock.unlock()
        return result
    }

    public func setNetworkFaultRules(_ rules: [NetworkFaultRuleDTO]) -> Bool {
        return setNetworkFaultRulesResult
    }

    public func setNetworkErrorSimulation(_ config: NetworkErrorSimulationDTO) -> Bool {
        lock.lock()
        _setNetworkErrorSimulationCallCount += 1
        _lastNetworkErrorSimulation = config
        let result = setNetworkErrorSimulationResult
        lock.unlock()
        return result
    }

    public func addHighlight(id: String, shape: HighlightShape) -> SdkHighlightOutcome {
        lock.lock()
        _addHighlightCallCount += 1
        _lastHighlight = (id: id, shape: shape)
        let result = addHighlightResult
        lock.unlock()
        return result
    }
}

// MARK: - FakeSdkHierarchyCache

/// Fake implementation of SdkHierarchyCaching for testing
public class FakeSdkHierarchyCache: SdkHierarchyCaching {
    private let lock = NSLock()
    private var _latest: SdkViewHierarchy?
    private var _updateCallCount = 0
    private var _clearCallCount = 0

    public init() {}

    // MARK: - Assertions

    public var updateCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _updateCallCount
    }

    public var clearCallCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return _clearCallCount
    }

    // MARK: - SdkHierarchyCaching

    public var latest: SdkViewHierarchy? {
        lock.lock()
        defer { lock.unlock() }
        return _latest
    }

    public func update(_ hierarchy: SdkViewHierarchy) {
        lock.lock()
        _latest = hierarchy
        _updateCallCount += 1
        lock.unlock()
    }

    public func clear() {
        lock.lock()
        _latest = nil
        _clearCallCount += 1
        lock.unlock()
    }
}

// MARK: - FakeSdkDatabaseFetcher

/// Fake implementation of SdkDatabaseFetching for testing
public class FakeSdkDatabaseFetcher: SdkDatabaseFetching {
    public struct TableDataCall {
        public let databasePath: String
        public let table: String
        public let limit: Int
        public let offset: Int
    }

    public private(set) var executeSqlCalls: [(databasePath: String, query: String)] = []
    public private(set) var listDatabasesCallCount = 0
    public private(set) var listTablesCalls: [String] = []
    public private(set) var tableDataCalls: [TableDataCall] = []
    public private(set) var tableStructureCalls: [(databasePath: String, table: String)] = []

    public var executeSqlResult = SdkExecuteSqlResult(queryType: "query", columns: [], rows: [], rowsAffected: 0)
    public var executeSqlError: Error?
    public var databases: [SdkDatabaseInfo] = []
    public var storageCapabilitiesResult = SdkStorageCapabilities(
        readOnly: true,
        mutationAuthorized: false,
        registeredAppGroupSuites: [],
        coreDataStores: [],
        unavailableStores: ["keychain", "file_caches"]
    )
    public var tables: [String] = []
    public var tableData = SdkTableDataResult(columns: [], rows: [], total: 0)
    public var tableStructure = SdkTableStructureResult(columns: [])

    public init() {}

    public func executeSQL(databasePath: String, query: String, sessionId: String? = nil) throws -> SdkExecuteSqlResult {
        executeSqlCalls.append((databasePath: databasePath, query: query))
        if let executeSqlError {
            throw executeSqlError
        }
        return executeSqlResult
    }

    public func listDatabases() throws -> [SdkDatabaseInfo] {
        listDatabasesCallCount += 1
        return databases
    }

    public func storageCapabilities() throws -> SdkStorageCapabilities {
        storageCapabilitiesResult
    }

    public func listTables(databasePath: String) throws -> [String] {
        listTablesCalls.append(databasePath)
        return tables
    }

    public func getTableData(
        databasePath: String,
        table: String,
        limit: Int,
        offset: Int
    )
        throws -> SdkTableDataResult
    {
        tableDataCalls.append(
            TableDataCall(databasePath: databasePath, table: table, limit: limit, offset: offset)
        )
        return tableData
    }

    public func getTableStructure(databasePath: String, table: String) throws -> SdkTableStructureResult {
        tableStructureCalls.append((databasePath: databasePath, table: table))
        return tableStructure
    }
}

// MARK: - FakePerfProvider

/// Fake implementation of PerfProvider for testing
public class FakePerfProvider {
    // MARK: - State

    private var flushData: [PerfTiming]?
    private let timeProvider: TimeProvider

    // MARK: - Call History

    private var serialHistory: [String] = []
    private var parallelHistory: [String] = []
    private var operationHistory: [(name: String, type: String)] = []
    private var endCallCount = 0
    private var flushCallCount = 0

    public init(timeProvider: TimeProvider = FakeTimeProvider()) {
        self.timeProvider = timeProvider
    }

    // MARK: - Configuration

    public func setFlushData(_ data: [PerfTiming]?) {
        flushData = data
    }

    // MARK: - Assertions

    public func getSerialHistory() -> [String] {
        serialHistory
    }

    public func getParallelHistory() -> [String] {
        parallelHistory
    }

    public func getOperationHistory() -> [(name: String, type: String)] {
        operationHistory
    }

    public func getEndCallCount() -> Int {
        endCallCount
    }

    public func getFlushCallCount() -> Int {
        flushCallCount
    }

    public func clearHistory() {
        serialHistory.removeAll()
        parallelHistory.removeAll()
        operationHistory.removeAll()
        endCallCount = 0
        flushCallCount = 0
    }

    // MARK: - PerfProvider-like Methods

    public func serial(_ name: String) {
        serialHistory.append(name)
        operationHistory.append((name: name, type: "serial"))
    }

    public func parallel(_ name: String) {
        parallelHistory.append(name)
        operationHistory.append((name: name, type: "parallel"))
    }

    public func end() {
        endCallCount += 1
    }

    @discardableResult
    public func track<T>(_ name: String, block: () throws -> T) rethrows -> T {
        operationHistory.append((name: name, type: "track"))
        return try block()
    }

    public func startOperation(_ name: String) {
        operationHistory.append((name: name, type: "startOperation"))
    }

    public func endOperation(_ name: String) {
        operationHistory.append((name: name, type: "endOperation"))
    }

    public func flush() -> [PerfTiming]? {
        flushCallCount += 1
        return flushData
    }

    public var hasData: Bool {
        return flushData != nil && !(flushData?.isEmpty ?? true)
    }

    public func clear() {
        flushData = nil
    }
}
