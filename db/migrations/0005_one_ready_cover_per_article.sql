-- Arsène — AC-06's "one cover per article" becomes a data-layer invariant.
--
-- 05-verification.v7.md §6 (L-V7-01, NFR-COVER-UNIQUE-01): "one cover per
-- article" was enforced nowhere but inside one handler's non-atomic
-- `demoteCurrentCover()` → `storage.put()` → `insertImage()` sequence, and the
-- e2e agent reproduced **six simultaneous `ready` cover rows on one article**
-- through ordinary concurrent uploads. `publishArticle.ts`'s `usableCover()`
-- and `render.ts`'s cover query are two independent, unordered picks over that
-- state; they agreed in every trial rather than by guarantee.
--
-- The predicate is `role = 'cover' and status = 'ready'` — the exact row shape
-- both pickers resolve, and the exact shape L-V7-01 reported duplicated — and
-- deliberately not the wider `role = 'cover'`:
--
--   * A file the upload route refuses inside the request (AC-08,
--     `isDamagedContainer`) still creates a `role='cover'`, `status='failed'`
--     row and deliberately demotes nothing (M-V4-01: a file about to be
--     rejected must not displace a cover the article can actually use). Under a
--     bare `role = 'cover'` index that ordinary, already-tested upload would
--     become a `23505` — a `500` for a writer who did nothing wrong.
--   * Nothing the upload route inserts is ever `ready` (every insert is
--     `processing` or `failed`), so this index cannot turn a concurrent burst
--     of cover uploads into `500`s either — which is the failure mode
--     `03-red-evidence.v8.md` §5.1 asked to be decided rather than overlooked.
--     See `04-green-evidence.v8.md` §5 for the full reasoning and for the one
--     residual it leaves, which `repo.setImageStatus` now absorbs.
--
-- Expand-only (02-architecture.v1.md §6): no column or table is dropped or
-- retyped; only an invariant that was already claimed is now enforced.

create unique index if not exists article_images_one_ready_cover_per_article
  on article_images (article_id)
  where role = 'cover' and status = 'ready';
