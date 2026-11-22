# syntax=docker/dockerfile:1
# Single image: Rust API + built React SPA (served by the same binary).

FROM node:24-alpine AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN npm run build

FROM rust:1-bookworm AS api
WORKDIR /src
# cache dependencies separately from sources
COPY backend/Cargo.toml backend/Cargo.lock ./
RUN mkdir src && echo 'fn main() {}' > src/main.rs && cargo build --release && rm -rf src target/release/kanban target/release/deps/kanban* target/release/.fingerprint/kanban-*
COPY backend/ ./
# COPY keeps old mtimes, which would make cargo think the placeholder build is still fresh
RUN touch src/main.rs && cargo build --release
# the only system library the binary needs beyond glibc; staged at its usual path (x86-64 or ARM64) for the final image
RUN mkdir -p /stage && cp --parents "$(realpath "$(gcc -print-file-name=libgcc_s.so.1)")" /stage

# Distroless without OpenSSL: only glibc, CA certificates and time-zone data. No shell, no package manager, no
# OpenSSL (TLS is done in Rust), so there is very little to patch and nothing for an intruder to use. Runs as the
# unprivileged "nonroot" user.
FROM gcr.io/distroless/base-nossl-debian12:nonroot
COPY --from=api /stage/ /
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
