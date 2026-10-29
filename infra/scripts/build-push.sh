#!/usr/bin/env bash
# Builds the application image for Cloud Run (linux/amd64) from a clean checkout and pushes it,
# tagged with the commit. Prints the image reference.
source "$(dirname "$0")/common.sh"
cd "${ROOT}"

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Working tree is not clean: commit first, so the image matches a commit." >&2
  exit 1
fi
TAG="$(git rev-parse --short=12 HEAD)"
IMAGE="${REPOSITORY}/skydra:${TAG}"

log "Registry login (short-lived token)"
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "https://${REGION}-docker.pkg.dev" >/dev/null

log "Building and pushing ${IMAGE}"
docker buildx build --platform linux/amd64 --provenance=false -t "${IMAGE}" --push . >&2
echo "${IMAGE}"
