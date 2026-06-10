import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';

const accessSecret = () => process.env.JWT_SECRET || 'dev-secret';
const refreshSecret = () => process.env.REFRESH_SECRET || 'dev-refresh-secret';

export function signAccess(userId) {
  return jwt.sign({ sub: userId, kind: 'access' }, accessSecret(), { expiresIn: '20m' });
}

export function verifyAccess(token) {
  const payload = jwt.verify(token, accessSecret());
  if (payload.kind !== 'access') throw new Error('invalid_token_kind');
  return payload;
}

export function signPrivacy(userId) {
  return jwt.sign({ sub: userId, kind: 'privacy' }, accessSecret(), { expiresIn: '30m' });
}

export function verifyPrivacy(token, userId) {
  const payload = jwt.verify(token, accessSecret());
  if (payload.kind !== 'privacy' || payload.sub !== userId) throw new Error('invalid_privacy_token');
  return payload;
}

export function newRefreshToken() {
  return crypto.randomBytes(48).toString('base64url');
}
