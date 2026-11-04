import { Router } from 'express';
import { hashPassword, verifyPassword } from '../common';
import { execute, one } from '../storage';
import { asyncRoute } from '../async-route';
import { authenticate, findUserById, signToken, type AuthedRequest } from '../middleware';
import { writeAudit } from '../audit';
import { inTransaction } from '../errors';
import { limitLoginAttempts } from '../login-limiter';
import { createRealtimeTicket } from '../realtime-tickets';

const router = Router();

router.post('/login', limitLoginAttempts, asyncRoute(async (req, res) => {
  const { username, password, remember } = (req.body ?? {}) as { username?: unknown; password?: unknown; remember?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || username.length > 64 || !password || password.length > 128) {
    res.status(400).json({ success: false, error: '请输入账号和密码' });
    return;
  }
  const row = await one<{ id: number; password_hash: string }>(
    'SELECT id, password_hash FROM users WHERE username = ? AND is_active = 1', [username.trim()],
  );

  if (!row || !verifyPassword(password, row.password_hash)) {
    res.status(401).json({ success: false, error: '账号或密码不正确' });
    return;
  }
  const user = (await findUserById(row.id))!;
  await writeAudit({ user, action: 'login', targetType: 'user', targetId: user.id, detail: `${user.displayName} 登录系统` });
  res.json({ success: true, data: { token: await signToken(user, remember === true), user, mustChangePassword: user.mustChangePassword } });
}));

router.get('/me', authenticate, (req: AuthedRequest, res) => {
  res.json({ success: true, data: req.user });
});

router.post('/events-ticket', authenticate, (req: AuthedRequest, res) => {
  const ticket = createRealtimeTicket(req.user!.id, req.authVersion!);
  res.json({ success: true, data: { ticket } });
});

router.patch('/account', authenticate, asyncRoute(async (req: AuthedRequest, res) => {
  const { username, currentPassword, newPassword } = (req.body ?? {}) as {
    username?: unknown;
    currentPassword?: unknown;
    newPassword?: unknown;
  };
  const nextUsername = typeof username === 'string' ? username.trim() : '';
  if (!/^[a-zA-Z0-9_]{3,32}$/.test(nextUsername)) {
    res.status(400).json({ success: false, error: '账号须为 3 至 32 位英文字母、数字或下划线' });
    return;
  }
  if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 128) {
    res.status(400).json({ success: false, error: '请输入当前密码' });
    return;
  }
  if (newPassword !== undefined && (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128)) {
    res.status(400).json({ success: false, error: '新密码须为 6 至 128 位' });
    return;
  }
  const user = req.user!;
  const row = await one<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = ? AND is_active = 1', [user.id],
  );
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(400).json({ success: false, error: '当前密码不正确' });
    return;
  }
  if (nextUsername === user.username && newPassword === undefined) {
    res.status(400).json({ success: false, error: '账号和密码均未更改' });
    return;
  }
  if (await one('SELECT id FROM users WHERE username = ? AND id <> ?', [nextUsername, user.id])) {
    res.status(409).json({ success: false, error: '该账号已被使用' });
    return;
  }

  await inTransaction(async () => {
    await execute('UPDATE users SET username = ?, password_hash = ?, auth_version = auth_version + 1, must_change_password = ? WHERE id = ?', [
      nextUsername,
      typeof newPassword === 'string' ? hashPassword(newPassword) : row.password_hash,
      typeof newPassword === 'string' ? 0 : user.mustChangePassword ? 1 : 0,
      user.id,
    ]);
    await writeAudit({
      user,
      action: 'update-account',
      targetType: 'user',
      targetId: user.id,
      detail: `${user.displayName} 修改了${nextUsername !== user.username ? '登录账号' : ''}${nextUsername !== user.username && newPassword ? '和' : ''}${newPassword ? '密码' : ''}`,
    });
  });
  res.json({ success: true, data: { message: '修改成功，请重新登录' } });
}));

router.post('/change-password', authenticate, asyncRoute(async (req: AuthedRequest, res) => {
  const { currentPassword, newPassword } = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
  if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 128) {
    res.status(400).json({ success: false, error: '请输入当前密码' });
    return;
  }
  if (typeof newPassword !== 'string' || newPassword.length < 6 || newPassword.length > 128) {
    res.status(400).json({ success: false, error: '新密码须为 6 至 128 位' });
    return;
  }
  const user = req.user!;
  const row = await one<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = ? AND is_active = 1', [user.id],
  );
  if (!row || !verifyPassword(currentPassword, row.password_hash)) {
    res.status(400).json({ success: false, error: '当前密码不正确' });
    return;
  }
  await inTransaction(async () => {
    await execute(
      'UPDATE users SET password_hash = ?, must_change_password = 0, auth_version = auth_version + 1 WHERE id = ?',
      [hashPassword(newPassword), user.id],
    );
    await writeAudit({
      user,
      action: 'update-account',
      targetType: 'user',
      targetId: user.id,
      detail: `${user.displayName} 修改了初始密码`,
    });
  });
  res.json({ success: true, data: { message: '密码已修改，请重新登录' } });
}));

export default router;
