# Clipboard Bridge

Clipboard Bridge is an MVP for syncing clipboard text and encrypted file payloads across devices. Devices logged in with the same account password derive the same local sync key, so clipboard ciphertext can be decrypted across desktop and Android clients.

- `server/`: relay service with authentication, device registration, WebSocket event forwarding, file upload/download APIs, and Docker Compose deployment.
- `desktop/`: Tauri + React desktop client for Windows and macOS with login, device selection, clipboard sync, and file sending UI.
- `android/`: Kotlin Android client with login/register, device registration, a foreground sync service, and clipboard sync support.
- `shared/`: protocol and cryptography design notes.

> This repository is an MVP skeleton. Production usage still needs stronger end-to-end key exchange, file chunk integrity checks, richer permission prompts, and platform-specific mobile background behavior handling. Desktop builds require Rust and Tauri tooling. Android builds require Android Studio and the Android SDK.

## Local development

```powershell
npm install
Copy-Item server/.env.example server/.env
npm run server:dev
```

Health check: <http://localhost:8787/health>

## Docker deployment

```powershell
cd server
docker compose up -d --build
```

The service listens on port `8787` by default.

## Desktop client

Install Rust and Tauri prerequisites first.

```powershell
npm install
npm run desktop:dev
# Start the Tauri development window
npm run desktop:tauri
# Build a Windows installer
npm --workspace desktop run tauri -- build --bundles msi --ci
```

## Android client

Open the `android/` directory in Android Studio, wait for Gradle sync, then run the `app` module. The package name is `com.syncclipboard.app`.

For the Android emulator, the default local server URL is `http://10.0.2.2:8787`. For a physical device, use the computer LAN address, for example `http://192.168.x.x:8787`.

## Notes

Android 10 and later restrict background clipboard access. This project keeps a foreground service online and syncs clipboard content when the OS allows it. Some vendor ROMs may require notification, background execution, or battery optimization permissions.
