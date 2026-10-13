-- Arsène — notified_at: when a writer pressed "Notification" on a published
-- article, i.e. when the mobile apps were last told about it.
--
-- Null means "never announced". The API claims it with a compare-and-set
-- (`update ... where notified_at is null`, src/api/repo.ts's
-- claimArticleNotification) *before* calling the notifications Worker, so two
-- writers pressing the button at once cannot both send a push, and clears it
-- again only if the Worker reports that nothing at all was delivered.
--
-- Deliberately absent from 0001's `grant update (...) on articles to
-- authenticated` column list: like status/slug/published_at it is written
-- only by the service-role API seam, so a writer cannot reset it through
-- PostgREST to re-send. Expand-only (02-architecture.v1.md §6).

alter table articles add column if not exists notified_at timestamptz;
