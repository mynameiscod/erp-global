#!/bin/bash
# Starts MongoDB as a single-node replica set with authentication.
# The keyfile (required for auth with replica sets) comes from MONGO_KEYFILE.
set -euo pipefail
if [ ! -s /data/configdb/keyfile ]; then
  printf '%s' "${MONGO_KEYFILE:?MONGO_KEYFILE is required}" > /data/configdb/keyfile
fi
chmod 400 /data/configdb/keyfile
chown 999:999 /data/configdb/keyfile
exec docker-entrypoint.sh mongod --replSet rs0 --bind_ip_all --keyFile /data/configdb/keyfile "$@"
