import type { RequestHandler } from 'express';

const WINDOW_MS = 10 * 60_000;
const MAX_ATTEMPTS = 30;
const MAX_ADDRESSES = 10_000;
const attempts = new Map<string, { count: number; expiresAt: number }>();

export const limitLoginAttempts: RequestHandler = (req, res, next) => {
  const now = Date.now();
  const address = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  let entry = attempts.get(address);
  if (!entry || entry.expiresAt <= now) {
    if (!entry && attempts.size >= MAX_ADDRESSES) {
      const oldest = attempts.keys().next().value;
      if (oldest) attempts.delete(oldest);
    }
    entry = { count: 0, expiresAt: now + WINDOW_MS };
    attempts.delete(address);
    attempts.set(address, entry);
  }
  if (entry.count >= MAX_ATTEMPTS) {
    res.setHeader('Retry-After', Math.ceil((entry.expiresAt - now) / 1000));
    res.status(429).json({ success: false, error: '登录尝试过多，请稍后再试' });
    return;
  }
  entry.count++;
  next();
};
