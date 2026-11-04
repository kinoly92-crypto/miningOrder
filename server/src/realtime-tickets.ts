import { randomBytes } from 'node:crypto';

interface Ticket {
  userId: number;
  authVersion: number;
  expiresAt: number;
}

const tickets = new Map<string, Ticket>();
const TICKET_LIFETIME_MS = 30_000;
const MAX_TICKETS = 5_000;

export function createRealtimeTicket(userId: number, authVersion: number): string {
  const now = Date.now();
  for (const [key, ticket] of tickets) {
    if (ticket.expiresAt <= now) tickets.delete(key);
  }
  if (tickets.size >= MAX_TICKETS) throw new Error('实时连接请求过多，请稍后重试');
  const key = randomBytes(32).toString('hex');
  tickets.set(key, { userId, authVersion, expiresAt: now + TICKET_LIFETIME_MS });
  return key;
}

export function consumeRealtimeTicket(key: string): Ticket | undefined {
  if (!/^[a-f0-9]{64}$/.test(key)) return undefined;
  const ticket = tickets.get(key);
  tickets.delete(key);
  return ticket && ticket.expiresAt > Date.now() ? ticket : undefined;
}
