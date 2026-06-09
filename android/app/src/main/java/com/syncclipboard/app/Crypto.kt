package com.syncclipboard.app

import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

object Crypto {
    private val random = SecureRandom()

    fun keyFromSyncKey(syncKey: String): ByteArray =
        MessageDigest.getInstance("SHA-256").digest(syncKey.toByteArray())

    fun sha256Hex(text: String): String =
        MessageDigest.getInstance("SHA-256")
            .digest(text.toByteArray())
            .joinToString("") { "%02x".format(it) }

    fun encryptText(syncKey: String, plainText: String): EncryptedText {
        val nonce = ByteArray(12)
        random.nextBytes(nonce)
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(keyFromSyncKey(syncKey), "AES"), GCMParameterSpec(128, nonce))
        val encrypted = cipher.doFinal(plainText.toByteArray())
        return EncryptedText(
            ciphertext = Base64.encodeToString(encrypted, Base64.NO_WRAP),
            nonce = Base64.encodeToString(nonce, Base64.NO_WRAP)
        )
    }

    fun decryptText(syncKey: String, ciphertext: String, nonce: String): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(
            Cipher.DECRYPT_MODE,
            SecretKeySpec(keyFromSyncKey(syncKey), "AES"),
            GCMParameterSpec(128, Base64.decode(nonce, Base64.NO_WRAP))
        )
        return String(cipher.doFinal(Base64.decode(ciphertext, Base64.NO_WRAP)))
    }
}

data class EncryptedText(val ciphertext: String, val nonce: String)
