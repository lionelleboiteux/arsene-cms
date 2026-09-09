import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.ts';
import { arseneClient } from '../lib/arseneApi.ts';

const POLL_INTERVAL_MS = 2_000;

export type AvatarRow = {
  id: string;
  status: 'processing' | 'ready' | 'failed';
  optimized_url: string | null;
  failure_message: string | null;
};

/**
 * Mirrors `useImageSlot.ts` — the same async-upload/poll-while-processing
 * shape (ADR-0004) — but for the caller's own `writer_avatars` (0010) row
 * instead of one article's images. RLS on `writer_avatars` is self-scoped
 * (`writer_id = auth.uid()`), so the plain select below already returns only
 * the signed-in writer's own rows, with no `articleId`/`role` to filter by.
 */
export function useAvatarUpload() {
  const [current, setCurrent] = useState<AvatarRow | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('writer_avatars')
      .select('id, status, optimized_url, failure_message')
      .order('created_at', { ascending: false })
      .limit(1);
    setCurrent(((data ?? [])[0] as AvatarRow | undefined) ?? null);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (current?.status !== 'processing') return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [current, refresh]);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const client = await arseneClient();
        await client.uploadAvatar({ file: { filename: file.name, content_type: file.type, bytes } });
        await refresh();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [refresh],
  );

  return { current, uploading, uploadError, upload };
}
