import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient.ts';
import { arseneClient } from '../lib/arseneApi.ts';

export type ActiveWriter = { id: string; display_name: string };

type AuthorRow = { writer_id: string; ordinal: number };

/**
 * The compose page's co-author picker. `article_authors` itself is managed
 * with direct PostgREST (matching `useDraft.ts`'s own `persistFields` —
 * RLS on the table already allows any active writer,
 * `db/migrations/0009_article_authors.sql`), but the writer list to pick
 * *from* has to go through the server (`GET /v1/writers`): `writers` itself
 * is unreadable via direct PostgREST since 0008.
 */
export function useCoAuthors(articleId: string) {
  const [activeWriters, setActiveWriters] = useState<ActiveWriter[]>([]);
  const [authors, setAuthors] = useState<AuthorRow[]>([]);

  const refresh = useCallback(async () => {
    const client = await arseneClient();
    const writersResult = (await client.listActiveWriters()) as { writers: ActiveWriter[] };
    setActiveWriters(writersResult.writers);

    const { data } = await supabase
      .from('article_authors')
      .select('writer_id, ordinal')
      .eq('article_id', articleId)
      .order('ordinal');
    setAuthors((data ?? []) as AuthorRow[]);
  }, [articleId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const nameOf = useCallback(
    (writerId: string): string =>
      activeWriters.find((w) => w.id === writerId)?.display_name ?? 'Rédacteur inconnu',
    [activeWriters],
  );

  const currentAuthors = authors.map((a) => ({ id: a.writer_id, display_name: nameOf(a.writer_id) }));
  const availableToAdd = activeWriters.filter((w) => !authors.some((a) => a.writer_id === w.id));

  const addAuthor = useCallback(
    async (writerId: string): Promise<void> => {
      // Best-effort next ordinal, not a hard invariant — 0009's own comment
      // has the full reasoning (no unique(article_id, ordinal), so a race
      // on two simultaneous adds is a harmless ordering tie, not a failure).
      const nextOrdinal = authors.reduce((max, a) => Math.max(max, a.ordinal), 0) + 1;
      const { error } = await supabase
        .from('article_authors')
        .insert({ article_id: articleId, writer_id: writerId, ordinal: nextOrdinal });
      if (error !== null) throw new Error(error.message);
      setAuthors((prev) => [...prev, { writer_id: writerId, ordinal: nextOrdinal }]);
    },
    [articleId, authors],
  );

  /** Refuses (no request made) to remove the last remaining author — an
   *  article credited to nobody isn't a state the picker should be able to
   *  reach. Nothing in the database enforces this (0009 has no such
   *  constraint), so the guard lives here. */
  const removeAuthor = useCallback(
    async (writerId: string): Promise<boolean> => {
      if (authors.length <= 1) return false;
      const { error } = await supabase
        .from('article_authors')
        .delete()
        .eq('article_id', articleId)
        .eq('writer_id', writerId);
      if (error !== null) throw new Error(error.message);
      setAuthors((prev) => prev.filter((a) => a.writer_id !== writerId));
      return true;
    },
    [articleId, authors],
  );

  return { currentAuthors, availableToAdd, addAuthor, removeAuthor };
}
