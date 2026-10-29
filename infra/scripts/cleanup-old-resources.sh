#!/usr/bin/env bash
# Removes the old scraping resources from the "ESV project" (approved 2026-10-20: aruodas-* and
# domoplius-* Cloud Run services and jobs, Firestore "(default)", BigQuery dataset realestate_lt,
# buckets *-aruodas-results, aruodas service accounts).
#
# Without arguments it only lists what it found. With --execute it lists again and deletes only
# after the project id is typed back. Nothing of SkyDra (skydra-*) is ever touched.
source "$(dirname "$0")/common.sh"
OLD_REGION="europe-central2"
EXECUTE="${1:-}"

fail() { echo "Listing failed: $1. Nothing was deleted." >&2; exit 1; }
# A listing that fails must stop the script: a silently shorter list would look like "nothing left".
only() { grep -E -- "$1" || true; }

out=$(gcloud run services list --project "$PROJECT_ID" --region "$OLD_REGION" \
  --format='value(metadata.name)') || fail "Cloud Run services"
services=$(only '^(aruodas|domoplius)-' <<<"$out")
out=$(gcloud run jobs list --project "$PROJECT_ID" --region "$OLD_REGION" \
  --format='value(metadata.name)') || fail "Cloud Run jobs"
jobs=$(only '^(aruodas|domoplius)-' <<<"$out")
out=$(gcloud storage buckets list --project "$PROJECT_ID" --format='value(name)') || fail "buckets"
buckets=$(only '-aruodas-results$' <<<"$out")
out=$(gcloud iam service-accounts list --project "$PROJECT_ID" --format='value(email)') ||
  fail "service accounts"
accounts=$(only '^aruodas' <<<"$out")
out=$(bq ls --project_id="$PROJECT_ID" --format=json) || fail "BigQuery datasets"
dataset=$(python3 -c 'import json,sys; d=sys.stdin.read().strip() or "[]"; print("\n".join(x["datasetReference"]["datasetId"] for x in json.loads(d) if x["datasetReference"]["datasetId"]=="realestate_lt"))' <<<"$out")
out=$(gcloud firestore databases list --project "$PROJECT_ID" --format='value(name)') ||
  fail "Firestore databases"
firestore=$(only '/databases/\(default\)$' <<<"$out")

list() { [[ -n "$2" ]] && printf '  %s\n' $2 | sed "s/^/  [$1] /" || true; }
log "Found in ${PROJECT_ID}"
list "Cloud Run service (${OLD_REGION})" "$services"
list "Cloud Run job (${OLD_REGION})" "$jobs"
list "Bucket (with all objects)" "$buckets"
list "Service account" "$accounts"
list "BigQuery dataset (with all tables)" "$dataset"
list "Firestore database" "$firestore"

if [[ -z "$services$jobs$buckets$accounts$dataset$firestore" ]]; then
  log "Nothing to remove."
  exit 0
fi
if [[ "$EXECUTE" != "--execute" ]]; then
  log "Dry run. To delete exactly the list above: $0 --execute"
  exit 0
fi

read -r -p "This cannot be undone. Type the project id to delete the list above: " answer
[[ "$answer" == "$PROJECT_ID" ]] || { echo "Cancelled."; exit 1; }

for s in $services; do gcloud run services delete "$s" --project "$PROJECT_ID" --region "$OLD_REGION" --quiet; done
for j in $jobs; do gcloud run jobs delete "$j" --project "$PROJECT_ID" --region "$OLD_REGION" --quiet; done
for b in $buckets; do gcloud storage rm --recursive "gs://$b"; done
for a in $accounts; do gcloud iam service-accounts delete "$a" --project "$PROJECT_ID" --quiet; done
[[ -n "$dataset" ]] && bq rm -r -f --dataset "${PROJECT_ID}:realestate_lt"
[[ -n "$firestore" ]] && gcloud firestore databases delete --database='(default)' --project "$PROJECT_ID" --quiet
log "Done."
