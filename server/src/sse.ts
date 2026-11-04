import type { Response } from 'express';

/**
 * 极简 SSE 广播中心。
 * 需求本质是"服务端 -> 所有客户端"的单向推送（谁派了单，另外两台要立刻看到），
 * 用 SSE 而不是 WebSocket：实现更简单、浏览器自动断线重连、无需心跳保活。
 */
const clients = new Set<Response>();

export function addSseClient(res: Response): void {
  clients.add(res);
  res.on('close', () => {
    clients.delete(res);
  });
}

export function sseClientCount(): number {
  return clients.size;
}

/** 任意写操作成功后调用，通知所有在线客户端拉取最新台账 */
export function broadcastChange(scope: string): void {
  const chunk = `event: change\ndata: ${JSON.stringify({ scope, at: Date.now() })}\n\n`;
  for (const res of clients) {
    try {
      res.write(chunk);
    } catch {
      clients.delete(res);
    }
  }
}
