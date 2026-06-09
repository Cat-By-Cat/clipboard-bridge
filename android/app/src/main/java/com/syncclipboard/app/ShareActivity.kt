package com.syncclipboard.app

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView

class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent.getParcelableExtra<Uri>(android.content.Intent.EXTRA_STREAM)
        val text = intent.getCharSequenceExtra(android.content.Intent.EXTRA_TEXT)?.toString()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            addView(TextView(this@ShareActivity).apply {
                textSize = 20f
                text = "已收到分享内容"
            })
            addView(TextView(this@ShareActivity).apply {
                text = when {
                    uri != null -> "文件/图片 URI：$uri\n首版已接入分享入口，后续会在这里选择目标设备并上传加密文件。"
                    text != null -> "文本：$text"
                    else -> "没有可处理的内容"
                }
            })
        }
        setContentView(root)
    }
}
