# Shared settings for the deployment scripts. Every gcloud call names the project and region
# explicitly: the local gcloud default configuration points elsewhere.
set -euo pipefail

PROJECT_ID="melodic-casing-501208-a3" # "ESV project"
REGION="europe-north1"
STATE_BUCKET="${PROJECT_ID}-tfstate"
REPOSITORY="${REGION}-docker.pkg.dev/${PROJECT_ID}/skydra"
TERRAFORM_IMAGE="hashicorp/terraform:1.13"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Progress goes to stderr, so scripts can return values on stdout (build-push.sh: the image).
log() { printf '\n\033[1m==> %s\033[0m\n' "$*" >&2; }

# Terraform runs in its official container with a short-lived access token of the signed-in
# gcloud account, so nothing is installed locally and no key files exist.
tf() {
  local dir="$1"
  shift
  local tty=()
  [[ -t 0 ]] && tty=(-t) # plans are shown and confirmed interactively
  docker run --rm -i ${tty[@]+"${tty[@]}"} \
    -e GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)" \
    -v "${ROOT}/infra/terraform:/w" -w "/w/${dir}" \
    "${TERRAFORM_IMAGE}" "$@"
}
