import { useCallback, useEffect, useState } from 'react';
import type { Patient } from '@medcare/engine';
import { get } from './api';

export interface Twin {
  id: string;
  name: string;
  data: Patient;
  createdAt?: number;
  updatedAt: number;
}

export function useTwins() {
  const [twins, setTwins] = useState<Twin[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const r = await get<{ twins: Twin[] }>('/twins');
      setTwins(r.twins);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
      setTwins([]);
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { twins, error, reload };
}
