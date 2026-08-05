#!/bin/sh
set -eu

proxy_fail() {
  echo "STAGING PREFLIGHT FAILED: $1" >&2
  exit 1
}

validate_staging_proxy_ipv4() {
  value=$1
  case "$value" in
    */*) address=${value%/*}; prefix=${value##*/} ;;
    *) address=$value; prefix=32 ;;
  esac
  case "$prefix" in ''|*[!0-9]*) proxy_fail "trusted proxy CIDR prefix is invalid" ;; esac
  [ "$prefix" -ge 1 ] && [ "$prefix" -le 32 ] \
    || proxy_fail "trusted proxy CIDR prefix must be between 1 and 32"
  previous_ifs=$IFS
  IFS=.
  # shellcheck disable=SC2086 -- intentional IFS split into four octets
  set -- $address
  IFS=$previous_ifs
  [ "$#" -eq 4 ] || proxy_fail "trusted proxy address must be explicit IPv4"
  for octet in "$@"; do
    case "$octet" in
      0|[1-9]|[1-9][0-9]|[1-9][0-9][0-9]) ;;
      *) proxy_fail "trusted proxy address is invalid or has a leading zero" ;;
    esac
    [ "$octet" -le 255 ] || proxy_fail "trusted proxy address octet is out of range"
  done
}

case "$STAGING_API_TRUSTED_PROXY_CIDRS" in
  ''|,*|*,|*,,*|*[!0-9.,/]*) proxy_fail "trusted proxy list must contain only explicit IPs or CIDRs" ;;
esac
previous_ifs=$IFS
IFS=,
# shellcheck disable=SC2086 -- intentional IFS split into explicit CIDR entries
set -- $STAGING_API_TRUSTED_PROXY_CIDRS
IFS=$previous_ifs
for trusted_proxy_cidr in "$@"; do
  validate_staging_proxy_ipv4 "$trusted_proxy_cidr"
done
unset value address prefix previous_ifs octet trusted_proxy_cidr
