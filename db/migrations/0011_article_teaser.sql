-- Arsène — teaser: a short excerpt shown only on desktop listing cards,
-- between the title/byline block and the cover thumbnail
-- (src/site/render.ts's articleCard()).
--
-- Plain text column, no CHECK constraint — same pattern as meta_title/
-- meta_description (0001_initial_schema.sql), which enforce their own
-- length caps in the API layer (router.ts's PublishBody), not the
-- database. Teaser's 250-char cap lives one layer further out still: the
-- editor's own <textarea maxlength> (frontend/src/pages/ComposePage.tsx) —
-- it's a display-only field with no publish-time contract of its own, the
-- same relationship title/body_html already have to the database.

alter table articles add column if not exists teaser text;
