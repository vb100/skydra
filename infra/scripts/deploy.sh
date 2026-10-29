#!/usr/bin/env bash
# Deploys one environment: build and push the image, update the migration job, run migrations,
# then roll out the service, so a new version never runs against an older schema.
#
#   infra/scripts/deploy.sh demo                      # demo.skydra.eu
#   infra/scripts/deploy.sh demo demo-runapp.tfvars   # run.app URL only
source "$(dirname "$0")/common.sh"
ENV="${1:?usage: deploy.sh demo|prod [vars-file]}"
VARS="${2:-${ENV}.tfvars}" # e.g. demo-runapp.tfvars before the domain is verified
[[ -f "${ROOT}/infra/terraform/env/${VARS}" ]] || { echo "missing infra/terraform/env/${VARS}" >&2; exit 1; }

IMAGE="$("$(dirname "$0")/build-push.sh")"

log "Terraform init (${ENV})"
tf env init -input=false -reconfigure \
  -backend-config="bucket=${STATE_BUCKET}" -backend-config="prefix=skydra/env/${ENV}"

log "Database, secrets, identities and jobs"
tf env apply -input=false -var-file="${VARS}" -var="image=${IMAGE}" \
  -target='google_cloud_run_v2_job.this'

log "Migrations"
gcloud run jobs execute "skydra-${ENV}-migrate" --project "${PROJECT_ID}" --region "${REGION}" --wait

log "Service"
tf env apply -input=false -var-file="${VARS}" -var="image=${IMAGE}"
tf env output
