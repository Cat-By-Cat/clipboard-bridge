import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildAuthorizeUrl, exchangeCode, ssoConfig } from '../src/sso.js';

const testDb = process.env.TEST_DATABASE_URL;

/**
 * 简易 fn-sso mock：实现发现、token、userinfo 三个端点。
 * userinfo 按调用次数返回不同身份：前 2 次是 fn-user-1/sso@test.com，
 * 第 3 次起是 fn-user-3/bind@test.com（用于验证「同邮箱绑定本地账号」）。
 */
function startMockSso() {
  let userinfoCalls = 0;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        authorization_endpoint: `http://localhost:${server.address().port}/oauth/authorize`,
        token_endpoint: `http://localhost:${server.address().port}/oauth/token`,
        userinfo_endpoint: `http://localhost:${server.address().port}/oauth/userinfo`
      }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/oauth/authorize') {
      res.statusCode = 302;
      res.setHeader('location', `${url.searchParams.get('redirect_uri')}?code=mock-code&state=${url.searchParams.get('state')}`);
      res.end();
      return;
    }
    if (req.method === 'POST' && url.pathname === '/oauth/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const params = new URLSearchParams(body);
      const ok = params.get('grant_type') === 'authorization_code'
        && params.get('code') === 'mock-code'
        && Boolean(params.get('code_verifier'))
        && params.get('client_secret') === 'mock-secret';
      if (!ok || params.get('code') === 'bad-code') {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid_request' }));
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: 'mock-access', token_type: 'Bearer', expires_in: 3600 }));
      return;
    }
    if (req.method === 'GET' && url.pathname === '/oauth/userinfo') {
      if (req.headers.authorization !== 'Bearer mock-access') {
        res.statusCode = 401;
        res.end('{}');
        return;
      }
      userinfoCalls += 1;
      const third = userinfoCalls >= 3;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        sub: third ? 'fn-user-3' : 'fn-user-1',
        email: third ? 'bind@test.com' : 'sso@test.com',
        name: 'SSO 用户'
      }));
      return;
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function cookieFromSetCookie(setCookieHeaders, name) {
  const header = setCookieHeaders.find((c) => c.startsWith(name + '='));
  if (!header) return null;
  return decodeURIComponent(header.split(';')[0].slice(name.length + 1));
}

test('sso.js 纯逻辑：PKCE 授权 URL 与 token 换取（无需数据库）', async () => {
  const mock = await startMockSso();
  const port = mock.address().port;
  const issuer = `http://127.0.0.1:${port}`;
  const savedIssuer = process.env.SSO_ISSUER;
  const savedClientId = process.env.SSO_CLIENT_ID;
  const savedSecret = process.env.SSO_CLIENT_SECRET;
  process.env.SSO_ISSUER = issuer;
  process.env.SSO_CLIENT_ID = 'mock-client';
  process.env.SSO_CLIENT_SECRET = 'mock-secret';

  try {
    const cfg = await ssoConfig();
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.issuer, issuer);

    const { url, verifier, state, redirectUri } = await buildAuthorizeUrl('http://sentbox.test', 'st1');
    const parsed = new URL(url);
    assert.equal(parsed.pathname, '/oauth/authorize');
    assert.equal(parsed.searchParams.get('response_type'), 'code');
    assert.equal(parsed.searchParams.get('client_id'), 'mock-client');
    assert.equal(parsed.searchParams.get('redirect_uri'), 'http://sentbox.test/auth/sso/callback');
    assert.equal(parsed.searchParams.get('state'), 'st1');
    assert.equal(parsed.searchParams.get('code_challenge_method'), 'S256');
    const challenge = parsed.searchParams.get('code_challenge');
    assert.ok(challenge);
    // 验证 code_challenge 确实是对 verifier 的 SHA256 base64url
    const crypto = await import('node:crypto');
    const expected = Buffer.from(crypto.createHash('sha256').update(verifier).digest()).toString('base64url');
    assert.equal(challenge, expected);

    const info = await exchangeCode('mock-code', verifier, redirectUri);
    assert.equal(info.sub, 'fn-user-1');
    assert.equal(info.email, 'sso@test.com');
    assert.equal(info.name, 'SSO 用户');

    // token 端点拒绝（code 无效）时应抛错
    await assert.rejects(() => exchangeCode('bad-code', verifier, redirectUri));
  } finally {
    if (savedIssuer === undefined) delete process.env.SSO_ISSUER; else process.env.SSO_ISSUER = savedIssuer;
    if (savedClientId === undefined) delete process.env.SSO_CLIENT_ID; else process.env.SSO_CLIENT_ID = savedClientId;
    if (savedSecret === undefined) delete process.env.SSO_CLIENT_SECRET; else process.env.SSO_CLIENT_SECRET = savedSecret;
    mock.close();
  }
});

test('sentbox SSO (fn-sso OIDC 授权码+PKCE) 全流程', { skip: !testDb && 'set TEST_DATABASE_URL to run PostgreSQL integration tests' }, async () => {
  process.env.NODE_ENV = 'test';
  process.env.DATABASE_URL = testDb;
  process.env.JWT_SECRET = 'test-secret';
  process.env.REFRESH_SECRET = 'test-refresh-secret';
  process.env.UPLOAD_DIR = await mkdtemp(path.join(os.tmpdir(), 'sentbox-sso-test-'));

  const mock = await startMockSso();
  const port = mock.address().port;
  process.env.SSO_ISSUER = `http://127.0.0.1:${port}`;
  process.env.SSO_CLIENT_ID = 'mock-client';
  process.env.SSO_CLIENT_SECRET = 'mock-secret';
  process.env.SSO_NAME = '飞牛测试账号';
  process.env.PUBLIC_BASE_URL = 'http://sentbox.test';

  const { buildApp } = await import('../src/index.js');
  const { resetDbForTests, closeDb } = await import('../src/db.js');
  await resetDbForTests();
  const app = await buildApp();

  try {
    // 1. 配置探测
    const cfg = await app.inject({ method: 'GET', url: '/auth/sso/config' });
    assert.equal(cfg.statusCode, 200);
    assert.equal(cfg.json().sso.enabled, true);
    assert.equal(cfg.json().sso.name, '飞牛测试账号');

    // 2. 发起授权：跳转 mock authorize，并下发 verifier/state cookie
    const start = await app.inject({ method: 'GET', url: '/auth/sso/start' });
    assert.equal(start.statusCode, 302);
    const startLocation = start.headers.location;
    assert.match(startLocation, /\/oauth\/authorize\?/);
    assert.match(startLocation, /code_challenge=/);
    assert.match(startLocation, /code_challenge_method=S256/);
    assert.match(startLocation, /redirect_uri=http%3A%2F%2Fsentbox\.test%2Fauth%2Fsso%2Fcallback/);
    const verifier = cookieFromSetCookie(start.headers['set-cookie'], 'sso_verifier');
    const state = cookieFromSetCookie(start.headers['set-cookie'], 'sso_state');
    assert.ok(verifier && state);

    // 4. 模拟 fn-sso 回调（带 state 与 verifier cookie）
    const callback = await app.inject({
      method: 'GET',
      url: `/auth/sso/callback?code=mock-code&state=${state}`,
      headers: { cookie: `sso_verifier=${verifier}; sso_state=${state}` }
    });
    assert.equal(callback.statusCode, 302);
    assert.equal(callback.headers.location, 'http://sentbox.test/?sso=1');
    const ssoAuth = cookieFromSetCookie(callback.headers['set-cookie'], 'sso_auth');
    assert.ok(ssoAuth, '回调应下发 sso_auth cookie');
    const session = JSON.parse(ssoAuth);
    assert.ok(session.accessToken && session.refreshToken);
    assert.equal(session.user.email, 'sso@test.com');
    assert.equal(session.user.hasPassword, false, '纯 SSO 账号无本地密码');
    const ssoToken = session.accessToken;

    // 5. 新会话可用：带 accessToken 拉取列表
    const items = await app.inject({
      method: 'GET',
      url: '/items',
      headers: { authorization: `Bearer ${ssoToken}` }
    });
    assert.equal(items.statusCode, 200);

    // 6. 纯 SSO 账号不能走密码登录
    const loginBlocked = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'sso@test.com', password: 'whatever123' }
    });
    assert.equal(loginBlocked.statusCode, 401);

    // 7. 隐私模式：先设置隐私密码再验证
    const setPw = await app.inject({
      method: 'POST',
      url: '/auth/privacy/set-password',
      headers: { authorization: `Bearer ${ssoToken}` },
      payload: { password: 'priv-secret-1' }
    });
    assert.equal(setPw.statusCode, 200);
    const verifyPw = await app.inject({
      method: 'POST',
      url: '/auth/privacy/verify',
      headers: { authorization: `Bearer ${ssoToken}` },
      payload: { password: 'priv-secret-1' }
    });
    assert.equal(verifyPw.statusCode, 200);
    assert.ok(verifyPw.json().privacyToken);

    // 8. 同 sub 重复登录绑到同一用户（发一条隐私内容后能读到）
    const start2 = await app.inject({ method: 'GET', url: '/auth/sso/start' });
    const state2 = cookieFromSetCookie(start2.headers['set-cookie'], 'sso_state');
    const verifier2 = cookieFromSetCookie(start2.headers['set-cookie'], 'sso_verifier');
    const callback2 = await app.inject({
      method: 'GET',
      url: `/auth/sso/callback?code=mock-code&state=${state2}`,
      headers: { cookie: `sso_verifier=${verifier2}; sso_state=${state2}` }
    });
    const session2 = JSON.parse(cookieFromSetCookie(callback2.headers['set-cookie'], 'sso_auth'));
    assert.equal(session2.user.email, 'sso@test.com', '同 sub 自动复用同一账号');

    // 9. 邮箱已有本地账号时自动绑定：注册一个用户，再用同邮箱 SSO
    const reg = await app.inject({
      method: 'POST',
      url: '/auth/register',
      payload: { email: 'bind@test.com', password: 'password123' }
    });
    const bindToken = reg.json().accessToken;
    const bindText = await app.inject({
      method: 'POST',
      url: '/items/text',
      headers: { authorization: `Bearer ${bindToken}` },
      payload: { text: 'before-bind' }
    });
    assert.equal(bindText.statusCode, 200);

    const start3 = await app.inject({ method: 'GET', url: '/auth/sso/start' });
    const state3 = cookieFromSetCookie(start3.headers['set-cookie'], 'sso_state');
    const verifier3 = cookieFromSetCookie(start3.headers['set-cookie'], 'sso_verifier');
    const callback3 = await app.inject({
      method: 'GET',
      url: `/auth/sso/callback?code=mock-code&state=${state3}`,
      headers: { cookie: `sso_verifier=${verifier3}; sso_state=${state3}` }
    });
    assert.equal(callback3.statusCode, 302);
    const session3 = JSON.parse(cookieFromSetCookie(callback3.headers['set-cookie'], 'sso_auth'));
    assert.equal(session3.user.email, 'bind@test.com', '同邮箱自动绑定到本地账号');
    const boundItems = await app.inject({
      method: 'GET',
      url: '/items',
      headers: { authorization: `Bearer ${session3.accessToken}` }
    });
    assert.deepEqual(boundItems.json().items.map((i) => i.textContent), ['before-bind'], '绑定后能看到原账号数据');

    // 10. state 校验：错误 state 拒收
    const badCallback = await app.inject({
      method: 'GET',
      url: `/auth/sso/callback?code=mock-code&state=wrong`,
      headers: { cookie: `sso_verifier=${verifier2}; sso_state=${state2}` }
    });
    assert.equal(badCallback.statusCode, 302);
    assert.match(badCallback.headers.location, /\?sso=error$/);
  } finally {
    await app.close();
    await closeDb();
    mock.close();
    await rm(process.env.UPLOAD_DIR, { recursive: true, force: true });
  }
});