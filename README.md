# Sentbox Web

Sentbox Web 是一个网页端多端发送工具。一个账号可以在多个浏览器或设备同时登录，发送文本或文件后，所有在线端都会实时刷新已发送列表。

## 功能

- 邮箱和密码注册、登录、刷新会话。
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
