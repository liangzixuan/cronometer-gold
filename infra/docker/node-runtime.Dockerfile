# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_SOURCE_BUILD_IMAGE=docker.io/library/python:3.12.14-bookworm@sha256:80f5d259a5969c86f6c92145d572de4a68c68e0edd28d4367dec0fb411b42af3
ARG NODE_CPP_RUNTIME_SOURCE_IMAGE=gcr.io/distroless/nodejs22-debian13:nonroot@sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167
ARG NODE_RUNTIME_BASE_IMAGE=gcr.io/distroless/base-nossl-debian13:nonroot@sha256:86554c46a420d507ff2d678fd261ab8691fba4875a20302f38a49e684b42a33f

FROM ${NODE_SOURCE_BUILD_IMAGE} AS node-build

ADD --checksum=sha256:bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb \
    https://nodejs.org/dist/v22.23.2/node-v22.23.2.tar.xz /tmp/node-v22.23.2.tar.xz
ADD --checksum=sha256:778ac5b2fcdbd68d9c0ae9f4310674faa3af0910bd0d18e7f6597787c40a3e39 \
    https://nodejs.org/dist/v22.23.2/SHASUMS256.txt /tmp/SHASUMS256.txt
ADD --checksum=sha256:169f1452c14cd653247408352f1534b9f31e3d13f9c6399c3977368095e11eda \
    https://nodejs.org/dist/v22.23.2/SHASUMS256.txt.sig /tmp/SHASUMS256.txt.sig
ADD --checksum=sha256:3b4f3ff1e9d26ca3dd75f6d98cc5d30c7dbfc03892e4bc0037a7e14bec8c5087 \
    https://github.com/openssl/openssl/commit/08e7756c3900bcfd77a720e7b74e27d6e4ed01a9.patch \
    /tmp/CVE-2026-14456.patch

COPY infra/docker/node-release-CC68F5A3106FF448322E48ED27F5E38D5B0A215F.asc /tmp/node-release-key.asc

RUN set -eux; \
    test "$(uname -m)" = aarch64; \
    test "$(sha256sum /tmp/node-release-key.asc | awk '{print $1}')" = e31e1aa40a8331f01d753cef475f7b9eab934fc25f5f0b36995bfd80bd66ad27; \
    test "$(gpg --batch --with-colons --import-options show-only --import /tmp/node-release-key.asc | awk -F: '$1 == "fpr" { print $10; exit }')" = CC68F5A3106FF448322E48ED27F5E38D5B0A215F; \
    keyring_dir="$(mktemp -d)"; \
    gpg --batch --homedir "${keyring_dir}" --import /tmp/node-release-key.asc; \
    gpgv --keyring "${keyring_dir}/pubring.kbx" --status-fd 1 \
      /tmp/SHASUMS256.txt.sig /tmp/SHASUMS256.txt > /tmp/node-signature.status; \
    test "$(grep -c '^\[GNUPG:\] VALIDSIG ' /tmp/node-signature.status)" = 1; \
    test "$(awk '$2 == "VALIDSIG" { print $3 ":" $12 }' /tmp/node-signature.status)" = CC68F5A3106FF448322E48ED27F5E38D5B0A215F:CC68F5A3106FF448322E48ED27F5E38D5B0A215F; \
    expected_checksum='bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb  node-v22.23.2.tar.xz'; \
    test "$(grep -Fxc "${expected_checksum}" /tmp/SHASUMS256.txt)" = 1; \
    cd /tmp; \
    grep -Fx "${expected_checksum}" SHASUMS256.txt | sha256sum -c -; \
    mkdir -p /usr/src/node; \
    tar -xJf /tmp/node-v22.23.2.tar.xz -C /usr/src/node --strip-components=1; \
    cd /usr/src/node; \
    test "$(grep -Fxc 'MAJOR=3' deps/openssl/openssl/VERSION.dat)" = 1; \
    test "$(grep -Fxc 'MINOR=5' deps/openssl/openssl/VERSION.dat)" = 1; \
    test "$(grep -Fxc 'PATCH=7' deps/openssl/openssl/VERSION.dat)" = 1; \
    test "$(sed -n '1s/^From \([0-9a-f]\{40\}\) .*$/\1/p' /tmp/CVE-2026-14456.patch)" = 08e7756c3900bcfd77a720e7b74e27d6e4ed01a9; \
    sed -n 's#^diff --git a/\([^ ]*\) b/.*#\1#p' /tmp/CVE-2026-14456.patch > /tmp/patch-paths.actual; \
    printf '%s\n' \
      doc/man3/SSL_get_value_uint.pod \
      include/internal/quic_port.h \
      include/openssl/ssl.h.in \
      ssl/quic/quic_impl.c \
      ssl/quic/quic_port.c \
      ssl/quic/quic_port_local.h \
      util/other.syms > /tmp/patch-paths.expected; \
    cmp /tmp/patch-paths.expected /tmp/patch-paths.actual; \
    test ! -e deps/openssl/openssl/doc/man3/SSL_get_value_uint.pod; \
    cd deps/openssl/openssl; \
    git apply --check \
      --include=include/internal/quic_port.h \
      --include=include/openssl/ssl.h.in \
      --include=ssl/quic/quic_impl.c \
      --include=ssl/quic/quic_port.c \
      --include=ssl/quic/quic_port_local.h \
      --include=util/other.syms \
      /tmp/CVE-2026-14456.patch; \
    git apply \
      --include=include/internal/quic_port.h \
      --include=include/openssl/ssl.h.in \
      --include=ssl/quic/quic_impl.c \
      --include=ssl/quic/quic_port.c \
      --include=ssl/quic/quic_port_local.h \
      --include=util/other.syms \
      /tmp/CVE-2026-14456.patch; \
    git apply --reverse --check \
      --include=include/internal/quic_port.h \
      --include=include/openssl/ssl.h.in \
      --include=ssl/quic/quic_impl.c \
      --include=ssl/quic/quic_port.c \
      --include=ssl/quic/quic_port_local.h \
      --include=util/other.syms \
      /tmp/CVE-2026-14456.patch; \
    cd /usr/src/node; \
    for header in \
      deps/openssl/config/archs/linux-aarch64/asm/include/openssl/ssl.h \
      deps/openssl/config/archs/linux-aarch64/asm_avx2/include/openssl/ssl.h \
      deps/openssl/config/archs/linux-aarch64/no-asm/include/openssl/ssl.h; do \
      test "$(grep -Fxc '#define SSL_VALUE_STREAM_WRITE_BUF_AVAIL 9' "${header}")" = 1; \
      test "$(grep -Fc 'SSL_VALUE_QUIC_MAX_PENDING_CONNS' "${header}")" = 0; \
      sed -i '/^#define SSL_VALUE_STREAM_WRITE_BUF_AVAIL 9$/a #define SSL_VALUE_QUIC_MAX_PENDING_CONNS 16' "${header}"; \
      test "$(grep -Fxc '#define SSL_VALUE_QUIC_MAX_PENDING_CONNS 16' "${header}")" = 1; \
    done; \
    ./configure --prefix=/opt/nodejs; \
    jobs="$(nproc)"; \
    case "${jobs}" in ''|*[!0-9]*) exit 1 ;; esac; \
    test "${jobs}" -ge 2; \
    make -j"${jobs}"; \
    install -D -m 0755 out/Release/node /opt/nodejs/bin/node; \
    install -D -m 0644 LICENSE /opt/nodejs/LICENSE; \
    /opt/nodejs/bin/node -e 'const assert = require("node:assert/strict"); assert.equal(process.version, "v22.23.2"); assert.equal(process.arch, "arm64"); assert.equal(process.platform, "linux"); assert.equal(process.versions.openssl, "3.5.7"); assert.equal(process.config.variables.node_shared_openssl, false); assert.equal(process.config.variables.openssl_quic, false); assert.equal(process.allowedNodeEnvironmentFlags.has("--experimental-quic"), false); assert.equal(require("node:module").builtinModules.includes("quic"), false);'; \
    test "$(nm -D /opt/nodejs/bin/node | awk '$3 == "OSSL_QUIC_server_method" { count++ } END { print count + 0 }')" = 1; \
    test "$(nm -D /opt/nodejs/bin/node | awk '$3 == "ossl_quic_port_get_max_pending_channels" { count++ } END { print count + 0 }')" = 1; \
    test "$(nm -D /opt/nodejs/bin/node | awk '$3 == "ossl_quic_port_set_max_pending_channels" { count++ } END { print count + 0 }')" = 1; \
    readelf -d /opt/nodejs/bin/node | sed -n 's/.*Shared library: \[\([^]]*\)\]/\1/p' | sort > /tmp/node-needed.actual; \
    printf '%s\n' \
      ld-linux-aarch64.so.1 \
      libc.so.6 \
      libgcc_s.so.1 \
      libm.so.6 \
      libstdc++.so.6 | sort > /tmp/node-needed.expected; \
    diff -u /tmp/node-needed.expected /tmp/node-needed.actual; \
    if grep -Eq '^lib(ssl|crypto)' /tmp/node-needed.actual; then \
      echo 'The patched Node binary unexpectedly links shared OpenSSL libraries.' >&2; \
      exit 1; \
    fi; \
    test "$(readelf -l /opt/nodejs/bin/node | sed -n 's/.*Requesting program interpreter: \([^]]*\)\].*/\1/p')" = /lib/ld-linux-aarch64.so.1

FROM ${NODE_CPP_RUNTIME_SOURCE_IMAGE} AS cxx-runtime-source

FROM ${NODE_RUNTIME_BASE_IMAGE} AS runtime

LABEL io.cronometer.runtime.component="node-runtime" \
      io.cronometer.runtime.contract="patched-node22.23.2-openssl3.5.7-08e7756-base-nossl-debian13-arm64" \
      io.cronometer.upstream.node.version="22.23.2" \
      io.cronometer.upstream.node.source="https://nodejs.org/dist/v22.23.2/node-v22.23.2.tar.xz" \
      io.cronometer.upstream.node.source.sha256="bbe768df8d5815d7fa76124052985332452e0a4742d39f32027550d1aab8f6fb" \
      io.cronometer.upstream.node.source.manifest.sha256="778ac5b2fcdbd68d9c0ae9f4310674faa3af0910bd0d18e7f6597787c40a3e39" \
      io.cronometer.upstream.node.source.manifest.signature.sha256="169f1452c14cd653247408352f1534b9f31e3d13f9c6399c3977368095e11eda" \
      io.cronometer.upstream.node.source.signature.fingerprint="CC68F5A3106FF448322E48ED27F5E38D5B0A215F" \
      io.cronometer.upstream.node.release.tag-object="490a9fef8f8adcda5a95bd6f96035b05cb43fe5b" \
      io.cronometer.upstream.node.release.commit="aa4c77582be995286fc6e00aaf530dc7ade102a9" \
      io.cronometer.upstream.node.release.signer.source.commit="43d7b8e5d41e87a3721d416f14fb86a68aeec1ce" \
      io.cronometer.upstream.node.release.signer.material.sha256="e31e1aa40a8331f01d753cef475f7b9eab934fc25f5f0b36995bfd80bd66ad27" \
      io.cronometer.upstream.openssl.version="3.5.7" \
      io.cronometer.upstream.openssl.fix.cve="CVE-2026-14456" \
      io.cronometer.upstream.openssl.fix.advisory="https://openssl-library.org/news/secadv/20260813.txt" \
      io.cronometer.upstream.openssl.fix.commit="08e7756c3900bcfd77a720e7b74e27d6e4ed01a9" \
      io.cronometer.upstream.openssl.fix.patch.sha256="3b4f3ff1e9d26ca3dd75f6d98cc5d30c7dbfc03892e4bc0037a7e14bec8c5087" \
      io.cronometer.upstream.node.builder.image="docker.io/library/python:3.12.14-bookworm" \
      io.cronometer.upstream.node.builder.image.digest="sha256:80f5d259a5969c86f6c92145d572de4a68c68e0edd28d4367dec0fb411b42af3" \
      io.cronometer.upstream.node.builder.image.arm64.digest="sha256:b6e215e1d3d8787fe1e0f1507c7d2418b16fe19acef77cf971b2d965570ced41" \
      io.cronometer.upstream.cxx.image="gcr.io/distroless/nodejs22-debian13:nonroot" \
      io.cronometer.upstream.cxx.image.digest="sha256:939d6f1671529d230f50b563578e9b5d206af58f038b10ebd7e1233023d4e167" \
      io.cronometer.upstream.cxx.image.arm64.digest="sha256:806e2fa26e3cec196e986cb206f44f07070d211c028389c79091fd440cb75882" \
      io.cronometer.upstream.base.image="gcr.io/distroless/base-nossl-debian13:nonroot" \
      io.cronometer.upstream.base.image.digest="sha256:86554c46a420d507ff2d678fd261ab8691fba4875a20302f38a49e684b42a33f" \
      io.cronometer.upstream.base.image.arm64.digest="sha256:ab7e729cfe775ce5f251b2d28b45e88b70e0582cdbadd1aa1f99a41601f11f3b" \
      io.cronometer.upstream.distroless.signature.identity="keyless@distroless.iam.gserviceaccount.com" \
      io.cronometer.upstream.distroless.signature.issuer="https://accounts.google.com"

ENV PATH=/nodejs/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ENV SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt

COPY --from=node-build /opt/nodejs/ /nodejs/
COPY --from=cxx-runtime-source /usr/lib/aarch64-linux-gnu/libgcc_s.so.1 /usr/lib/aarch64-linux-gnu/libgcc_s.so.1
COPY --from=cxx-runtime-source /usr/lib/aarch64-linux-gnu/libstdc++.so.6 /usr/lib/aarch64-linux-gnu/libstdc++.so.6
COPY --from=cxx-runtime-source /usr/lib/aarch64-linux-gnu/libstdc++.so.6.0.33 /usr/lib/aarch64-linux-gnu/libstdc++.so.6.0.33
COPY --from=cxx-runtime-source /usr/share/doc/gcc-14-base/ /usr/share/doc/gcc-14-base/
COPY --from=cxx-runtime-source /usr/share/doc/libgcc-s1 /usr/share/doc/libgcc-s1
COPY --from=cxx-runtime-source /usr/share/doc/libstdc++6 /usr/share/doc/libstdc++6
COPY --from=cxx-runtime-source /usr/share/gcc/python/libstdcxx/ /usr/share/gcc/python/libstdcxx/
COPY --from=cxx-runtime-source /usr/share/gdb/auto-load/usr/lib/aarch64-linux-gnu/libstdc++.so.6.0.33-gdb.py /usr/share/gdb/auto-load/usr/lib/aarch64-linux-gnu/libstdc++.so.6.0.33-gdb.py
COPY --from=cxx-runtime-source /usr/share/lintian/overrides/libgcc-s1 /usr/share/lintian/overrides/libgcc-s1
COPY --from=cxx-runtime-source /var/lib/dpkg/status.d/gcc-14-base /var/lib/dpkg/status.d/gcc-14-base
COPY --from=cxx-runtime-source /var/lib/dpkg/status.d/gcc-14-base.md5sums /var/lib/dpkg/status.d/gcc-14-base.md5sums
COPY --from=cxx-runtime-source /var/lib/dpkg/status.d/libgcc-s1 /var/lib/dpkg/status.d/libgcc-s1
COPY --from=cxx-runtime-source /var/lib/dpkg/status.d/libgcc-s1.md5sums /var/lib/dpkg/status.d/libgcc-s1.md5sums
COPY --from=cxx-runtime-source /var/lib/dpkg/status.d/libstdc++6 /var/lib/dpkg/status.d/libstdc++6
COPY --from=cxx-runtime-source /var/lib/dpkg/status.d/libstdc++6.md5sums /var/lib/dpkg/status.d/libstdc++6.md5sums

USER 65532:65532

ENTRYPOINT []

CMD ["/nodejs/bin/node"]
