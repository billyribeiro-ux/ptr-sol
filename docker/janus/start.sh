#!/bin/sh
set -eu
: "${JANUS_API_SECRET:?Run node scripts/setup-local.mjs first}"
: "${JANUS_ADMIN_SECRET:?Run node scripts/setup-local.mjs first}"
case "$JANUS_API_SECRET$JANUS_ADMIN_SECRET${JANUS_PUBLIC_IP:-127.0.0.1}${JANUS_UDP_MIN:-20100}${JANUS_UDP_MAX:-20199}" in
 *[!a-zA-Z0-9_.:-]*) echo 'Invalid Janus configuration value' >&2; exit 1;;
esac
mkdir -p /tmp/ptr-janus /app/data/recordings
for f in /etc/ptr-janus/*.jcfg; do
 sed -e "s/__JANUS_API_SECRET__/$JANUS_API_SECRET/g" -e "s/__JANUS_ADMIN_SECRET__/$JANUS_ADMIN_SECRET/g" -e "s/__JANUS_PUBLIC_IP__/${JANUS_PUBLIC_IP:-127.0.0.1}/g" -e "s/__JANUS_UDP_MIN__/${JANUS_UDP_MIN:-20100}/g" -e "s/__JANUS_UDP_MAX__/${JANUS_UDP_MAX:-20199}/g" "$f" > "/tmp/ptr-janus/$(basename "$f")"
done
exec /usr/local/bin/janus -F /tmp/ptr-janus
