import type { NextFunction, Response } from 'express';
import { verifyPassword } from './common';
import { one } from './storage';
import { asyncRoute } from './async-route';
import type { AuthedRequest } from './middleware';

const failures = new Map<number, { count: number; expiresAt: number }>();
const WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 5;

export function requireSysadmin(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'admin' || req.user.username !== 'sysadmin') {
    res.status(403).json({ success: false, error: '仅 sysadmin 管理员可执行此操作' });
    return;
  }
  next();
}

export const confirmAdminPassword = asyncRoute(async (req: AuthedRequest, res, next) => {
  const password = req.body?.password;
  if (typeof password !== 'string' || !password || password.length > 128) {
    res.status(400).json({ success: false, error: '请输入当前管理员密码' });
    return;
  }
  const id = req.user!.id;
  const row = await one<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = ? AND is_active = 1', [id],
  );
  const now = Date.now();
  const previous = failures.get(id);
  const entry = previous && previous.expiresAt > now ? previous : { count: 0, expiresAt: now + WINDOW_MS };
  if (entry.count >= MAX_FAILURES) {
    res.setHeader('Retry-After', Math.ceil((entry.expiresAt - now) / 1000));
    res.status(429).json({ success: false, error: '密码验证失败次数过多，请稍后再试' });
    return;
  }
  if (!row || !verifyPassword(password, row.password_hash)) {
    entry.count++;
    failures.set(id, entry);
    res.status(403).json({ success: false, error: '管理员密码不正确' });
    return;
  }
  failures.delete(id);
  next();
});
