import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const uploadDir = path.resolve(process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads'));
const maxFileBytes = Number(process.env.MAX_FILE_BYTES || 1073741824);

function publicUser(row) {
  return { id: row.id, email: row.email, createdAt: row.created_at };
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
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
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

  app.post('/auth/privacy/verify', { preHandler: authPreHandler() }, async (req, reply) => {
    const { password } = req.body || {};
    const user = (await q('select * from users where id=$1', [req.userId])).rows[0];
    if (!user || !(await bcrypt.compare(password || '', user.password_hash))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    return { privacyToken: signPrivacy(req.userId) };
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
