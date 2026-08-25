import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

const base64url = (buf) => Buffer.from(buf).toString('base64url');

/**
 * fn-sso（OIDC/OAuth2）客户端模块
 * 流程：Discovery → 生成 PKCE → authorize → code → token → userinfo
 */
export async function ssoConfig() {
  const issuer = (process.env.SSO_ISSUER || '').replace(/\/+$/, '');
  if (!issuer) return null;
  return {
    enabled: true,
    issuer,
    clientId: process.env.SSO_CLIENT_ID || '',
    name: process.env.SSO_NAME || '飞牛账号',
    discoveryUrl: `${issuer}/.well-known/openid-configuration`
  };
}

async function discovery() {
  const cfg = await ssoConfig();
  if (!cfg) throw new Error('sso_not_configured');
  const res = await fetch(cfg.discoveryUrl);
  if (!res.ok) throw new Error('sso_discovery_failed');
  return res.json();
}

/** 兼容标准 OIDC snake_case 与 fn-sso 的 camelCase 字段 */
function pick(doc, snakeKey, camelKey) {
  return doc[snakeKey] ?? doc[camelKey];
}

/** 生成 PKCE 与 state，返回授权跳转 URL（会话中保存 verifier 供回调使用） */
export async function buildAuthorizeUrl(redirectBase, state) {
  const cfg = await ssoConfig();
  if (!cfg) throw new Error('sso_not_configured');
  const doc = await discovery();
  const verifier = base64url(crypto.randomBytes(48));
  const challenge = base64url(crypto.createHash('sha256').update(verifier).digest());
  const redirectUri = `${redirectBase}/auth/sso/callback`;
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId,
    redirect_uri: redirectUri,
    scope: 'openid profile email',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  return {
    url: `${pick(doc, 'authorization_endpoint', 'authorizationEndpoint')}?${params}`,
    verifier,
    state,
    redirectUri
  };
}

/** 用授权码换 token 并取用户信息，返回 { sub, email, name } */
export async function exchangeCode(code, verifier, redirectUri) {
  const cfg = await ssoConfig();
  if (!cfg) throw new Error('sso_not_configured');
  const doc = await discovery();
  const tokenBody = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    client_id: cfg.clientId,
    client_secret: process.env.SSO_CLIENT_SECRET || '',
    code_verifier: verifier
  });
  const tokenRes = await fetch(pick(doc, 'token_endpoint', 'tokenEndpoint'), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: tokenBody
  });
  if (!tokenRes.ok) {
    const body = await tokenRes.text().catch(() => '');
    throw new Error(`sso_token_failed:${tokenRes.status}:${body}`);
  }
  const { access_token: accessToken } = await tokenRes.json();
  if (!accessToken) throw new Error('sso_token_missing');

  const infoRes = await fetch(pick(doc, 'userinfo_endpoint', 'userinfoEndpoint'), {
    headers: { authorization: `Bearer ${accessToken}` }
  });
  if (!infoRes.ok) throw new Error('sso_userinfo_failed');
  const info = await infoRes.json();
  if (!info.sub) throw new Error('sso_userinfo_no_sub');
  return {
    sub: String(info.sub),
    email: String(info.email || '').trim().toLowerCase(),
    emailVerified: info.email_verified === undefined ? undefined : Boolean(info.email_verified),
    name: String(info.name || info.preferred_username || '')
  };
}

/** 无本地密码的 SSO 用户：隐私密码独立存储于 privacy_hash */
export function hashPrivacyPassword(password) {
  return bcrypt.hash(password, 10);
}

export function verifyPrivacyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}