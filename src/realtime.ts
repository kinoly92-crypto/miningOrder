import { api, ApiError, getToken } from './api/client';

type Listener = () => void;

const listeners = new Set<Listener>();
let source: EventSource | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let active = false;
let generation = 0;

export function subscribeRealtime(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function emit(): void {
  listeners.forEach((listener) => listener());
}

/**
 * 建立与后端的实时通道。任何一位主任派单/改单成功后，
 * 服务端会推一条 change 事件，所有在线页面立即重新拉取台账，
 * 三位主任看到的就是同一份数据。
 */
function retry(current: number): void {
  if (!active || current !== generation || retryTimer) return;
  retryTimer = setTimeout(() => {
    retryTimer = null;
    void openConnection(current);
  }, 3000);
}

async function openConnection(current: number): Promise<void> {
  try {
    const { ticket } = await api.post<{ ticket: string }>('/auth/events-ticket');
    if (!active || current !== generation) return;
    const next = new EventSource(`/api/events?ticket=${encodeURIComponent(ticket)}`);
    source = next;
    next.addEventListener('change', emit);
    next.onopen = emit;
    next.onerror = () => {
      next.close();
      if (source === next) source = null;
      retry(current);
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      if (current === generation) active = false;
      return;
    }
    retry(current);
  }
}

export function connectRealtime(): void {
  if (!getToken() || active) return;
  active = true;
  void openConnection(++generation);
}

export function disconnectRealtime(): void {
  active = false;
  generation++;
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = null;
  source?.close();
  source = null;
}
