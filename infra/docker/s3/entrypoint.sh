#!/bin/sh
# SeaweedFS as a single-node, S3-compatible store for file and image fields.
# Credentials come from the environment; the config file is written at start and never committed.
set -eu
: "${S3_ACCESS_KEY:?S3_ACCESS_KEY is required}"
: "${S3_SECRET_KEY:?S3_SECRET_KEY is required}"
mkdir -p /etc/seaweedfs /data
cat > /etc/seaweedfs/s3.json <<JSON
{
  "identities": [
    {
      "name": "erp-files",
      "credentials": [{ "accessKey": "${S3_ACCESS_KEY}", "secretKey": "${S3_SECRET_KEY}" }],
      "actions": ["Admin", "Read", "Write", "List", "Tagging"]
    }
  ]
}
JSON
exec weed server -dir=/data -ip.bind=0.0.0.0 -master.volumeSizeLimitMB=1024 -volume.max=0 \
  -s3 -s3.port=8333 -s3.config=/etc/seaweedfs/s3.json
