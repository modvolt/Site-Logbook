#!/bin/sh
set -eu

fail() {
  echo "STAGING PREFLIGHT FAILED: $1" >&2
  exit 1
}

[ "$STAGING_ENVIRONMENT_ID" = "site-logbook-staging" ] || fail "unexpected environment id"
case "$STAGING_COMPOSE_PROJECT_NAME" in
  site-logbook-staging|site-logbook-staging-*) ;;
  *) fail "compose project name must use the site-logbook-staging namespace" ;;
esac
case "$STAGING_PUBLIC_APP_URL" in
  https://*) staging_authority=${STAGING_PUBLIC_APP_URL#https://} ;;
  *) fail "public origin must be one bare HTTPS origin" ;;
esac
case "$staging_authority" in
  ''|*/*|*' '*|*"	"*) fail "public origin must be one bare HTTPS origin" ;;
esac
case "$staging_authority" in
  *:*)
    staging_host=${staging_authority%%:*}
    staging_port=${staging_authority#*:}
    case "$staging_port" in ''|*[!0-9]*) fail "origin port must be numeric" ;; esac
    ;;
  *) staging_host=$staging_authority ;;
esac
case "$staging_host" in
  ''|*[!a-z0-9.-]*) fail "origin hostname contains forbidden characters" ;;
esac
case "$staging_host" in
  modvoltapp.cz|*.modvoltapp.cz|localhost|*.localhost|127.*|0.0.0.0)
    fail "production or loopback origin is forbidden"
    ;;
esac

[ "$STAGING_NGINX_SERVER_NAME" = "$staging_host" ] \
  || fail "nginx host must exactly match the staging origin"
. /usr/local/lib/staging-proxy-cidrs.sh
[ "${#STAGING_BUILD_SHA}" -eq 40 ] \
  || fail "build SHA must be 40 lowercase hexadecimal characters"
case "$STAGING_BUILD_SHA" in *[!0-9a-f]*) fail "build SHA must be 40 lowercase hexadecimal characters" ;; esac
[ "${#STAGING_IMAGE_MANIFEST_SOURCE_SHA}" -eq 40 ] \
  || fail "image manifest source SHA must be 40 lowercase hexadecimal characters"
case "$STAGING_IMAGE_MANIFEST_SOURCE_SHA" in *[!0-9a-f]*) fail "image manifest source SHA must be 40 lowercase hexadecimal characters" ;; esac
[ "$STAGING_IMAGE_MANIFEST_SOURCE_SHA" = "$STAGING_BUILD_SHA" ] \
  || fail "image manifest source SHA must match the deployed build SHA"
validate_sha256_hex() {
  [ "${#1}" -eq 64 ] \
    || fail "$2 must be 64 lowercase hexadecimal characters"
  case "$1" in *[!0-9a-f]*) fail "$2 must be 64 lowercase hexadecimal characters" ;; esac
}
validate_sha256_hex "$STAGING_IMAGE_MANIFEST_SHA256" STAGING_IMAGE_MANIFEST_SHA256
validate_sha256_hex "$STAGING_PROVISIONING_MANIFEST_SHA256" STAGING_PROVISIONING_MANIFEST_SHA256
validate_sha256_hex "$STAGING_DEPLOYMENT_INPUTS_SHA256" STAGING_DEPLOYMENT_INPUTS_SHA256
[ "$STAGING_EXTERNAL_ACCOUNTS_ENABLED" = "false" ] \
  || fail "external accounts must stay explicitly disabled during the dark rollout"

validate_backup_binding() {
  case "$STAGING_BACKUP_EVIDENCE_ID" in ''|*[!0-9]*|0) fail "backup evidence id must be a positive integer" ;; esac
  case "$STAGING_BACKUP_RESTORE_MAX_AGE_HOURS" in ''|*[!0-9]*) fail "backup restore maximum age must be an integer from 1 through 168" ;; esac
  [ "$STAGING_BACKUP_RESTORE_MAX_AGE_HOURS" -ge 1 ] 2>/dev/null \
    && [ "$STAGING_BACKUP_RESTORE_MAX_AGE_HOURS" -le 168 ] 2>/dev/null \
    || fail "backup restore maximum age must be an integer from 1 through 168"
}

case "$STAGING_SCHEMA_ACTION" in
  inspect)
    [ -z "$STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION" ] \
      || fail "inspect mode forbids a mutation confirmation"
    validate_backup_binding
    ;;
  apply-0105)
    [ "$STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION" = "APPLY_0105_TO_ISOLATED_SITE_LOGBOOK_STAGING" ] \
      || fail "the exact isolated 0105 staging confirmation is required"
    validate_backup_binding
    ;;
  steady-0105)
    [ -z "$STAGING_EXTERNAL_SCHEMA_PREFLIGHT_CONFIRMATION" ] \
      || fail "steady mode forbids retaining a mutation confirmation"
    [ -z "$STAGING_BACKUP_EVIDENCE_ID" ] \
      && [ -z "$STAGING_BACKUP_RESTORE_MAX_AGE_HOURS" ] \
      || fail "steady mode must not depend on historical transition backup evidence"
    ;;
  *) fail "schema action must be inspect, apply-0105 or steady-0105" ;;
esac

validate_immutable_image() {
  image_ref=$1
  label=$2
  case "$image_ref" in
    *@sha256:*) ;;
    *) fail "$label must use repository@sha256:<64 lowercase hex>" ;;
  esac
  image_repository=${image_ref%@sha256:*}
  image_digest=${image_ref##*@sha256:}
  case "$image_repository" in
    ''|*' '*|*'@'*|*://*) fail "$label repository is invalid" ;;
  esac
  [ "${#image_digest}" -eq 64 ] \
    || fail "$label digest must be 64 lowercase hexadecimal characters"
  case "$image_digest" in
    *[!0-9a-f]*) fail "$label digest must be 64 lowercase hexadecimal characters" ;;
  esac
}
validate_immutable_image "$STAGING_PREFLIGHT_IMAGE" STAGING_PREFLIGHT_IMAGE
validate_immutable_image "$STAGING_MAILPIT_IMAGE" STAGING_MAILPIT_IMAGE
validate_immutable_image "$STAGING_API_IMAGE" STAGING_API_IMAGE
validate_immutable_image "$STAGING_WEB_IMAGE" STAGING_WEB_IMAGE
validate_immutable_image "$STAGING_ALERT_RECEIVER_IMAGE" STAGING_ALERT_RECEIVER_IMAGE
unset image_ref label image_repository image_digest

[ "${#STAGING_IMAGE_MANIFEST_B64}" -le 180000 ] \
  || fail "image manifest base64 exceeds the bounded runtime size"
manifest_file="/tmp/staging-images.$$"
trap 'rm -f "$manifest_file"' EXIT HUP INT TERM
printf '%s' "$STAGING_IMAGE_MANIFEST_B64" | base64 -d >"$manifest_file" 2>/dev/null \
  || fail "image manifest base64 is invalid"
manifest_sha256=$(sha256sum "$manifest_file" | awk '{print $1}')
[ "$manifest_sha256" = "$STAGING_IMAGE_MANIFEST_SHA256" ] \
  || fail "image manifest bytes do not match the approved checksum"
registry_ledger=$(jq -cS '.registryLedger' "$manifest_file")
registry_ledger_sha256="sha256:$(printf '%s' "$registry_ledger" | sha256sum | awk '{print $1}')"
[ "$registry_ledger_sha256" = "$(jq -r '.deletedHistoryControl.ledgerEntrySha256' "$manifest_file")" ] \
  || fail "embedded registry ledger does not match its canonical checksum"
jq -e \
  --arg sourceSha "$STAGING_BUILD_SHA" \
  --arg preflight "$STAGING_PREFLIGHT_IMAGE" \
  --arg mailpit "$STAGING_MAILPIT_IMAGE" \
  --arg api "$STAGING_API_IMAGE" \
  --arg web "$STAGING_WEB_IMAGE" \
  --arg alertReceiver "$STAGING_ALERT_RECEIVER_IMAGE" \
  '
    def verified_package($name; $repository; $source; $digest; $env; $dockerfile; $buildArg; $bases):
      .packageName == $name and
      (.packageId | type == "string" and test("^[1-9][0-9]*$")) and
      .visibility == "private" and
      .repository == "modvolt/site-logbook-registry" and
      .registryRepository == $repository and
      .sourceSha == $source and
      (.versionId | type == "string" and test("^[1-9][0-9]*$")) and
      .digest == $digest and
      (.runnableManifestDigest | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
      .platform == "linux/amd64" and
      .activeInventoryPaginated == true and
      (.activeVersionCount | type) == "number" and .activeVersionCount >= 1 and
      .packageVersionCount == .activeVersionCount and
      .deletedInventoryMode == "not-queryable-exact-read-scope" and
      .visibleDeletedTagConflictChecked == false and .deletedVersionCount == null and
      .deletedHistoryScope == "external-audit-ledger-only" and
      .selectedVersionRefetched == true and .remoteManifestVerified == true and
      .runtimeMetadata == {source: "https://github.com/modvolt/Site-Logbook", revision: $source, url: ("https://github.com/modvolt/Site-Logbook/commit/" + $source), buildSha: $source, buildShaEnv: $env} and
      .provenance.buildType == "https://mobyproject.org/buildkit@v1" and
      .provenance.vcsRevision == $source and .provenance.dockerfile == $dockerfile and
      .provenance.buildArg == $buildArg and .provenance.buildSha == $source and
      .provenance.verifiedBaseImageDigests == $bases and
      (.provenance.vcsSource | ascii_downcase | test("^(https://github\\.com/modvolt/site-logbook(?:\\.git)?|git\\+https://github\\.com/modvolt/site-logbook(?:\\.git)?|git@github\\.com:modvolt/site-logbook\\.git)$")) and
      (.sbom.spdxVersion == "SPDX-2.2" or .sbom.spdxVersion == "SPDX-2.3") and
      (.sbom.packageCount | type) == "number" and .sbom.packageCount > 0 and
      (.sbom.relationshipCount | type) == "number" and .sbom.relationshipCount > 0;
    (keys == ["callerRepository", "callerWorkflowRef", "deletedHistoryControl", "images", "initialPackageState", "kind", "packages", "publicationStage", "publisherRun", "registryAction", "registryLedger", "schemaVersion", "sourceSha", "toolchain"]) and
    .schemaVersion == 3 and
    .kind == "site-logbook-staging-images" and .publicationStage == "complete" and
    .sourceSha == $sourceSha and
    .callerRepository == "modvolt/site-logbook-registry" and
    (.callerWorkflowRef | type == "string" and length > 0) and
    ((.initialPackageState == "10000" and .registryAction == "published") or
     (.initialPackageState == "11111" and .registryAction == "verified-noop")) and
    (.publisherRun.id | type == "string" and test("^[1-9][0-9]*$")) and
    .publisherRun.attempt == "1" and
    (.deletedHistoryControl | keys) == ["callerWorkflowSha", "decision", "deletedApiQueried", "ledgerEntrySha256", "mode", "visibleRunUniquenessVerified", "workflowRunHistoryScope"] and
    .deletedHistoryControl.mode == "reviewed-caller-visible-history-ledger" and
    .deletedHistoryControl.decision == "explicitly-accepted-external-ledger" and
    (.deletedHistoryControl.ledgerEntrySha256 | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
    (.deletedHistoryControl.callerWorkflowSha | type == "string" and test("^[0-9a-f]{40}$") and (test("^0{40}$") | not)) and
    .deletedHistoryControl.visibleRunUniquenessVerified == true and
    .deletedHistoryControl.workflowRunHistoryScope == "github-visible-workflow-runs-below-1000-api-cap" and
    .deletedHistoryControl.deletedApiQueried == false and
    (.registryLedger | keys) == ["deletedHistoryControl", "expectedInitialPackageState", "kind", "packageNames", "previousEntry", "schemaVersion", "sourceSha", "stage"] and
    .registryLedger.schemaVersion == 1 and .registryLedger.kind == "site-logbook-staging-registry-ledger-entry" and
    .registryLedger.sourceSha == $sourceSha and .registryLedger.stage == "complete" and
    .registryLedger.expectedInitialPackageState == .initialPackageState and
    .registryLedger.packageNames == ["site-logbook-staging-preflight", "site-logbook-staging-mailpit", "site-logbook-staging-api", "site-logbook-staging-web", "site-logbook-staging-alert-receiver"] and
    .registryLedger.deletedHistoryControl == {mode: "reviewed-caller-visible-history-ledger", decision: "explicitly-accepted-external-ledger", deletedApiQueried: false, historicalAbsenceProven: false} and
    (.registryLedger.previousEntry | keys) == ["ledgerEntrySha256", "preflightDigest"] and
    (.registryLedger.previousEntry.ledgerEntrySha256 | type == "string" and test("^sha256:[0-9a-f]{64}$")) and
    .registryLedger.previousEntry.preflightDigest == (.images.preflight | split("@")[1]) and
    .toolchain == {buildx: "v0.34.1", buildkitImage: "moby/buildkit:v0.30.0@sha256:0168606be2315b7c807a03b3d8aa79beefdb31c98740cebdffdfeebf31190c9f"} and
    (.images | keys) == ["alertReceiver", "api", "mailpit", "preflight", "web"] and
    (.packages | keys) == ["alertReceiver", "api", "mailpit", "preflight", "web"] and
    .images.preflight == $preflight and
    .images.mailpit == $mailpit and
    .images.api == $api and
    .images.web == $web and
    .images.alertReceiver == $alertReceiver and
    (.packages.preflight | verified_package("site-logbook-staging-preflight"; "ghcr.io/modvolt/site-logbook-staging-preflight"; $sourceSha; ($preflight | split("@")[1]); "BUILD_SHA"; "deploy/staging/preflight/Dockerfile"; "BUILD_SHA"; ["sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1"])) and
    (.packages.mailpit | verified_package("site-logbook-staging-mailpit"; "ghcr.io/modvolt/site-logbook-staging-mailpit"; $sourceSha; ($mailpit | split("@")[1]); "BUILD_SHA"; "deploy/staging/mailpit/Dockerfile"; "BUILD_SHA"; ["sha256:0059ef81e492a7192af3816281eed6859eb078bd7bdc58b76757c13e10e53a7d", "sha256:4bcff63911fcb4448bd4fdacec207030997caf25e9bea4045fa6c8c44de311d1"])) and
    (.packages.api | verified_package("site-logbook-staging-api"; "ghcr.io/modvolt/site-logbook-staging-api"; $sourceSha; ($api | split("@")[1]); "BUILD_SHA"; "artifacts/api-server/Dockerfile"; "BUILD_SHA"; ["sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7"])) and
    (.packages.web | verified_package("site-logbook-staging-web"; "ghcr.io/modvolt/site-logbook-staging-web"; $sourceSha; ($web | split("@")[1]); "VITE_BUILD_SHA"; "artifacts/stavba/Dockerfile"; "VITE_BUILD_SHA"; ["sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7", "sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10"])) and
    (.packages.alertReceiver | verified_package("site-logbook-staging-alert-receiver"; "ghcr.io/modvolt/site-logbook-staging-alert-receiver"; $sourceSha; ($alertReceiver | split("@")[1]); "RECEIVER_BUILD_SHA"; "deploy/operational-alert-receiver/Dockerfile"; "BUILD_SHA"; ["sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7"]))
  ' "$manifest_file" >/dev/null \
  || fail "image manifest is not the exact complete private amd64 package set"
rm -f "$manifest_file"
trap - EXIT HUP INT TERM
unset manifest_file manifest_sha256

validate_hex_secret() {
  [ "${#1}" -eq 64 ] || fail "$2 must be 32-byte lowercase hex"
  case "$1" in *[!0-9a-f]*) fail "$2 must be 32-byte lowercase hex" ;; esac
}
validate_hex_secret "$STAGING_POSTGRES_PASSWORD" STAGING_POSTGRES_PASSWORD
validate_hex_secret "$STAGING_SESSION_SECRET" STAGING_SESSION_SECRET

case "$STAGING_OPERATIONAL_ALERT_RECEIVER_URL" in
  https://*/v1/operational-alerts)
    alert_receiver_authority=${STAGING_OPERATIONAL_ALERT_RECEIVER_URL#https://}
    alert_receiver_authority=${alert_receiver_authority%/v1/operational-alerts}
    ;;
  *) fail "operational alert receiver must use HTTPS and the exact /v1/operational-alerts path" ;;
esac
case "$alert_receiver_authority" in
  ''|*/*|*@*|*:*|*[[:space:]]*|*'?'*|*'#'*)
    fail "operational alert receiver must use one bare public hostname"
    ;;
esac
case "$alert_receiver_authority" in
  *[!a-z0-9.-]*) fail "operational alert receiver hostname contains forbidden characters" ;;
esac
case "$alert_receiver_authority" in
  *.*) ;;
  *) fail "operational alert receiver must use a public multi-label hostname" ;;
esac
case "$alert_receiver_authority" in
  modvoltapp.cz|*.modvoltapp.cz|localhost|*.localhost|*.local|*.internal|*.invalid|127.*|0.0.0.0|10.*|192.168.*|169.254.*|172.16.*|172.17.*|172.18.*|172.19.*|172.20.*|172.21.*|172.22.*|172.23.*|172.24.*|172.25.*|172.26.*|172.27.*|172.28.*|172.29.*|172.30.*|172.31.*)
    fail "production or loopback alert receiver is forbidden"
    ;;
esac
[ "$STAGING_OPERATIONAL_ALERT_RECEIVER_HOST" = "$alert_receiver_authority" ] \
  || fail "operational alert receiver hostname must exactly match its URL"
[ "$STAGING_OPERATIONAL_ALERT_RECEIVER_HOST" != "$staging_host" ] \
  || fail "operational alert receiver must use a separate public hostname"
[ "${#STAGING_OPERATIONAL_ALERT_BEARER_TOKEN}" -ge 43 ] \
  || fail "operational alert bearer token must contain at least 32 random base64url bytes"
[ "${#STAGING_OPERATIONAL_ALERT_BEARER_TOKEN}" -le 128 ] \
  || fail "operational alert bearer token is too long"
case "$STAGING_OPERATIONAL_ALERT_BEARER_TOKEN" in
  *[!A-Za-z0-9_-]*) fail "operational alert bearer token must use unpadded base64url" ;;
esac
unset alert_receiver_authority

case "$STAGING_S3_ENDPOINT" in
  https://*) staging_s3_authority=${STAGING_S3_ENDPOINT#https://} ;;
  *) fail "S3 endpoint must be one bare HTTPS origin" ;;
esac
case "$staging_s3_authority" in
  ''|*/*|*@*|*[!A-Za-z0-9.:-]*) fail "S3 endpoint must be one bare HTTPS origin without credentials" ;;
esac
case "$STAGING_S3_REGION" in ''|*[!A-Za-z0-9-]*) fail "S3 region contains forbidden characters" ;; esac
case "$STAGING_S3_BUCKET" in
  site-logbook-staging|site-logbook-staging-*) ;;
  *) fail "S3 bucket must use the site-logbook-staging namespace" ;;
esac
case "$STAGING_S3_BUCKET" in *[!a-z0-9.-]*) fail "S3 bucket contains forbidden characters" ;; esac
[ "${#STAGING_S3_BUCKET}" -le 63 ] || fail "S3 bucket is too long"
[ "${#STAGING_S3_ACCESS_KEY_ID}" -ge 16 ] || fail "S3 access key id is too short"
case "$STAGING_S3_ACCESS_KEY_ID" in *[!A-Za-z0-9_-]*) fail "S3 access key id contains forbidden characters" ;; esac
[ "${#STAGING_S3_SECRET_ACCESS_KEY}" -ge 32 ] || fail "S3 secret access key is too short"
case "$STAGING_S3_SECRET_ACCESS_KEY" in *[!A-Za-z0-9/+=_-]*) fail "S3 secret access key contains forbidden characters" ;; esac
case "$STAGING_S3_FORCE_PATH_STYLE" in true|false) ;; *) fail "S3 force-path-style must be true or false" ;; esac

if [ "$STAGING_SCHEMA_ACTION" = "steady-0105" ]; then
  deployment_inputs=$(jq -cnS \
    --arg sourceSha "$STAGING_BUILD_SHA" \
    --arg imageManifestSha256 "$STAGING_IMAGE_MANIFEST_SHA256" \
    --arg provisioningManifestSha256 "$STAGING_PROVISIONING_MANIFEST_SHA256" \
    --arg environmentId "$STAGING_ENVIRONMENT_ID" \
    --arg composeProjectName "$STAGING_COMPOSE_PROJECT_NAME" \
    --arg publicAppUrl "$STAGING_PUBLIC_APP_URL" \
    --arg nginxServerName "$STAGING_NGINX_SERVER_NAME" \
    --arg operationalAlertReceiverUrl "$STAGING_OPERATIONAL_ALERT_RECEIVER_URL" \
    --arg operationalAlertReceiverHost "$STAGING_OPERATIONAL_ALERT_RECEIVER_HOST" \
    --arg s3Endpoint "$STAGING_S3_ENDPOINT" \
    --arg s3Region "$STAGING_S3_REGION" \
    --arg s3Bucket "$STAGING_S3_BUCKET" \
    --argjson s3ForcePathStyle "$STAGING_S3_FORCE_PATH_STYLE" \
    --arg schemaAction "$STAGING_SCHEMA_ACTION" \
    --arg preflight "$STAGING_PREFLIGHT_IMAGE" \
    --arg mailpit "$STAGING_MAILPIT_IMAGE" \
    --arg api "$STAGING_API_IMAGE" \
    --arg web "$STAGING_WEB_IMAGE" \
    --arg alertReceiver "$STAGING_ALERT_RECEIVER_IMAGE" \
    '{schemaVersion:1,sourceSha:$sourceSha,imageManifestSha256:$imageManifestSha256,provisioningManifestSha256:$provisioningManifestSha256,environmentId:$environmentId,composeProjectName:$composeProjectName,publicAppUrl:$publicAppUrl,nginxServerName:$nginxServerName,operationalAlertReceiverUrl:$operationalAlertReceiverUrl,operationalAlertReceiverHost:$operationalAlertReceiverHost,s3Endpoint:$s3Endpoint,s3Region:$s3Region,s3Bucket:$s3Bucket,s3ForcePathStyle:$s3ForcePathStyle,externalAccountsEnabled:false,schemaAction:$schemaAction,images:{preflight:$preflight,mailpit:$mailpit,api:$api,web:$web,alertReceiver:$alertReceiver}}')
else
  deployment_inputs=$(jq -cnS \
    --arg sourceSha "$STAGING_BUILD_SHA" \
    --arg imageManifestSha256 "$STAGING_IMAGE_MANIFEST_SHA256" \
    --arg provisioningManifestSha256 "$STAGING_PROVISIONING_MANIFEST_SHA256" \
    --arg environmentId "$STAGING_ENVIRONMENT_ID" \
    --arg composeProjectName "$STAGING_COMPOSE_PROJECT_NAME" \
    --arg publicAppUrl "$STAGING_PUBLIC_APP_URL" \
    --arg nginxServerName "$STAGING_NGINX_SERVER_NAME" \
    --arg operationalAlertReceiverUrl "$STAGING_OPERATIONAL_ALERT_RECEIVER_URL" \
    --arg operationalAlertReceiverHost "$STAGING_OPERATIONAL_ALERT_RECEIVER_HOST" \
    --arg s3Endpoint "$STAGING_S3_ENDPOINT" \
    --arg s3Region "$STAGING_S3_REGION" \
    --arg s3Bucket "$STAGING_S3_BUCKET" \
    --argjson s3ForcePathStyle "$STAGING_S3_FORCE_PATH_STYLE" \
    --arg schemaAction "$STAGING_SCHEMA_ACTION" \
    --argjson backupEvidenceId "$STAGING_BACKUP_EVIDENCE_ID" \
    --argjson backupRestoreMaxAgeHours "$STAGING_BACKUP_RESTORE_MAX_AGE_HOURS" \
    --arg preflight "$STAGING_PREFLIGHT_IMAGE" \
    --arg mailpit "$STAGING_MAILPIT_IMAGE" \
    --arg api "$STAGING_API_IMAGE" \
    --arg web "$STAGING_WEB_IMAGE" \
    --arg alertReceiver "$STAGING_ALERT_RECEIVER_IMAGE" \
    '{schemaVersion:1,sourceSha:$sourceSha,imageManifestSha256:$imageManifestSha256,provisioningManifestSha256:$provisioningManifestSha256,environmentId:$environmentId,composeProjectName:$composeProjectName,publicAppUrl:$publicAppUrl,nginxServerName:$nginxServerName,operationalAlertReceiverUrl:$operationalAlertReceiverUrl,operationalAlertReceiverHost:$operationalAlertReceiverHost,s3Endpoint:$s3Endpoint,s3Region:$s3Region,s3Bucket:$s3Bucket,s3ForcePathStyle:$s3ForcePathStyle,externalAccountsEnabled:false,schemaAction:$schemaAction,images:{preflight:$preflight,mailpit:$mailpit,api:$api,web:$web,alertReceiver:$alertReceiver},backupEvidenceId:$backupEvidenceId,backupRestoreMaxAgeHours:$backupRestoreMaxAgeHours}')
fi
deployment_inputs_sha256=$(printf '%s\n' "$deployment_inputs" | sha256sum | awk '{print $1}')
[ "$deployment_inputs_sha256" = "$STAGING_DEPLOYMENT_INPUTS_SHA256" ] \
  || fail "runtime values do not match the approved canonical deployment inputs"
unset deployment_inputs deployment_inputs_sha256

read_active_key() {
  keyring=$1
  active_id=$2
  label=$3
  active_key=$(printf '%s' "$keyring" | jq -er --arg id "$active_id" \
    'if type == "object" and has($id) and (.[$id] | type == "string") then .[$id] else empty end' \
    2>/dev/null) || fail "$label keyring must be valid JSON containing its active key id"
  [ "${#active_key}" -eq 44 ] || fail "$label active key must be 32-byte base64"
  case "$active_key" in *=) active_key_body=${active_key%=} ;; *) fail "$label active key must be 32-byte base64" ;; esac
  case "$active_key_body" in *[!A-Za-z0-9+/]*) fail "$label active key must be 32-byte base64" ;; esac
  printf '%s' "$active_key"
}

application_active_key=$(read_active_key \
  "$STAGING_SECRET_ENCRYPTION_KEYRING" \
  "$STAGING_SECRET_ENCRYPTION_ACTIVE_KEY_ID" \
  application)
backup_active_key=$(read_active_key \
  "$STAGING_BACKUP_ENCRYPTION_KEYRING" \
  "$STAGING_BACKUP_ENCRYPTION_ACTIVE_KEY_ID" \
  backup)
[ "$application_active_key" != "$backup_active_key" ] \
  || fail "application and backup active keys must differ"
unset application_active_key backup_active_key active_key active_key_body keyring active_id label

echo "staging boundary preflight passed"
