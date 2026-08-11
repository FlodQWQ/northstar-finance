import { useCallback, useEffect, useRef, useState } from "react";

export function useResource<T>(loader: () => Promise<T>) {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const requestSequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reload = useCallback(async () => {
    const requestId = ++requestSequence.current;
    setLoading(true);
    setError("");
    try {
      const result = await loader();
      if (mounted.current && requestId === requestSequence.current) setData(result);
      return result;
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "加载失败";
      if (mounted.current && requestId === requestSequence.current) setError(message);
      return null;
    } finally {
      if (mounted.current && requestId === requestSequence.current) setLoading(false);
    }
  }, [loader]);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { data, loading, error, reload, setData };
}
