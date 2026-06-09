# 不在本机安装环境的打包方式

如果只是自己使用，不想在本机安装 Rust、Android SDK、Gradle、macOS 打包链，可以使用 GitHub Actions 云端打包。

## 方式一：手动触发打包

1. 把这个项目推到一个 GitHub 私有仓库。
2. 打开仓库的 `Actions` 页面。
3. 运行 `Build Desktop Apps`：会分别在 Windows 和 macOS 云端机器上构建桌面端。
4. 运行 `Build Android APK`：会在 Ubuntu 云端机器上构建 Android debug APK。
5. 在 workflow 页面底部的 `Artifacts` 下载产物。

## 方式二：打 tag 自动打包

推送类似 `v0.1.0` 的 tag 后会自动触发：

```powershell
git tag v0.1.0
git push origin v0.1.0
```

## Windows 使用说明

下载 `sync-clipboard-windows` artifact，里面通常会包含 `.msi` 或 `.exe`。

## macOS 使用说明

下载 `sync-clipboard-macos` artifact。因为这是自己用的未签名包，首次打开可能需要：

```bash
xattr -dr com.apple.quarantine /path/to/同步剪贴板.app
```

或者在系统设置的“隐私与安全性”里允许打开。

## Android 使用说明

下载 `sync-clipboard-android-debug-apk`，把 APK 传到手机安装。debug APK 适合自己用，不适合公开分发。

## 服务端

服务端推荐部署在 VPS 上，只需要 Docker：

```powershell
cd server
docker compose up -d --build
```

如果 VPS 也不想装 Node/Rust/Java，只装 Docker 就够了。
