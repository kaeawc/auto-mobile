package dev.jasonpearson.automobile.desktop.core.datasource

sealed interface Result<out T> {
  data class Success<T>(val data: T) : Result<T>

  data class Error(
    val exception: Throwable,
    val message: String? = exception.message,
    val errorCode: String? = null,
    val errorReason: String? = null,
  ) : Result<Nothing>

  data object Loading : Result<Nothing>
}
