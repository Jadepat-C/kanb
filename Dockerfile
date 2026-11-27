# syntax=docker/dockerfile:1
# Single image: Rust API + built React SPA (served by the same binary).

FROM node:24-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
# the API reference shown in the app (imported as ../../../docs/api.md from /web/src/pages)
COPY docs/api.md /docs/api.md
RUN npm run build

FROM rust:1-alpine AS api
# a C toolchain for the few crates with C inside (aws-lc for TLS, mimalloc, sqlite for build-time query checks)
RUN apk add --no-cache musl-dev gcc g++ make cmake perl linux-headers file
WORKDIR /src
# cache dependencies separately from sources
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src target/release/kanban target/release/deps/kanban* target/release/.fingerprint/kanban-*
COPY backend/ ./
# shown under Admin → System; set from the git tag by the release workflow (after the dependency step, so a new
# version doesn't rebuild the dependencies)
ARG KANB_VERSION=dev
ENV KANB_VERSION=${KANB_VERSION}
# COPY keeps old mtimes, which would make cargo think the placeholder build is still fresh
RUN touch src/main.rs && cargo build --release
# Rust's musl target links everything in: one self-contained binary that needs no system C library
RUN file target/release/kanban | grep -q "static" || { file target/release/kanban; echo "kanban is not statically linked" >&2; exit 1; }

# Distroless "static": only CA certificates, time-zone data and the nonroot user. No C library (the binary has its
# own), no shell, no package manager and no OpenSSL (TLS is done in Rust), so there is almost nothing to patch and
# nothing for an intruder to use.
FROM gcr.io/distroless/static-debian13:nonroot
COPY --from=api /src/target/release/kanban /usr/local/bin/kanban
COPY --from=web /web/dist /srv/web
ENV BIND_ADDR=0.0.0.0:8080 \
    STATIC_DIR=/srv/web \
    RUST_LOG=kanban=info,tower_http=warn
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD ["/usr/local/bin/kanban", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/kanban"]
CMD ["serve"]
