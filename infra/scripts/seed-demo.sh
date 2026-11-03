#!/usr/bin/env bash
# Runs the demo seed job in the demo environment and prints the activation links from its log.
# The links are one-time and expire after 72 hours; re-running issues fresh ones.
source "$(dirname "$0")/common.sh"
JOB="skydra-demo-seed-demo"

log "Running ${JOB}"
EXECUTION="$(gcloud run jobs execute "${JOB}" --project "${PROJECT_ID}" --region "${REGION}" --wait \
  --format='value(metadata.name)')"

log "Activation links (${EXECUTION})"
sleep 10 # log delivery
# Only this execution: links printed by earlier runs are revoked and would only confuse.
gcloud logging read \
  "resource.type=cloud_run_job AND resource.labels.job_name=${JOB} AND labels.\"run.googleapis.com/execution_name\"=${EXECUTION}" \
  --project "${PROJECT_ID}" --freshness=15m --order=asc --format='value(textPayload)' |
  grep -E 'activate#token=|<.*@' || echo "No links in the log yet; check the job's logs in the console."
