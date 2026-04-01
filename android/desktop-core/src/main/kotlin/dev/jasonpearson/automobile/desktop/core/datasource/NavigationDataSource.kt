package dev.jasonpearson.automobile.desktop.core.datasource

typealias NavigationGraph = dev.jasonpearson.automobile.desktop.domain.NavigationGraph

interface NavigationDataSource {
    suspend fun getNavigationGraph(): Result<NavigationGraph>
}

sealed class Result<out T> {
    data class Success<T>(val data: T) : Result<T>()
    data class Error(val message: String) : Result<Nothing>()
    object Loading : Result<Nothing>()
}
