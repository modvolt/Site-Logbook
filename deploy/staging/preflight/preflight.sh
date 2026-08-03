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
[ "${#STAGING_BUILD_SHA}" -eq 40 ] \
  || fail "build SHA must be 40 lowercase hexadecimal characters"
case "$STAGING_BUILD_SHA" in *[!0-9a-f]*) fail "build SHA must be 40 lowercase hexadecimal characters" ;; esac

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
unset image_ref label image_repository image_digest

validate_hex_secret() {
  [ "${#1}" -eq 64 ] || fail "$2 must be 32-byte lowercase hex"
  case "$1" in *[!0-9a-f]*) fail "$2 must be 32-byte lowercase hex" ;; esac
}
validate_hex_secret "$STAGING_POSTGRES_PASSWORD" STAGING_POSTGRES_PASSWORD
validate_hex_secret "$STAGING_SESSION_SECRET" STAGING_SESSION_SECRET

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
