-- Arsène — og_image_url: a second, pre-cropped derivative of a cover image,
-- built once by ADR-0004's Lambda at the same time as `optimized_url`
-- (never separately, and only for `role = 'cover'` rows — a body image has
-- no use for a social-card crop).
--
-- Fixes a real bug: WhatsApp/Facebook/Twitter's link previews were showing
-- a tiny square logo instead of a proper large-image card. The cover photo
-- itself was already being served as og:image, but at whatever aspect
-- ratio/size the writer happened to upload — Facebook in particular falls
-- back to its small-square card layout unless the image is a real 1200x630
-- (or close to that 1.91:1 ratio) *and* the page declares its width/height
-- up front. `og_image_url` is that image: `optimized_url`'s own source
-- photo, resized+cropped to exactly 1200x630 by `sharp` in the Lambda
-- (`lambda/imageConvert/handler.ts`), the same "real sharp, not the Deno
-- WASM codec" reasoning `optimized_url` itself already relies on.
--
-- Nullable, same as `optimized_url` — null until the Lambda's callback
-- reports it ready, and permanently null for any `role = 'body'` row.

alter table article_images add column if not exists og_image_url text;
