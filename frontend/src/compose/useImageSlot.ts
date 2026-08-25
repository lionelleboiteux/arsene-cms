import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.ts';
import { arseneClient } from '../lib/arseneApi.ts';

const POLL_INTERVAL_MS = 2_000;

export type ImageRow = {
  id: string;
  role: 'cover' | 'body';
  status: 'processing' | 'ready' | 'failed';
  optimized_url: string | null;
  alt_text: string | null;
  failure_message: string | null;
};

/**
 * AC-06/07/08: cover and body are separate upload slots; a failed or
 * unsupported upload never permanently blocks publish because the writer
 * can discard it (`DELETE .../images/{imageId}`, refused for `ready` rows by
 * design) and retry. Polls while any row in this slot is still `processing`
 * — uploads are always async (ADR-0004), never synchronous.
 */
export function useImageSlot(articleId: string, role: 'cover' | 'body') {
  const [images, setImages] = useState<ImageRow[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const { data } = await supabase
      .from('article_images')
      .select('id, role, status, optimized_url, alt_text, failure_message')
      .eq('article_id', articleId)
      .eq('role', role)
      .order('created_at');
    setImages((data ?? []) as ImageRow[]);
  }, [articleId, role]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!images.some((image) => image.status === 'processing')) return;
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [images, refresh]);

  const upload = useCallback(
    async (file: File) => {
      setUploading(true);
      setUploadError(null);
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const client = await arseneClient();
        await client.uploadArticleImage({
          articleId,
          idempotencyKey: crypto.randomUUID(),
          role,
          file: { filename: file.name, content_type: file.type, bytes },
        });
        await refresh();
      } catch (err) {
        setUploadError(err instanceof Error ? err.message : String(err));
      } finally {
        setUploading(false);
      }
    },
    [articleId, role, refresh],
  );

  const discard = useCallback(
    async (imageId: string) => {
      const client = await arseneClient();
      await client.discardImage({ articleId, imageId });
      await refresh();
    },
    [articleId, refresh],
  );

  const setAltText = useCallback(
    async (imageId: string, alt_text: string) => {
      await supabase.from('article_images').update({ alt_text }).eq('id', imageId);
      await refresh();
    },
    [refresh],
  );

  return { images, uploading, uploadError, upload, discard, setAltText };
}
