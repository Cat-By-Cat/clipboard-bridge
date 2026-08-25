# Sentbox Web

Sentbox Web 是一个网页端多端发送工具。一个账号可以在多个浏览器或设备同时登录，发送文本或文件后，所有在线端都会实时刷新已发送列表。

## 功能

- 邮箱和密码注册、登录、刷新会话。
- 飞牛单点登录（fn-sso OIDC/OAuth2，授权码 + PKCE）。
- 发送文本和文件。
- 已发送列表支持复制文本、下载文件、浏览器原生预览文件。
- 发送时可标记为隐私。
- 隐私内容默认隐藏；开启隐私模式并验证登录密码后才可见。
- WebSocket 实时通知同账号多端刷新。

## 本地开发

```powershell
npm install
Copy-Item server/.env.example server/.env
docker compose -f server/docker-compose.yml up -d postgres
npm run server:dev
npm run web:dev
```

默认服务端地址是 <http://localhost:8787>，网页开发地址是 <http://localhost:5173>。

## 飞牛单点登录接入

服务端通过 OIDC 标准流程接入自研 fn-sso（授权码 + PKCE）：

1. 在 fn-sso 管理端新建应用，拿到 `client_id` / `client_secret`，回调地址填 `{本系统地址}/auth/sso/callback`。
2. 在 `server/.env` 配置：

   ```ini
   SSO_ISSUER=http://a.gxc1994.top:28900
   SSO_CLIENT_ID=你的_client_id
   SSO_CLIENT_SECRET=你的_client_secret
   ```

3. 登录页会出现「使用飞牛账号登录」，首次登录自动创建本地账号并绑定；同邮箱已有本地账号时自动关联，之后两种方式都可登录。
4. 纯 SSO 账号没有本地密码，需要专属隐私密码才能开启隐私模式（首次开启时设置一次）。
5. 默认登录页**只显示飞牛 SSO**，邮箱密码登录/注册隐藏；需要恢复时在 `.env` 设置 `LOCAL_AUTH_ENABLED=true`。

未配置 `SSO_ISSUER` 时 SSO 入口自动隐藏，并强制开放邮箱密码登录（防止无法登录）。

## 生产构建

```powershell
npm install
npm run build
npm start
```

服务端会在 `web/dist` 存在时托管静态网页。

## 测试

服务端集成测试需要 PostgreSQL。设置 `TEST_DATABASE_URL` 后运行：

```powershell
$env:TEST_DATABASE_URL="postgres://sync:sync@localhost:5432/sync_clipboard"
npm test
```
