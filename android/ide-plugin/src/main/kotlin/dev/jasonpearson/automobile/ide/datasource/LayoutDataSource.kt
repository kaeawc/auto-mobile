package dev.jasonpearson.automobile.ide.datasource

import dev.jasonpearson.automobile.ide.layout.UIElementInfo

interface LayoutDataSource {
    suspend fun getViewHierarchy(): Result<UIElementInfo>
}
