import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post } from './api';

export interface User {
  id: string;
  email: string;
  name: string;
  role: 'student' | 'clinician' | 'researcher' | 'admin';
  organisation: string | null;
  totpEnabled: boolean;
  isDemo: boolean;
  createdAt: number;
}

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string, totp?: string) => Promise<User>;
  register: (data: { email: string; name: string; password: string; role: string; organisation?: string }) => Promise<User>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const refresh = useCallback(async () => {
    try {
      const r = await get<{ user: User | null }>('/auth/me');
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const login = async (email: string, password: string, totp?: string) => {
    const r = await post<{ user: User }>('/auth/login', { email, password, totp: totp || undefined });
    setUser(r.user);
    return r.user;
  };
  const register = async (data: { email: string; name: string; password: string; role: string; organisation?: string }) => {
    const r = await post<{ user: User }>('/auth/register', data);
    setUser(r.user);
    return r.user;
  };
  const logout = async () => {
    await post('/auth/logout').catch(() => undefined);
    setUser(null);
  };
  return <Ctx.Provider value={{ user, loading, login, register, logout, refresh }}>{children}</Ctx.Provider>;
}

export function useAuth() {
  const c = useContext(Ctx);
  if (!c) throw new Error('useAuth outside provider');
  return c;
}
