# Cryptography Design

Current MVP encryption contract:

- Each user has a 32-byte `syncKey` stored locally by clients for end-to-end clipboard encryption. In the current MVP, clients deterministically derive it as `SHA-256(lowercase(trim(email)) + ":" + password)` at login so devices for the same account can decrypt each other.
- The production pairing flow should use temporary desktop/mobile X25519 public keys and a key envelope to distribute `syncKey` safely.
- Clipboard text is encrypted with `AES-256-GCM(syncKey, nonce=random12, aad=event metadata)`.
- File transfer should generate a separate `fileKey` per file. Chunks are encrypted with `AES-256-GCM(fileKey, chunkNonce)`, and `fileKey` plus `encryptedMetadata` are protected by `syncKey`.
- The server stores ciphertext, nonce, hash, target device IDs, and required metadata only. It must not store plaintext.

Desktop and Android clients must use the same algorithm, nonce length, Base64 encoding, and hash rules to remain interoperable.
