package com.syncclipboard.app

import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject

class RelayApi(private val client: OkHttpClient = OkHttpClient()) {
    private val jsonMedia = "application/json".toMediaType()

    fun registerOrLogin(serverUrl: String, email: String, password: String, register: Boolean): JSONObject {
        val body = JSONObject().put("email", email).put("password", password).toString().toRequestBody(jsonMedia)
        val request = Request.Builder().url("$serverUrl/auth/${if (register) "register" else "login"}").post(body).build()
        return executeJson(request)
    }

    fun registerDevice(serverUrl: String, token: String, name: String, publicKey: String): JSONObject {
        val body = JSONObject()
            .put("name", name)
            .put("platform", "android")
            .put("publicKey", publicKey)
            .toString().toRequestBody(jsonMedia)
        val request = authed(serverUrl, token, "/devices/register").post(body).build()
        return executeJson(request).getJSONObject("device")
    }

    fun devices(session: Session): JSONArray {
        val request = authed(session.serverUrl, session.accessToken, "/devices").get().build()
        return executeJson(request).getJSONArray("devices")
    }

    fun sendClipboard(session: Session, ciphertext: String, nonce: String, contentHash: String) {
        val body = JSONObject()
            .put("deviceId", session.deviceId)
            .put("targetDeviceIds", JSONArray())
            .put("ciphertext", ciphertext)
            .put("nonce", nonce)
            .put("contentHash", contentHash)
            .toString().toRequestBody(jsonMedia)
        val request = authed(session.serverUrl, session.accessToken, "/events/clipboard").post(body).build()
        executeJson(request)
    }

    private fun authed(serverUrl: String, token: String, path: String): Request.Builder =
        Request.Builder().url("$serverUrl$path").header("Authorization", "Bearer $token")

    private fun executeJson(request: Request): JSONObject {
        client.newCall(request).execute().use { response ->
            val text = response.body?.string().orEmpty()
            if (!response.isSuccessful) error(text.ifBlank { "HTTP ${response.code}" })
            return JSONObject(text)
        }
    }
}
