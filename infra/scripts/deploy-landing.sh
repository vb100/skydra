#!/usr/bin/env bash
# Builds the marketing site image (apps/landing) from a clean checkout, pushes it tagged with the
# commit and rolls out the skydra-landing Cloud Run service.
#
#   infra/scripts/deploy-landing.sh
source "$(dirname "$0")/common.sh"
cd "${ROOT}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean: commit first, so the image matches a commit." >&2
  exit 1
fi
IMAGE="${REPOSITORY}/skydra-landing:$(git rev-parse --short=12 HEAD)"

log "Registry login (short-lived token)"
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://${REGION}-docker.pkg.dev" >/dev/null

log "Building and pushing ${IMAGE}"
docker buildx build --platform linux/amd64 --provenance=false -t "${IMAGE}" --push apps/landing >&2

log "Terraform (landing)"
tf landing init -input=false -reconfigure -backend-config="bucket=${STATE_BUCKET}"
tf landing apply -input=false -var="image=${IMAGE}"
tf landing output
