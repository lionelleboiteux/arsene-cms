# ADR-0004's Lambda, as a container image — the officially-recommended way
# to run `sharp` (native, platform-specific bindings) on Lambda: building
# `npm install` *inside* this exact base image resolves the correct prebuilt
# binary for Lambda's own architecture, no cross-compilation flags needed.
#
# Build from the REPO ROOT (not this directory), so the build context can
# reach both this package and the first-party conversion logic it wraps:
#   docker build --platform linux/arm64 -f lambda/imageConvert/Dockerfile -t arsene-cms-image-convert .

FROM --platform=linux/arm64 public.ecr.aws/lambda/nodejs:22 AS build

# Same relative layout as the real repo (lambda/imageConvert/ + src/images/),
# so handler.ts's own `../../src/images/...` imports resolve unmodified —
# no path rewriting, no risk of the build and the source silently diverging.
WORKDIR /build
COPY lambda/imageConvert/package.json ./lambda/imageConvert/package.json
RUN cd lambda/imageConvert && npm install

COPY src/images ./src/images
COPY lambda/imageConvert/handler.ts ./lambda/imageConvert/handler.ts

# esbuild transpiles + bundles the first-party TS into one CJS file; sharp,
# libheif-js and the AWS SDK stay external (real installed native/WASM
# modules, not inlined) since `--bundle` cannot meaningfully inline a native
# addon.
RUN cd lambda/imageConvert && npx esbuild handler.ts \
      --bundle --platform=node --format=cjs --target=node22 \
      --external:sharp --external:libheif-js --external:@aws-sdk/client-s3 \
      --outfile=/build/dist/index.js \
 && npm prune --omit=dev

FROM public.ecr.aws/lambda/nodejs:22
WORKDIR /var/task
COPY --from=build /build/dist/index.js ./index.js
COPY --from=build /build/lambda/imageConvert/node_modules ./node_modules
CMD ["index.handler"]
