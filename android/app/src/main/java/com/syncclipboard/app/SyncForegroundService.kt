package com.syncclipboard.app

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject

class SyncForegroundService : Service() {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val api = RelayApi()
    private val client = OkHttpClient()
    private var webSocket: WebSocket? = null
    private var lastHash: String? = null
    private var suppressNext = false

    override fun onCreate() {
        super.onCreate()
        ensureChannel()
        startForeground(
            1001,
            NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.stat_notify_sync)
                .setContentTitle("同步剪贴板正在后台运行")
                .setContentText("保持设备在线，接收远端剪贴板与文件事件")
                .setOngoing(true)
                .build()
        )
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val session = SessionStore(this).load() ?: return START_NOT_STICKY
        connectWebSocket(session)
        pollClipboard(session)
        return START_STICKY
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        webSocket?.close(1000, "service destroyed")
        scope.cancel()
        super.onDestroy()
    }

    private fun connectWebSocket(session: Session) {
        val wsUrl = session.serverUrl.replaceFirst("http", "ws") +
            "/ws?token=${session.accessToken}&deviceId=${session.deviceId}"
        val request = Request.Builder().url(wsUrl).build()
        webSocket = client.newWebSocket(request, object : WebSocketListener() {
            override fun onMessage(webSocket: WebSocket, text: String) {
                val event = JSONObject(text)
                if (event.optString("type") != "clipboard.update") return
                if (event.optString("senderDeviceId") == session.deviceId) return
                val payload = event.getJSONObject("payload")
                val plain = Crypto.decryptText(session.syncKey, payload.getString("ciphertext"), payload.getString("nonce"))
                val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
                lastHash = Crypto.sha256Hex(plain)
                suppressNext = true
                clipboard.setPrimaryClip(ClipData.newPlainText("remote", plain))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scope.launch {
                    delay(2500)
                    connectWebSocket(session)
                }
            }
        })
    }

    private fun pollClipboard(session: Session) {
        scope.launch {
            val clipboard = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            while (true) {
                delay(CLIPBOARD_POLL_INTERVAL_MS)
                if (suppressNext) {
                    suppressNext = false
                    continue
                }
                val text = clipboard.primaryClip?.getItemAt(0)?.coerceToText(this@SyncForegroundService)?.toString()
                if (text.isNullOrBlank()) continue
                val hash = Crypto.sha256Hex(text)
                if (hash == lastHash) continue
                lastHash = hash
                val encrypted = Crypto.encryptText(session.syncKey, text)
                runCatching { api.sendClipboard(session, encrypted.ciphertext, encrypted.nonce, hash) }
            }
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(CHANNEL_ID, "后台同步", NotificationManager.IMPORTANCE_LOW)
            getSystemService(NotificationManager::class.java).createNotificationChannel(channel)
        }
    }

    companion object {
        private const val CHANNEL_ID = "sync_clipboard_background"
        private const val CLIPBOARD_POLL_INTERVAL_MS = 5000L
    }
}
