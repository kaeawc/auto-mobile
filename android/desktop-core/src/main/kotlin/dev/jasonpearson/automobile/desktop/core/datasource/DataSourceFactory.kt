package dev.jasonpearson.automobile.desktop.core.datasource

import dev.jasonpearson.automobile.desktop.core.daemon.AutoMobileClient
import dev.jasonpearson.automobile.desktop.core.daemon.FailuresStreamClient
import dev.jasonpearson.automobile.desktop.core.di.AppScope
import dev.jasonpearson.automobile.desktop.core.di.SingleIn
import dev.jasonpearson.automobile.desktop.core.failures.CompositeFailuresDataSource
import dev.jasonpearson.automobile.desktop.core.failures.FailuresDataSource
import dev.jasonpearson.automobile.desktop.core.failures.FakeFailuresDataSource
import dev.jasonpearson.automobile.desktop.core.failures.McpFailuresDataSource
import dev.jasonpearson.automobile.desktop.core.failures.StreamingFailuresDataSource
import dev.jasonpearson.automobile.desktop.core.storage.StoragePlatform
import dev.zacsweers.metro.ContributesBinding
import dev.zacsweers.metro.Inject

/**
 * Factory for creating data source implementations based on the current mode. When mode is Real,
 * the injected [AutoMobileClient] is used for MCP data fetching.
 */
interface DataSourceFactory {

  /**
   * Creates a navigation data source based on the specified mode. In Real mode the data source is
   * wrapped with a TTL cache to avoid re-fetching on every tab switch or recomposition.
   *
   * @param mode The data source mode (Fake or Real)
   * @param clientProvider Optional override client provider (e.g. for process-specific connections)
   * @param appId Optional app ID to filter the navigation graph by specific app
   * @param cacheTtlMs TTL in milliseconds for the in-memory cache (Real mode only)
   */
  fun createNavigationDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)? = null,
    appId: String? = null,
    cacheTtlMs: Long = 30_000L,
  ): NavigationDataSource

  /**
   * Creates a test data source based on the specified mode.
   *
   * @param mode The data source mode (Fake or Real)
   * @param clientProvider Optional override client provider (e.g. for process-specific connections)
   */
  fun createTestDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)? = null,
  ): TestDataSource

  /**
   * Creates a performance data source based on the specified mode.
   *
   * @param mode The data source mode (Fake or Real)
   * @param clientProvider Optional override client provider (e.g. for process-specific connections)
   * @param deviceId The device to scope audit-history reads to (null = all devices)
   */
  fun createPerformanceDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)? = null,
    deviceId: String? = null,
  ): PerformanceDataSource

  /**
   * Creates a storage data source based on the specified mode.
   *
   * @param mode The data source mode (Fake or Real)
   * @param clientProvider Optional override client provider (e.g. for process-specific connections)
   * @param deviceId The device ID to fetch storage data for (required for Real mode)
   * @param packageName The package name of the app to inspect (required for Real mode)
   * @param platform The storage platform (Android or iOS)
   */
  fun createStorageDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)? = null,
    deviceId: String? = null,
    packageName: String? = null,
    platform: StoragePlatform = StoragePlatform.Android,
  ): StorageDataSource

  /**
   * Creates a layout data source based on the specified mode.
   *
   * @param mode The data source mode (Fake or Real)
   * @param clientProvider Optional override client provider (e.g. for process-specific connections)
   * @param platform The device platform ("android" or "ios")
   */
  fun createLayoutDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)? = null,
    platform: String = "android",
  ): LayoutDataSource

  /**
   * Creates an app list data source based on the specified mode. In Real mode the data source is
   * wrapped with a TTL cache to avoid re-fetching on every tab switch or recomposition.
   *
   * @param mode The data source mode (Fake or Real)
   * @param clientProvider Optional override client provider (e.g. for process-specific connections)
   * @param deviceId The device ID to fetch apps for (required for Real mode)
   * @param cacheTtlMs TTL in milliseconds for the in-memory cache (Real mode only)
   */
  fun createAppListDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)? = null,
    deviceId: String? = null,
    cacheTtlMs: Long = 30_000L,
  ): AppListDataSource

  /**
   * Creates a failures data source based on the specified mode.
   *
   * @param mode The data source mode (Fake or Real)
   * @param clientProvider Optional override client provider (e.g. for process-specific connections)
   * @param streamClientProvider Optional function to provide a FailuresStreamClient for streaming
   */
  fun createFailuresDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)? = null,
    streamClientProvider: (() -> FailuresStreamClient)? = null,
  ): FailuresDataSource
}

/**
 * Default implementation of [DataSourceFactory] backed by the DI-provided [AutoMobileClient].
 *
 * When callers pass a non-null [clientProvider] override, that provider is used instead of the
 * injected client. This supports process-specific connections while keeping the common path
 * DI-driven.
 */
@ContributesBinding(AppScope::class)
@SingleIn(AppScope::class)
@Inject
class DefaultDataSourceFactory(private val client: AutoMobileClient) : DataSourceFactory {

  private fun resolveProvider(clientProvider: (() -> AutoMobileClient)?): (() -> AutoMobileClient) {
    return clientProvider ?: { client }
  }

  override fun createNavigationDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)?,
    appId: String?,
    cacheTtlMs: Long,
  ): NavigationDataSource {
    return when (mode) {
      DataSourceMode.Fake -> FakeNavigationDataSource()
      DataSourceMode.Real ->
        CachedNavigationDataSource(
          delegate = RealNavigationDataSource(resolveProvider(clientProvider), appId),
          ttlMs = cacheTtlMs,
        )
    }
  }

  override fun createTestDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)?,
  ): TestDataSource {
    return when (mode) {
      DataSourceMode.Fake -> FakeTestDataSource()
      DataSourceMode.Real -> RealTestDataSource(resolveProvider(clientProvider))
    }
  }

  override fun createPerformanceDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)?,
    deviceId: String?,
  ): PerformanceDataSource {
    return when (mode) {
      DataSourceMode.Fake -> FakePerformanceDataSource()
      DataSourceMode.Real -> RealPerformanceDataSource(resolveProvider(clientProvider), deviceId)
    }
  }

  override fun createStorageDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)?,
    deviceId: String?,
    packageName: String?,
    platform: StoragePlatform,
  ): StorageDataSource {
    return when (mode) {
      DataSourceMode.Fake -> FakeStorageDataSource()
      DataSourceMode.Real ->
        RealStorageDataSource(resolveProvider(clientProvider), deviceId, packageName, platform)
    }
  }

  override fun createLayoutDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)?,
    platform: String,
  ): LayoutDataSource {
    return when (mode) {
      DataSourceMode.Fake -> FakeLayoutDataSource()
      DataSourceMode.Real -> RealLayoutDataSource(resolveProvider(clientProvider), platform)
    }
  }

  override fun createAppListDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)?,
    deviceId: String?,
    cacheTtlMs: Long,
  ): AppListDataSource {
    return when (mode) {
      DataSourceMode.Fake -> FakeAppListDataSource()
      DataSourceMode.Real ->
        CachedAppListDataSource(
          delegate = RealAppListDataSource(resolveProvider(clientProvider), deviceId),
          ttlMs = cacheTtlMs,
        )
    }
  }

  override fun createFailuresDataSource(
    mode: DataSourceMode,
    clientProvider: (() -> AutoMobileClient)?,
    streamClientProvider: (() -> FailuresStreamClient)?,
  ): FailuresDataSource {
    return when (mode) {
      DataSourceMode.Fake -> FakeFailuresDataSource()
      DataSourceMode.Real ->
        CompositeFailuresDataSource(
          mcpDataSource = McpFailuresDataSource(resolveProvider(clientProvider)),
          streamingDataSource = streamClientProvider?.let { StreamingFailuresDataSource(it()) },
        )
    }
  }
}
