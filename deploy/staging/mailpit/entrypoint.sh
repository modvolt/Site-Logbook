#!/bin/sh
set -eu

private_dir=/certs/private
trust_dir=/certs/trust
ca_cert="$trust_dir/ca.crt"
server_cert="$private_dir/server.crt"
server_key="$private_dir/server.key"

mkdir -p "$private_dir" "$trust_dir"

present=0
for path in "$ca_cert" "$server_cert" "$server_key"; do
  if [ -s "$path" ]; then
    present=$((present + 1))
  fi
done

if [ "$present" -ne 0 ] && [ "$present" -ne 3 ]; then
  echo "STAGING MAIL TLS FAILED: certificate volume is incomplete; replace only the staging_mailtls volume." >&2
  exit 1
fi

if [ "$present" -eq 0 ]; then
  umask 077
  openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 3650 \
    -subj "/CN=Site Logbook staging mail CA" \
    -keyout "$private_dir/ca.key.tmp" -out "$trust_dir/ca.crt.tmp"
  openssl req -newkey rsa:3072 -sha256 -nodes \
    -subj "/CN=mailpit" \
    -addext "subjectAltName=DNS:mailpit" \
    -keyout "$private_dir/server.key.tmp" -out "$private_dir/server.csr.tmp"
  printf '%s\n' 'subjectAltName=DNS:mailpit' 'extendedKeyUsage=serverAuth' > "$private_dir/server.ext.tmp"
  openssl x509 -req -sha256 -days 1095 \
    -in "$private_dir/server.csr.tmp" \
    -CA "$trust_dir/ca.crt.tmp" -CAkey "$private_dir/ca.key.tmp" -CAcreateserial \
    -extfile "$private_dir/server.ext.tmp" -out "$private_dir/server.crt.tmp"

  mv "$trust_dir/ca.crt.tmp" "$ca_cert"
  mv "$private_dir/server.crt.tmp" "$server_cert"
  mv "$private_dir/server.key.tmp" "$server_key"
  rm -f "$private_dir/ca.key.tmp" "$trust_dir/ca.crt.tmp.srl" \
    "$private_dir/server.csr.tmp" "$private_dir/server.ext.tmp"
fi

chown mailpit:mailpit "$ca_cert" "$server_cert" "$server_key"
chmod 0444 "$ca_cert" "$server_cert"
chmod 0400 "$server_key"

exec su-exec mailpit:mailpit /mailpit "$@"
