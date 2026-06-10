package com.syncclipboard.app

import android.content.Context
import java.security.MessageDigest

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
        if (!Regex("^[0-9a-fA-F]{64}$").matches(syncKey)) {
            clear()
            return null
        }
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

    fun deriveSyncKey(email: String, password: String): String {
        val normalized = "${email.trim().lowercase()}:$password"
        return MessageDigest.getInstance("SHA-256")
            .digest(normalized.toByteArray(Charsets.UTF_8))
            .joinToString("") { "%02x".format(it) }
    }
}
