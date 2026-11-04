import 'dotenv/config';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authenticate, findUserById } from './middleware';
import { addSseClient } from './sse';
import { consumeRealtimeTicket } from './realtime-tickets';
import { asyncRoute } from './async-route';
import { ConflictError } from './errors';
import authRouter from './routes/auth';
import projectsRouter from './routes/projects';
import dispatchesRouter from './routes/dispatches';
import ledgerRouter from './routes/ledger';
import statsRouter from './routes/stats';
import adminRouter from './routes/admin';
import { closeStorage, one, verifyStorage } from './storage';

const app = express();
if (process.env.TRUST_PROXY === 'loopback') app.set('trust proxy', 'loopback');
else if (process.env.TRUST_PROXY && process.env.TRUST_PROXY !== 'false') {
  throw new Error('TRUST_PROXY 仅支持 loopback 或 false');
}
app.use(express.json());

app.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// 登录接口不鉴权，其余全部需要登录
app.use('/api/auth', authRouter);

/** 实时通道：任何主任派单/改单成功，服务端立刻把变更推给另外两台电脑 */
app.get('/api/events', asyncRoute(async (req, res) => {
  const ticket = typeof req.query.ticket === 'string' ? consumeRealtimeTicket(req.query.ticket) : undefined;
  if (!ticket) {
    res.status(401).json({ success: false, error: '实时连接凭据无效或已过期' });
    return;
  }
  const user = await findUserById(ticket.userId);
  const row = await one<{ auth_version: number }>('SELECT auth_version FROM users WHERE id = ?', [ticket.userId]);
  if (!user || !row || row.auth_version !== ticket.authVersion) {
    res.status(401).json({ success: false, error: '账号不可用或登录已失效' });
    return;
  }
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('event: ready\ndata: {"ok":true}\n\n');
  addSseClient(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);

  req.on('close', () => clearInterval(keepAlive));
}));

app.use('/api', authenticate, projectsRouter);
app.use('/api', authenticate, dispatchesRouter);
app.use('/api', authenticate, ledgerRouter);
app.use('/api', authenticate, statsRouter);
app.use('/api', authenticate, adminRouter);

// 已构建前端时直接托管静态资源，便于后续整体搬到内网服务器
const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ConflictError) {
    res.status(409).json({ success: false, error: err.conflict.message, conflict: err.conflict });
    return;
  }
  console.error('[server] 未处理异常：', err);
  res.status(500).json({ success: false, error: '服务器内部错误，请稍后重试' });
});

const PORT = Number(process.env.PORT ?? 3001);
verifyStorage().then(() => {
  const host = process.env.HOST?.trim();
  const onListen = () => {
    console.log(`[server] 矿业权项目派单管理平台接口已启动：http://localhost:${PORT}`);
  };
  if (host) {
    app.listen(PORT, host, onListen);
  } else {
    app.listen(PORT, onListen);
  }
}).catch(async (error: unknown) => {
  console.error('[server] 数据库连接或检查失败：', error instanceof Error ? error.message : error);
  await closeStorage().catch(() => undefined);
  process.exitCode = 1;
});
