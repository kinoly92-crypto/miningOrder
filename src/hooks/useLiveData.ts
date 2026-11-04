import { useCallback, useEffect, useRef, useState } from 'react';
import { subscribeRealtime } from '../realtime';

/**
 * 统一的"读数据 + 实时刷新"钩子：
 * - 首次进入拉一次
 * - 收到服务端 change 推送时静默刷新（不闪 loading）
 * - 返回 reload 供写操作成功后手动刷新
 */
export function useLiveData<T>(loader: () => Promise<T>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  const reload = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      setData(await loaderRef.current());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '数据加载失败');
    } finally {
      if (!silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
    // deps 由调用方显式声明，等价于"筛选条件变化时重新拉取"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(
    () =>
      subscribeRealtime(() => {
        void reload(true);
      }),
    [reload],
  );

  return { data, loading, error, reload };
}
