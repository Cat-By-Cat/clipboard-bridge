package com.syncclipboard.app

import android.content.Context
import java.util.UUID

data class Session(
    val serverUrl: String,
    val accessToken: String,
    val deviceId: String,
    val syncKey: String
)

class SessionStore(context: Context) {
    private val prefs = context.getSharedPreferences("sync_clipboard", Context.MODE_PRIVATE)

    fun load(): Session? {
        val serverUrl = prefs.getString("serverUrl", null) ?: return null
        val accessToken = prefs.getString("accessToken", null) ?: return null
        val deviceId = prefs.getString("deviceId", null) ?: return null
        val syncKey = prefs.getString("syncKey", null) ?: return null
        return Session(serverUrl, accessToken, deviceId, syncKey)
    }

    fun save(session: Session) {
        prefs.edit()
            .putString("serverUrl", session.serverUrl)
            .putString("accessToken", session.accessToken)
            .putString("deviceId", session.deviceId)
            .putString("syncKey", session.syncKey)
            .apply()
    }

    fun clear() = prefs.edit().clear().apply()

    fun getOrCreateSyncKey(): String {
        val existing = prefs.getString("syncKey", null)
        if (existing != null) return existing
        val generated = UUID.randomUUID().toString().replace("-", "")
        prefs.edit().putString("syncKey", generated).apply()
        return generated
    }
}
