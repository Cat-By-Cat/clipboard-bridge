package com.syncclipboard.app

import android.Manifest
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.view.ViewGroup
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Switch
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import java.security.MessageDigest

class MainActivity : AppCompatActivity() {
    private val scope = CoroutineScope(Dispatchers.Main)
    private val api = RelayApi()
    private lateinit var store: SessionStore
    private lateinit var logView: TextView
    private lateinit var devicesView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        store = SessionStore(this)
        if (Build.VERSION.SDK_INT >= 33) ActivityCompat.requestPermissions(this, arrayOf(Manifest.permission.POST_NOTIFICATIONS), 10)
        render()
    }

    private fun render() {
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(28, 36, 28, 28)
        }
        val title = TextView(this).apply { text = "同步剪贴板"; textSize = 26f }
        root.addView(title)
        logView = TextView(this).apply { text = ""; textSize = 13f }
        devicesView = TextView(this).apply { text = "设备列表未加载"; textSize = 15f }

        val session = store.load()
        if (session == null) renderLogin(root) else renderHome(root, session)
        root.addView(logView)
        setContentView(ScrollView(this).apply { addView(root) })
    }

    private fun renderLogin(root: LinearLayout) {
        val server = input("服务端地址", "http://10.0.2.2:8787")
        val email = input("邮箱", "")
        val password = input("密码至少 8 位", "")
        root.addView(server); root.addView(email); root.addView(password)
        root.addView(button("登录") { authenticate(server.text.toString(), email.text.toString(), password.text.toString(), false) })
        root.addView(button("注册") { authenticate(server.text.toString(), email.text.toString(), password.text.toString(), true) })
        root.addView(TextView(this).apply { text = "提示：Android 10+ 无法让普通后台应用无限制静默读取剪贴板。应用会通过前台服务保持连接，并在系统允许时同步剪贴板。" })
    }

    private fun renderHome(root: LinearLayout, session: Session) {
        root.addView(TextView(this).apply { text = "设备 ID：${session.deviceId}" })
        root.addView(Switch(this).apply {
            text = "启动后台剪贴板同步服务"
            isChecked = true
            setOnCheckedChangeListener { _, checked -> if (checked) startSyncService() else stopService(Intent(this@MainActivity, SyncForegroundService::class.java)) }
        })
        root.addView(button("刷新设备列表") { loadDevices(session) })
        root.addView(button("退出登录") { store.clear(); stopService(Intent(this, SyncForegroundService::class.java)); render() })
        root.addView(devicesView)
        startSyncService()
        loadDevices(session)
    }

    private fun authenticate(serverUrl: String, email: String, password: String, register: Boolean) {
        scope.launch {
            runCatching {
                withContext(Dispatchers.IO) {
                    val auth = api.registerOrLogin(serverUrl, email, password, register)
                    val token = auth.getString("accessToken")
                    val publicKey = MessageDigest.getInstance("SHA-256")
                        .digest(Settings.Secure.getString(contentResolver, Settings.Secure.ANDROID_ID).toByteArray())
                        .joinToString("") { "%02x".format(it) }
                    val device = api.registerDevice(serverUrl, token, Build.MODEL ?: "Android", publicKey)
                    Session(serverUrl, token, device.getString("id"), store.deriveSyncKey(email, password))
                }
            }.onSuccess {
                store.save(it)
                log("已登录并注册设备")
                render()
            }.onFailure { log("登录失败：${it.message}") }
        }
    }

    private fun loadDevices(session: Session) {
        scope.launch {
            runCatching { withContext(Dispatchers.IO) { api.devices(session) } }
                .onSuccess { arr ->
                    devicesView.text = (0 until arr.length()).joinToString("\n") { i ->
                        val d = arr.getJSONObject(i)
                        "${d.optString("name")} · ${d.optString("platform")} · ${d.optString("id")}"
                    }.ifBlank { "暂无设备" }
                }
                .onFailure { log("加载设备失败：${it.message}") }
        }
    }

    private fun startSyncService() {
        val intent = Intent(this, SyncForegroundService::class.java)
        if (Build.VERSION.SDK_INT >= 26) startForegroundService(intent) else startService(intent)
    }

    private fun input(hint: String, value: String) = EditText(this).apply {
        this.hint = hint
        setText(value)
        layoutParams = ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    }

    private fun button(text: String, onClick: () -> Unit) = Button(this).apply {
        this.text = text
        setOnClickListener { onClick() }
    }

    private fun log(message: String) { logView.text = "${message}\n${logView.text}" }
}
