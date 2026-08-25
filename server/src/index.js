import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticFiles from '@fastify/static';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb, q } from './db.js';
import { newRefreshToken, signAccess, signPrivacy, verifyAccess, verifyPrivacy } from './tokens.js';
import { addEventClient, broadcastUserChanged } from './realtime.js';
import { buildAuthorizeUrl, exchangeCode, hashPrivacyPassword, ssoConfig, verifyPrivacyPassword } from './sso.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 1073741824);

function publicUser(row) {
  return { id: row.id, email: row.email, createdAt: row.created_at, hasPassword: hasLocalPassword(row) };
}

/** 用户是否缺少本地登录密码（纯 SSO 账号） */
function hasLocalPassword(user) {
  return Boolean(user.password_hash);
}

function publicItem(row) {
  return {
    id: row.id,
    type: row.type,
    textContent: row.text_content,
    fileId: row.file_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    size: row.size == null ? null : Number(row.size),
    isPrivate: row.is_private,
    createdAt: row.created_at
  };
}

function sanitizeFileName(name) {
  return String(name || 'file').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').slice(0, 180) || 'file';
}

async function saveUploadStream(stream, storagePath) {
  const writer = createWriteStream(storagePath);
  let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (!writer.write(chunk)) {
        await new Promise((resolve) => writer.once('drain', resolve));
      }
    }
    await new Promise((resolve, reject) => {
      writer.end(resolve);
      writer.once('error', reject);
    });
    return size;
  } catch (error) {
    writer.destroy();
    throw error;
  }
}

function authPreHandler() {
  return async (req, reply) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return reply.code(401).send({ error: 'missing_token' });
    try {
      const payload = verifyAccess(token);
      req.userId = payload.sub;
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }
  };
}

function getPrivacyToken(req) {
  return req.headers['x-privacy-token'] || req.query?.privacyToken;
}

function requirePrivacy(req, reply) {
  try {
    verifyPrivacy(getPrivacyToken(req), req.userId);
    return true;
  } catch {
    reply.code(403).send({ error: 'privacy_verification_required' });
    return false;
  }
}

async function issueTokens(userId) {
  const refreshToken = newRefreshToken();
  await q(
    'insert into refresh_tokens(token, user_id, expires_at) values($1, $2, now() + interval \'30 days\')',
    [refreshToken, userId]
  );
  return { accessToken: signAccess(userId), refreshToken };
}

async function findUserByEmail(email) {
  return (await q('select * from users where email=$1', [email.trim().toLowerCase()])).rows[0];
}

async function itemForFile(fileId, userId) {
  return (await q(
    `select si.*, f.storage_path
       from sent_items si
       join files f on f.id = si.file_id
      where si.file_id = $1 and si.user_id = $2`,
    [fileId, userId]
  )).rows[0];
}

export async function buildApp() {
  await mkdir(uploadDir, { recursive: true });
  await initDb();

  const app = Fastify({ logger: { level: process.env.LOG_LEVEL || 'info' } });
  await app.register(cors, {
    origin: process.env.CORS_ORIGIN || true,
    credentials: true
  });
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: maxFileBytes } });

  app.get('/health', async () => ({ ok: true, service: 'sentbox-web', time: new Date().toISOString() }));

  app.post('/auth/register', async (req, reply) => {
    const { email, password } = req.body || {};
    if (!email || !password || password.length < 8) {
      return reply.code(400).send({ error: 'email_and_password_min_8_required' });
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (await findUserByEmail(normalizedEmail)) return reply.code(409).send({ error: 'email_exists' });

    const user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      password_hash: await bcrypt.hash(password, 10)
    };
    await q('insert into users(id, email, password_hash) values($1, $2, $3)', [
      user.id,
      user.email,
      user.password_hash
    ]);
    return { ...(await issueTokens(user.id)), user: publicUser(user) };
  });

  app.post('/auth/login', async (req, reply) => {
    const { email, password } = req.body || {};
    const user = await findUserByEmail(email || '');
    // 纯 SSO 账号没有本地密码，禁止走密码登录
    if (!user || !hasLocalPassword(user) || !(await bcrypt.compare(password || '', user.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    return { ...(await issueTokens(user.id)), user: publicUser(user) };
  });

  app.post('/auth/refresh', async (req, reply) => {
    const { refreshToken } = req.body || {};
    const row = (await q(
      'select * from refresh_tokens where token=$1 and expires_at > now()',
      [refreshToken]
    )).rows[0];
    if (!row) return reply.code(401).send({ error: 'invalid_refresh' });
    return issueTokens(row.user_id);
  });

  // ---------- 飞牛单点登录（fn-sso OIDC/OAuth2） ----------
  const ssoCookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: false,
    path: '/'
  };

  // 前端获取 SSO 是否可用及入口配置
  // 登录方式探测：sso 配置 + 本地登录是否开启
  // 默认只开放 SSO；LOCAL_AUTH_ENABLED=true 时恢复邮箱密码登录
  app.get('/auth/sso/config', async () => {
    const sso = await ssoConfig();
    // SSO 未配置时强制开放本地登录，避免锁死无法进入
    const localLoginEnabled = !sso || process.env.LOCAL_AUTH_ENABLED === 'true';
    return { sso, localLoginEnabled };
  });

  // 发起授权：后端生成 PKCE verifier 与 state，302 跳转 fn-sso
  app.get('/auth/sso/start', async (req, reply) => {
    // 回调地址动态取当前访问域名（外网域名:外网端口 / 内网IP:8787 都能用）
    const redirectBase = `${req.protocol}://${req.headers.host}`;
    const state = crypto.randomBytes(16).toString('hex');
    try {
      const { url, verifier } = await buildAuthorizeUrl(redirectBase, state);
      reply.setCookie('sso_verifier', verifier, { ...ssoCookieOpts, maxAge: 600 });
      reply.setCookie('sso_state', state, { ...ssoCookieOpts, maxAge: 600 });
      return reply.redirect(url);
    } catch (error) {
      req.log.warn({ err: error }, 'sso start failed');
      return reply.code(502).send({ error: error.message || 'sso_start_failed' });
    }
  });

  // 授权回调：换 token → userinfo → 绑定/创建本地用户 → 签发本地 JWT
  app.get('/auth/sso/callback', async (req, reply) => {
    const { code, state, error } = req.query;
    // 与 start 阶段保持一致：动态取当前访问域名
    const redirectBase = `${req.protocol}://${req.headers.host}`;
    if (error) return reply.redirect(`${redirectBase}/?sso=denied`);
    const verifier = req.cookies?.sso_verifier;
    const expectedState = req.cookies?.sso_state;
    if (!code || !verifier || !state || state !== expectedState) {
      return reply.redirect(`${redirectBase}/?sso=error`);
    }
    reply.clearCookie('sso_verifier', ssoCookieOpts);
    reply.clearCookie('sso_state', ssoCookieOpts);
    let info;
    try {
      info = await exchangeCode(code, verifier, `${redirectBase}/auth/sso/callback`);
    } catch (err) {
      req.log.warn({ err }, 'sso callback exchange failed');
      return reply.redirect(`${redirectBase}/?sso=error`);
    }

    // 按 sso_sub 找用户；找不到再按邮箱找并绑定（同一个人用同一邮箱注册过）
    let user = (await q('select * from users where sso_sub=$1', [info.sub])).rows[0];
    if (!user && info.email) {
      // 邮箱未经 IdP 验证（若提供该声明）时不自动绑定，避免邮箱被冒领
      if (info.emailVerified === false) {
        return reply.redirect(`${redirectBase}/?sso=error`);
      }
      const byEmail = await findUserByEmail(info.email);
      // 仅在该邮箱尚未绑定其他 SSO 账号时绑定，避免覆盖已有关联
      if (byEmail && !byEmail.sso_sub) {
        await q('update users set sso_sub=$2 where id=$1', [byEmail.id, info.sub]);
        user = byEmail;
      }
    }
    if (!user) {
      const id = crypto.randomUUID();
      const email = info.email || `sso_${info.sub}@fn.local`;
      const handleExisting = await findUserByEmail(email);
      if (handleExisting) {
        // 邮箱被占但没绑过（race），罕见，直接报错提示
        return reply.code(409).send({ error: 'email_exists' });
      }
      await q(
        'insert into users(id, email, password_hash, sso_sub) values($1, $2, null, $3)',
        [id, email, info.sub]
      );
      user = (await q('select * from users where id=$1', [id])).rows[0];
    }
    const auth = await issueTokens(user.id);
    // sso_auth 需前端落地到 localStorage，这里刻意不加 httpOnly
    reply.setCookie('sso_auth', JSON.stringify({ ...auth, user: publicUser(user) }), {
      ...ssoCookieOpts,
      httpOnly: false,
      maxAge: 60 * 60 * 24 * 30
    });
    return reply.redirect(`${redirectBase}/?sso=1`);
  });

  // 隐私密码验证：普通用户校验密码哈希；纯 SSO 用户校验独立隐私密码
  app.post('/auth/privacy/verify', { preHandler: authPreHandler() }, async (req, reply) => {
    const { password } = req.body || {};
    const user = (await q('select * from users where id=$1', [req.userId])).rows[0];
    if (!user) return reply.code(401).send({ error: 'invalid_credentials' });
    const valid = hasLocalPassword(user)
      ? await bcrypt.compare(password || '', user.password_hash)
      : Boolean(user.privacy_hash) && (await verifyPrivacyPassword(password || '', user.privacy_hash));
    if (!valid) return reply.code(401).send({ error: 'invalid_credentials' });
    return { privacyToken: signPrivacy(req.userId) };
  });

  // 纯 SSO 账号：设置（或修改）隐私密码，用于开启隐私模式
  app.post('/auth/privacy/set-password', { preHandler: authPreHandler() }, async (req, reply) => {
    const { password } = req.body || {};
    if (!password || password.length < 8) {
      return reply.code(400).send({ error: 'password_min_8_required' });
    }
    const user = (await q('select * from users where id=$1', [req.userId])).rows[0];
    if (!user || hasLocalPassword(user)) {
      return reply.code(403).send({ error: 'local_password_only' });
    }
    await q('update users set privacy_hash=$2 where id=$1', [req.userId, await hashPrivacyPassword(password)]);
    return { ok: true };
  });

  app.get('/items', { preHandler: authPreHandler() }, async (req, reply) => {
    const includePrivate = req.query.includePrivate === 'true';
    if (includePrivate && !requirePrivacy(req, reply)) return reply;
    const rows = (await q(
      `select *
         from sent_items
        where user_id = $1 and ($2::boolean = true or is_private = false)
        order by created_at desc
        limit 200`,
      [req.userId, includePrivate]
    )).rows;
    return { items: rows.map(publicItem) };
  });

  app.post('/items/text', { preHandler: authPreHandler() }, async (req, reply) => {
    const { text, isPrivate = false } = req.body || {};
    if (!text || typeof text !== 'string') return reply.code(400).send({ error: 'text_required' });
    const id = crypto.randomUUID();
    const row = (await q(
      `insert into sent_items(id, user_id, type, text_content, is_private)
       values($1, $2, 'text', $3, $4)
       returning *`,
      [id, req.userId, text, Boolean(isPrivate)]
    )).rows[0];
    broadcastUserChanged(req.userId);
    return { item: publicItem(row) };
  });

  app.post('/items/file', { preHandler: authPreHandler() }, async (req, reply) => {
    const parts = req.parts();
    let isPrivate = false;
    let uploaded;

    for await (const part of parts) {
      if (part.type === 'field' && part.fieldname === 'isPrivate') {
        isPrivate = part.value === 'true';
      }
      if (part.type === 'file' && part.fieldname === 'file') {
        const fileId = crypto.randomUUID();
        const originalName = sanitizeFileName(part.filename);
        const userDir = path.join(uploadDir, req.userId);
        const storagePath = path.join(userDir, `${fileId}-${originalName}`);
        await mkdir(userDir, { recursive: true });
        const size = await saveUploadStream(part.file, storagePath);
        uploaded = {
          id: fileId,
          originalName,
          mimeType: part.mimetype || 'application/octet-stream',
          size,
          storagePath
        };
      }
    }

    if (!uploaded) return reply.code(400).send({ error: 'file_required' });
    const itemId = crypto.randomUUID();
    await q(
      `insert into files(id, user_id, original_name, mime_type, size, storage_path)
       values($1, $2, $3, $4, $5, $6)`,
      [uploaded.id, req.userId, uploaded.originalName, uploaded.mimeType, uploaded.size, uploaded.storagePath]
    );
    const row = (await q(
      `insert into sent_items(id, user_id, type, file_id, file_name, mime_type, size, is_private)
       values($1, $2, 'file', $3, $4, $5, $6, $7)
       returning *`,
      [itemId, req.userId, uploaded.id, uploaded.originalName, uploaded.mimeType, uploaded.size, isPrivate]
    )).rows[0];
    broadcastUserChanged(req.userId);
    return { item: publicItem(row) };
  });

  async function sendFile(req, reply, disposition) {
    const row = await itemForFile(req.params.id, req.userId);
    if (!row) return reply.code(404).send({ error: 'file_not_found' });
    if (row.is_private && !requirePrivacy(req, reply)) return reply;
    if (!fs.existsSync(row.storage_path)) return reply.code(404).send({ error: 'file_missing' });
    return reply
      .header('content-type', row.mime_type || 'application/octet-stream')
      .header('content-length', row.size)
      .header('content-disposition', `${disposition}; filename="${encodeURIComponent(row.file_name)}"`)
      .send(fs.createReadStream(row.storage_path));
  }

  app.get('/files/:id/download', { preHandler: authPreHandler() }, async (req, reply) => {
    return sendFile(req, reply, 'attachment');
  });

  app.get('/files/:id/preview', { preHandler: authPreHandler() }, async (req, reply) => {
    return sendFile(req, reply, 'inline');
  });

  app.get('/events', (req, reply) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const token = url.searchParams.get('token');
      const payload = verifyAccess(token);
      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no'
      });
      addEventClient(payload.sub, reply.raw);
    } catch {
      reply.code(401).send({ error: 'invalid_token' });
    }
  });

  app.delete('/test/files', { preHandler: authPreHandler() }, async (req) => {
    if (process.env.NODE_ENV !== 'test') return { ok: false };
    await rm(path.join(uploadDir, req.userId), { recursive: true, force: true });
    return { ok: true };
  });

  const webDist = path.resolve(process.env.WEB_DIST_DIR || path.join(__dirname, '..', '..', 'web', 'dist'));
  if (fs.existsSync(webDist)) {
    await app.register(staticFiles, { root: webDist, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith('/api') || req.raw.url?.startsWith('/auth') || req.raw.url?.startsWith('/items') || req.raw.url?.startsWith('/files')) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.sendFile('index.html');
    });
  }

  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const app = await buildApp();
  app.listen({ port: Number(process.env.PORT || 8787), host: '0.0.0.0' }).catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
}
