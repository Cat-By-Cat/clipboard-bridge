package com.syncclipboard.app

import android.app.Activity
import android.net.Uri
import android.os.Bundle
import android.widget.LinearLayout
import android.widget.TextView

class ShareActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val sharedUri = intent.getParcelableExtra<Uri>(android.content.Intent.EXTRA_STREAM)
        val sharedText = intent.getCharSequenceExtra(android.content.Intent.EXTRA_TEXT)?.toString()
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(32, 32, 32, 32)
            addView(TextView(this@ShareActivity).apply {
                textSize = 20f
                this.text = "Shared content received"
            })
            addView(TextView(this@ShareActivity).apply {
                this.text = when {
                    sharedUri != null -> "File or image URI: $sharedUri\nThe share entry is ready. Target-device upload will be wired here."
                    sharedText != null -> "Text: $sharedText"
                    else -> "No supported content"
                }
            })
        }
        setContentView(root)
    }
}
