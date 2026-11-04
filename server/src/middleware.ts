import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { one } from './storage';
import type { Role, User } from '../../shared/types';

const configuredSecret = process.env.JWT_SECRET;
if (process.env.NODE_ENV === 'production' && (!configuredSecret || Buffer.byteLength(configuredSecret) < 32)) {
  throw new Error('生产环境必须配置至少 32 字节的 JWT_SECRET');
}
const JWT_SECRET = configuredSecret || 'order-record-local-dev-secret';

export interface AuthedRequest extends Request {
  user?: User;
  authVersion?: number;
}

export async function signToken(user: User, remember = false): Promise<string> {
  const row = await one<{ auth_version: number }>('SELECT auth_version FROM users WHERE id = ?', [user.id]);
  if (!row) throw new Error('账号不存在');
  return jwt.sign({ uid: user.id, role: user.role, version: row.auth_version }, JWT_SECRET, { expiresIn: remember ? '30d' : '12h' });
}

export async function findUserById(id: number): Promise<User | undefined> {
  const row = await one<{ id: number; username: string; display_name: string; role: Role; dept_id: number | null; dept_name: string | null }>(
      `SELECT u.id, u.username, u.display_name,
              CASE WHEN a.user_id IS NOT NULL THEN 'admin' ELSE u.role END AS role,
              u.dept_id, d.name AS dept_name
       FROM users u LEFT JOIN departments d ON d.id = u.dept_id
       LEFT JOIN admin_accounts a ON a.user_id = u.id
       WHERE u.id = ? AND u.is_active = 1`,
    [id]);
  if (!row) return undefined;
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    deptId: row.dept_id ?? null,
    deptName: row.dept_name ?? null,
  };
}

/** 普通接口仅通过 Authorization 请求头验证登录令牌。 */
export async function authenticate(req: AuthedRequest, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  let token: string | undefined;
  if (header?.startsWith('Bearer ')) token = header.slice(7).trim();

  if (!token) {
    res.status(401).json({ success: false, error: '未登录或登录已过期' });
    return;
  }
  let payload: { uid: number; version?: number };
  try {
    payload = jwt.verify(token, JWT_SECRET) as { uid: number; version?: number };
  } catch {
    res.status(401).json({ success: false, error: '登录已过期，请重新登录' });
    return;
  }
  try {
    const user = await findUserById(payload.uid);
    const row = await one<{ auth_version: number }>('SELECT auth_version FROM users WHERE id = ?', [payload.uid]);
    if (!user || !row || (payload.version ?? 0) !== row.auth_version) {
      res.status(401).json({ success: false, error: '账号不可用或登录已失效，请重新登录' });
      return;
    }
    req.user = user;
    req.authVersion = row.auth_version;
    next();
  } catch (error) {
    next(error);
  }
}

/** 只读账号（viewer）不允许执行任何写入操作 */
export function requireDirector(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (req.user?.role !== 'director' && req.user?.role !== 'admin') {
    res.status(403).json({ success: false, error: '只读账号无权执行派单类操作' });
    return;
  }
  next();
}
