#!/usr/bin/env bash
#
# One-time setup for the self-hosted OSRM India server.
#
# Downloads the India OpenStreetMap extract from Geofabrik (~900 MB) and
# runs the OSRM extract -> partition -> customize pipeline so the data
# can be served by `docker compose up`.
#
# Requirements:
#   * Docker
#   * ~5 GB free disk space
#   * ~8-16 GB RAM (only during preprocessing; runtime is much less)
#   * ~30 minutes (depending on CPU and disk speed)
#
# Usage:
#   ./setup-osrm.sh
#
# After this finishes, run:
#   docker compose up -d
#
set -euo pipefail

DATA_DIR="$(pwd)/osrm-data"
PBF_URL="https://download.geofabrik.de/asia/india-latest.osm.pbf"
PBF_FILE="india-latest.osm.pbf"
OSRM_IMAGE="ghcr.io/project-osrm/osrm-backend:latest"

mkdir -p "$DATA_DIR"
cd "$DATA_DIR"

if [[ ! -f "$PBF_FILE" ]]; then
    echo "==> Downloading India OSM extract from Geofabrik..."
    if command -v wget >/dev/null 2>&1; then
        wget -O "$PBF_FILE" "$PBF_URL"
    else
        curl -L -o "$PBF_FILE" "$PBF_URL"
    fi
else
    echo "==> India OSM extract already present, skipping download."
fi

echo "==> Pulling OSRM Docker image..."
docker pull "$OSRM_IMAGE"

echo "==> Step 1/3: osrm-extract (this is the heaviest step)..."
docker run --rm -t -v "$DATA_DIR:/data" "$OSRM_IMAGE" \
    osrm-extract -p /opt/car.lua "/data/$PBF_FILE"

echo "==> Step 2/3: osrm-partition..."
docker run --rm -t -v "$DATA_DIR:/data" "$OSRM_IMAGE" \
    osrm-partition "/data/india-latest.osrm"

echo "==> Step 3/3: osrm-customize..."
docker run --rm -t -v "$DATA_DIR:/data" "$OSRM_IMAGE" \
    osrm-customize "/data/india-latest.osrm"

echo
echo "==> Done. Start the server with:"
echo "    docker compose up -d"
echo
echo "==> Then run lookups against your local OSRM:"
echo "    export OSRM_BASE=http://localhost:5000/route/v1/driving"
echo "    export OSRM_DELAY=0"
echo "    python3 pincode_distance.py 110001 400001"
