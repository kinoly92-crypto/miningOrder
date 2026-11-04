import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api, getToken, setToken } from '../api/client';
import { connectRealtime, disconnectRealtime } from '../realtime';
import type { User } from '../../shared/types';

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  mustChangePassword: boolean;
  login: (username: string, password: string, remember: boolean) => Promise<User>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [mustChangePassword, setMustChangePassword] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      if (!getToken()) {
        setLoading(false);
        return;
      }
      try {
        const me = await api.get<User>('/auth/me');
        if (cancelled) return;
        setUser(me);
        connectRealtime();
      } catch {
        setToken(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (username: string, password: string, remember: boolean) => {
    const data = await api.post<{ token: string; user: User; mustChangePassword: boolean }>('/auth/login', { username, password, remember });
    setToken(data.token, remember);
    setMustChangePassword(data.mustChangePassword);
    if (!data.mustChangePassword) {
      setUser(data.user);
      connectRealtime();
    }
    return data.user;
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    await api.post('/auth/change-password', { currentPassword, newPassword });
    setToken(null);
    setUser(null);
    setMustChangePassword(false);
  }, []);

  const logout = useCallback(() => {
    disconnectRealtime();
    setToken(null);
    setUser(null);
    setMustChangePassword(false);
  }, []);

  const value = useMemo(() => ({ user, loading, mustChangePassword, login, changePassword, logout }), [user, loading, mustChangePassword, login, changePassword, logout]);

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth 必须在 AuthProvider 内部使用');
  return ctx;
}
