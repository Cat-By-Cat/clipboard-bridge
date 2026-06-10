import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const testDb = process.env.TEST_DATABASE_URL;

async function waitForSseEvent(response, eventName) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split('\n\n');
    buffer = events.pop() || '';
    for (const raw of events) {
      const lines = raw.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      if (event === eventName && data) return JSON.parse(data);
    }
  }
  throw new Error(`timed out waiting for ${eventName}`);
}

test('sentbox API supports auth, privacy, files, ownership, and realtime', { skip: !testDb && 'set TEST_DATABASE_URL to run PostgreSQL integration tests' }, async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testDb;
  process.env.JWT_SECRET = 'test-secret';
  process.env.REFRESH_SECRET = 'test-refresh-secret';
  process.env.UPLOAD_DIR = await mkdtemp(path.join(os.tmpdir(), 'sentbox-test-'));

  const { buildApp } = await import('../src/index.js');
  const { resetDbForTests, closeDb } = await import('../src/db.js');
  await resetDbForTests();
  const app = await buildApp();

  try {
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'a@test.com', password: 'password123' }
    });
    assert.equal(reg.statusCode, 200);
    const token = reg.json().accessToken;

    const secondLogin = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'a@test.com', password: 'password123' }
    });
    assert.equal(secondLogin.statusCode, 200);

    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address();
    const events = await fetch(`http://127.0.0.1:${address.port}/events?token=${encodeURIComponent(token)}`);
    assert.equal(events.status, 200);
    await waitForSseEvent(events, 'connected');

    const text = await app.inject({
      method: 'POST',
      url: '/items/text',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'hello', isPrivate: false }
    });
    assert.equal(text.statusCode, 200);
    const message = await waitForSseEvent(events, 'items.changed');
    assert.equal(message.type, 'items.changed');

    const privateText = await app.inject({
      method: 'POST',
      url: '/items/text',
      headers: { authorization: `Bearer ${token}` },
      payload: { text: 'secret', isPrivate: true }
    });
    assert.equal(privateText.statusCode, 200);

    const visible = await app.inject({
      method: 'GET',
      url: '/items',
      headers: { authorization: `Bearer ${token}` }
    });
    assert.deepEqual(visible.json().items.map((item) => item.textContent), ['hello']);

    const blockedPrivate = await app.inject({
      method: 'GET',
      url: '/items?includePrivate=true',
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(blockedPrivate.statusCode, 403);

    const privacy = await app.inject({
      method: 'POST',
      url: '/auth/privacy/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'password123' }
    });
    assert.equal(privacy.statusCode, 200);
    const privacyToken = privacy.json().privacyToken;

    const allItems = await app.inject({
      method: 'GET',
      url: '/items?includePrivate=true',
      headers: { authorization: `Bearer ${token}`, 'x-privacy-token': privacyToken }
    });
    assert.deepEqual(allItems.json().items.map((item) => item.textContent), ['secret', 'hello']);

    const form = new FormData();
    form.set('isPrivate', 'true');
    form.set('file', new Blob(['file-body'], { type: 'text/plain' }), 'note.txt');
    const upload = await fetch(`http://127.0.0.1:${address.port}/items/file`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
      body: form
    });
    assert.equal(upload.status, 200);
    const fileItem = (await upload.json()).item;

    const privateDownloadBlocked = await app.inject({
      method: 'GET',
      url: `/files/${fileItem.fileId}/download`,
      headers: { authorization: `Bearer ${token}` }
    });
    assert.equal(privateDownloadBlocked.statusCode, 403);

    const privateDownload = await fetch(`http://127.0.0.1:${address.port}/files/${fileItem.fileId}/preview`, {
      headers: { authorization: `Bearer ${token}`, 'x-privacy-token': privacyToken }
    });
    assert.equal(privateDownload.status, 200);
    assert.equal(await privateDownload.text(), 'file-body');

    const regOther = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'b@test.com', password: 'password123' }
    });
    const otherToken = regOther.json().accessToken;
    const otherAccess = await app.inject({
      method: 'GET',
      url: `/files/${fileItem.fileId}/download`,
      headers: { authorization: `Bearer ${otherToken}` }
    });
    assert.equal(otherAccess.statusCode, 404);
    await events.body.cancel();
  } finally {
    await app.close();
    await closeDb();
    await rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
  }
});