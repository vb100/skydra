#!/usr/bin/env bash
# Once per project, after billing is enabled: the Terraform state bucket and the shared stack
# (APIs, Artifact Registry).
source "$(dirname "$0")/common.sh"

log "Account: $(gcloud config get-value account 2>/dev/null) / project ${PROJECT_ID}"

if gcloud storage buckets describe "gs://${STATE_BUCKET}" --project "${PROJECT_ID}" >/dev/null 2>&1; then
  log "State bucket gs://${STATE_BUCKET} exists"
else
  log "Creating state bucket gs://${STATE_BUCKET} (versioned, private)"
  gcloud storage buckets create "gs://${STATE_BUCKET}" --project "${PROJECT_ID}" \
    --location "${REGION}" --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://${STATE_BUCKET}" --versioning
fi

log "Shared stack"
tf shared init -input=false -reconfigure -backend-config="bucket=${STATE_BUCKET}"
tf shared apply -input=false
