# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

FROM ${NODE_IMAGE}

ARG DEBIAN_SNAPSHOT=20260808T000000Z

RUN set -eux; \
    printf '%s\n' \
      "deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/${DEBIAN_SNAPSHOT} bookworm main" \
      > /etc/apt/sources.list; \
    rm -f /etc/apt/sources.list.d/debian.sources; \
    apt-get -o Acquire::Check-Valid-Until=false update; \
    apt-get install -y --no-install-recommends \
      awscli \
      ca-certificates \
      coreutils \
      curl \
      findutils \
      git \
      grep \
      jq \
      openssh-client \
      python3 \
      sed \
      util-linux; \
    rm -rf /var/lib/apt/lists/*; \
    groupadd --gid 10001 refunddesk-edge; \
    useradd --uid 10001 --gid 10001 --no-create-home --home-dir /tmp/home --shell /usr/sbin/nologin refunddesk-edge; \
    for command in aws bash curl git jq node python3 ssh; do command -v "${command}" >/dev/null; done

COPY --chmod=0555 deploy/lightsail/scripts/refunddesk-edge-operator.sh /usr/local/bin/refunddesk-edge-operator

# The network-enabled operator must never see the caller's repository bind:
# it may contain ignored incident inputs or unrelated untracked secrets.  Bake
# only the exact ADR0037 source allowlist into the attested image.
COPY --chmod=0444 .dockerignore /workspace/.dockerignore
COPY --chmod=0444 .github/workflows/sandbox-images.yml /workspace/.github/workflows/sandbox-images.yml
COPY --chmod=0444 deploy/lightsail/Caddyfile.public /workspace/deploy/lightsail/Caddyfile.public
COPY --chmod=0444 deploy/lightsail/compose.yml /workspace/deploy/lightsail/compose.yml
COPY --chmod=0444 deploy/lightsail/edge-operator.Dockerfile /workspace/deploy/lightsail/edge-operator.Dockerfile
COPY --chmod=0444 deploy/lightsail/edge-operator.Dockerfile.dockerignore /workspace/deploy/lightsail/edge-operator.Dockerfile.dockerignore
COPY --chmod=0555 deploy/lightsail/scripts/_common.sh /workspace/deploy/lightsail/scripts/_common.sh
COPY --chmod=0555 deploy/lightsail/scripts/observe-host-postflight.sh /workspace/deploy/lightsail/scripts/observe-host-postflight.sh
COPY --chmod=0555 deploy/lightsail/scripts/prove-bounded-edge-window.sh /workspace/deploy/lightsail/scripts/prove-bounded-edge-window.sh
COPY --chmod=0555 deploy/lightsail/scripts/recover-quiesced-runtime.sh /workspace/deploy/lightsail/scripts/recover-quiesced-runtime.sh
COPY --chmod=0555 deploy/lightsail/scripts/release.sh /workspace/deploy/lightsail/scripts/release.sh
COPY --chmod=0555 deploy/lightsail/scripts/refunddesk-edge-operator.sh /workspace/deploy/lightsail/scripts/refunddesk-edge-operator.sh
COPY --chmod=0555 deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh /workspace/deploy/lightsail/scripts/refunddesk-edge-window-watchdog.sh
COPY --chmod=0444 deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service /workspace/deploy/lightsail/systemd/refunddesk-edge-window-watchdog.service
COPY --chmod=0444 deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer /workspace/deploy/lightsail/systemd/refunddesk-edge-window-watchdog.timer
COPY --chmod=0444 docs/adr/0037-bounded-cloudfront-origin-window.md /workspace/docs/adr/0037-bounded-cloudfront-origin-window.md
COPY --chmod=0444 docs/schemas/refunddesk-edge-operator-image-v1.schema.json /workspace/docs/schemas/refunddesk-edge-operator-image-v1.schema.json
COPY --chmod=0444 docs/schemas/refunddesk-lightsail-contained-promotion-v1.schema.json /workspace/docs/schemas/refunddesk-lightsail-contained-promotion-v1.schema.json
COPY --chmod=0444 docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json /workspace/docs/schemas/refunddesk-lightsail-edge-window-v1.schema.json
COPY --chmod=0444 docs/schemas/refunddesk-lightsail-incident-admission-v1.schema.json /workspace/docs/schemas/refunddesk-lightsail-incident-admission-v1.schema.json
COPY --chmod=0444 docs/schemas/refunddesk-lightsail-postflight-v1.schema.json /workspace/docs/schemas/refunddesk-lightsail-postflight-v1.schema.json
COPY --chmod=0444 scripts/check-sandbox-images-workflow.mjs /workspace/scripts/check-sandbox-images-workflow.mjs
COPY --chmod=0444 scripts/invoke-lightsail-edge-window.ps1 /workspace/scripts/invoke-lightsail-edge-window.ps1
COPY --chmod=0444 scripts/invoke-lightsail-postflight.ps1 /workspace/scripts/invoke-lightsail-postflight.ps1
COPY --chmod=0444 scripts/submit-lightsail-edge-window-checkpoint.ps1 /workspace/scripts/submit-lightsail-edge-window-checkpoint.ps1
COPY --chmod=0444 scripts/validate-edge-operator-image.mjs /workspace/scripts/validate-edge-operator-image.mjs
COPY --chmod=0444 scripts/validate-lightsail-contained-promotion.mjs /workspace/scripts/validate-lightsail-contained-promotion.mjs
COPY --chmod=0444 scripts/validate-lightsail-edge-window.mjs /workspace/scripts/validate-lightsail-edge-window.mjs
COPY --chmod=0444 scripts/validate-lightsail-incident-admission.mjs /workspace/scripts/validate-lightsail-incident-admission.mjs
COPY --chmod=0444 scripts/validate-lightsail-postflight.mjs /workspace/scripts/validate-lightsail-postflight.mjs

ENV AWS_EC2_METADATA_DISABLED=true \
    AWS_PAGER= \
    GIT_CONFIG_GLOBAL=/dev/null \
    GIT_CONFIG_NOSYSTEM=1 \
    HOME=/tmp/home \
    LC_ALL=C \
    PAGER=cat \
    PYTHONDONTWRITEBYTECODE=1 \
    TZ=UTC

WORKDIR /workspace
USER 10001:10001
ENTRYPOINT ["/usr/local/bin/refunddesk-edge-operator"]
CMD []
