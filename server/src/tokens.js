import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';

const accessTtl = '30m';
export function signAccess(userId) {
  return jwt.sign({ sub: userId, typ: 'access' }, process.env.JWT_SECRET || 'dev-secret', { expiresIn: accessTtl });
}
export function verifyAccess(token) {
  return jwt.verify(token, process.env.JWT_SECRET || 'dev-secret');
}
export function newRefreshToken() { return randomUUID() + '.' + randomUUID(); }
