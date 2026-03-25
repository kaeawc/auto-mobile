package dev.jasonpearson.automobile.shared.datasource

import dev.jasonpearson.automobile.shared.performance.PerformanceRun

interface PerformanceDataSource {
    suspend fun getPerformanceRun(): Result<PerformanceRun>
}
