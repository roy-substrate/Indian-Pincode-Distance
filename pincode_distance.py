"""
Calculate road (transport) distance between Indian pincodes.

Default backend: OpenRouteService Matrix API (free tier).
    https://openrouteservice.org/dev/#/signup

Modes
-----
Single lookup:
    python pincode_distance.py 560076 560103

Batch lookup (CSV with `from,to` columns -> writes results CSV):
    python pincode_distance.py --batch pairs.csv results.csv

Configuration via environment variables
---------------------------------------
ORS_API_KEY   Your free OpenRouteService API key (required for default backend).
              Get one at https://openrouteservice.org/dev/#/signup

BACKEND       "ors" (default) or "osrm". Switch to "osrm" to use OSRM instead.

OSRM_BASE     OSRM endpoint when BACKEND=osrm. Defaults to the public demo:
              https://router.project-osrm.org/route/v1/driving
              For unlimited free use, self-host OSRM (see docker-compose.yml)
              and set OSRM_BASE=http://localhost:5000/route/v1/driving

ORS_DELAY     Seconds to sleep between ORS calls in batch mode. Default 1.6
              (ORS free tier allows 40 matrix calls per minute).

CACHE_DB      Path to the SQLite cache file. Defaults to .pincode_cache.sqlite
              Cached results are reused forever, so re-runs are free.

PINCODE_CSV   Path to the dataset (default: pincode_data.csv).

Why ORS Matrix?
---------------
ORS free tier provides 500 matrix calls per day, with up to 50 locations per
call. The script chunks many pincode pairs into a single matrix call, so a
20,000-pair workload typically fits well within the free quota.

Notes
-----
* Uses only the Python standard library; no `pip install` required.
* Caching is symmetric: A->B and B->A share a cache entry.
"""

import csv
import json
import os
import sqlite3
import sys
import time
from urllib.parse import quote
from urllib.request import Request, urlopen
from urllib.error import HTTPError

CSV_PATH = os.environ.get("PINCODE_CSV", "pincode_data.csv")
BACKEND = os.environ.get("BACKEND", "ors").lower()

ORS_API_KEY = os.environ.get("ORS_API_KEY", "")
ORS_URL = "https://api.openrouteservice.org/v2/matrix/driving-car"
ORS_DELAY = float(os.environ.get("ORS_DELAY", "1.6"))
ORS_MAX_LOCATIONS = 50  # ORS free tier limit per matrix call

OSRM_BASE = os.environ.get(
    "OSRM_BASE", "https://router.project-osrm.org/route/v1/driving"
)
OSRM_DELAY = float(os.environ.get("OSRM_DELAY", "1.0"))

CACHE_DB = os.environ.get("CACHE_DB", ".pincode_cache.sqlite")
USER_AGENT = "indian-pincode-distance/1.0"


# ---------- pincode -> coordinates ----------

def load_pincode_coords(csv_path=CSV_PATH):
    """Return {pincode: (lat, lon, office, district, state)} using the
    first row per pincode that has valid coordinates."""
    coords = {}
    with open(csv_path, newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            pin = row["pincode"].strip()
            lat, lon = row["latitude"].strip(), row["longitude"].strip()
            if pin in coords or lat == "NA" or lon == "NA" or not lat or not lon:
                continue
            try:
                coords[pin] = (
                    float(lat),
                    float(lon),
                    row["officename"],
                    row["district"],
                    row["statename"],
                )
            except ValueError:
                continue
    return coords


# ---------- OpenRouteService backend ----------

def ors_matrix(locations, api_key=None):
    """
    Call ORS Matrix API.
    locations: list of (lat, lon) tuples (max 50 for free tier).
    Returns dict with `distances` (km) and `durations` (sec) 2D matrices.
    """
    api_key = api_key or ORS_API_KEY
    if not api_key:
        raise RuntimeError(
            "ORS_API_KEY is not set. Get a free key at "
            "https://openrouteservice.org/dev/#/signup and:\n"
            "  export ORS_API_KEY=your-key-here"
        )
    if len(locations) > ORS_MAX_LOCATIONS:
        raise ValueError(
            f"ORS free tier allows up to {ORS_MAX_LOCATIONS} locations per "
            f"matrix call (got {len(locations)})."
        )
    body = {
        "locations": [[lon, lat] for lat, lon in locations],
        "metrics": ["distance", "duration"],
        "units": "km",
    }
    req = Request(
        ORS_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Authorization": api_key,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": USER_AGENT,
        },
    )
    try:
        with urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except HTTPError as e:
        body_msg = e.read().decode("utf-8", errors="ignore")[:500]
        raise RuntimeError(f"ORS HTTP {e.code}: {body_msg}") from None


def ors_pair(lat1, lon1, lat2, lon2):
    """Look up a single pair using ORS Matrix."""
    data = ors_matrix([(lat1, lon1), (lat2, lon2)])
    dist_km = data["distances"][0][1]
    dur_sec = data["durations"][0][1]
    if dist_km is None or dur_sec is None:
        raise RuntimeError("ORS returned null (no route between points).")
    return dist_km, dur_sec / 60.0


# ---------- OSRM backend ----------

def osrm_pair(lat1, lon1, lat2, lon2):
    coord_str = f"{lon1},{lat1};{lon2},{lat2}"
    url = f"{OSRM_BASE}/{quote(coord_str, safe=',;')}?overview=false"
    req = Request(url, headers={"User-Agent": USER_AGENT})
    with urlopen(req, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("code") != "Ok" or not data.get("routes"):
        raise RuntimeError(f"OSRM error: {data.get('message', data.get('code'))}")
    route = data["routes"][0]
    return route["distance"] / 1000.0, route["duration"] / 60.0


def route_pair(lat1, lon1, lat2, lon2):
    """Dispatch to the configured backend."""
    if BACKEND == "ors":
        return ors_pair(lat1, lon1, lat2, lon2)
    if BACKEND == "osrm":
        return osrm_pair(lat1, lon1, lat2, lon2)
    raise RuntimeError(f"Unknown BACKEND: {BACKEND!r} (use 'ors' or 'osrm')")


# ---------- cache ----------

def cache_open(path=CACHE_DB):
    conn = sqlite3.connect(path)
    conn.execute(
        """CREATE TABLE IF NOT EXISTS distances (
               pin_a TEXT NOT NULL,
               pin_b TEXT NOT NULL,
               backend TEXT NOT NULL,
               distance_km REAL NOT NULL,
               duration_min REAL NOT NULL,
               PRIMARY KEY (pin_a, pin_b, backend)
           )"""
    )
    return conn


def _key(p1, p2):
    return (p1, p2) if p1 <= p2 else (p2, p1)


def cache_get(conn, p1, p2, backend=None):
    backend = backend or BACKEND
    a, b = _key(p1, p2)
    cur = conn.execute(
        "SELECT distance_km, duration_min FROM distances "
        "WHERE pin_a=? AND pin_b=? AND backend=?",
        (a, b, backend),
    )
    return cur.fetchone()


def cache_put(conn, p1, p2, dist_km, dur_min, backend=None):
    backend = backend or BACKEND
    a, b = _key(p1, p2)
    conn.execute(
        "INSERT OR REPLACE INTO distances VALUES (?, ?, ?, ?, ?)",
        (a, b, backend, dist_km, dur_min),
    )
    conn.commit()


# ---------- formatters ----------

def format_duration(minutes):
    hours, mins = divmod(int(round(minutes)), 60)
    return f"{hours}h {mins}m" if hours else f"{mins}m"


# ---------- single mode ----------

def single_lookup(pin_from, pin_to):
    print(f"Loading {CSV_PATH} ...")
    coords = load_pincode_coords()
    print(f"Loaded {len(coords):,} pincodes with valid coordinates.")
    print(f"Backend: {BACKEND.upper()}\n")

    missing = [p for p in (pin_from, pin_to) if p not in coords]
    if missing:
        print(f"Pincode(s) not found or missing coordinates: {', '.join(missing)}")
        sys.exit(2)

    lat1, lon1, o1, d1, s1 = coords[pin_from]
    lat2, lon2, o2, d2, s2 = coords[pin_to]

    print(f"From: {pin_from}  {o1}, {d1}, {s1}")
    print(f"To  : {pin_to}  {o2}, {d2}, {s2}\n")

    conn = cache_open()
    cached = cache_get(conn, pin_from, pin_to)
    if cached:
        road_km, dur_min = cached
        source = "cache"
    else:
        try:
            road_km, dur_min = route_pair(lat1, lon1, lat2, lon2)
        except Exception as e:
            print(f"{BACKEND.upper()} request failed: {e}")
            sys.exit(3)
        cache_put(conn, pin_from, pin_to, road_km, dur_min)
        source = BACKEND.upper()

    print(f"Road distance ({source})  : {road_km:,.2f} km")
    print(f"Estimated driving time   : {format_duration(dur_min)}")


# ---------- batch mode ----------

def _chunked(seq, n):
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def batch_lookup(input_csv, output_csv):
    print(f"Loading {CSV_PATH} ...")
    coords = load_pincode_coords()
    print(f"Loaded {len(coords):,} pincodes with valid coordinates.")
    print(f"Backend: {BACKEND.upper()}")

    with open(input_csv, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))
    if not rows or "from" not in rows[0] or "to" not in rows[0]:
        print("Input CSV must have headers: from,to")
        sys.exit(2)

    print(f"Read {len(rows):,} pairs from {input_csv}")
    print(f"Cache file: {CACHE_DB}\n")

    conn = cache_open()
    fieldnames = [
        "from", "to",
        "from_office", "from_district", "from_state",
        "to_office", "to_district", "to_state",
        "road_km", "duration_min", "status",
    ]
    out_f = open(output_csv, "w", newline="", encoding="utf-8")
    writer = csv.DictWriter(out_f, fieldnames=fieldnames)
    writer.writeheader()

    cache_hits = 0
    live_routes = 0
    api_calls = 0
    failures = 0
    started = time.time()

    # Step 1: enrich rows, separate cached vs uncached
    enriched = []
    for row in rows:
        pin_from = row["from"].strip()
        pin_to = row["to"].strip()
        rec = {"from": pin_from, "to": pin_to}

        if pin_from not in coords or pin_to not in coords:
            rec["status"] = "missing_coords"
            enriched.append((rec, None, None))
            failures += 1
            continue

        lat1, lon1, o1, d1, s1 = coords[pin_from]
        lat2, lon2, o2, d2, s2 = coords[pin_to]
        rec.update({
            "from_office": o1, "from_district": d1, "from_state": s1,
            "to_office": o2, "to_district": d2, "to_state": s2,
        })

        cached = cache_get(conn, pin_from, pin_to)
        if cached:
            road_km, dur_min = cached
            rec["road_km"] = round(road_km, 3)
            rec["duration_min"] = round(dur_min, 1)
            rec["status"] = "ok_cached"
            cache_hits += 1
            enriched.append((rec, None, None))
        else:
            enriched.append((rec, (lat1, lon1), (lat2, lon2)))

    uncached = [(rec, a, b) for rec, a, b in enriched if a is not None]
    print(f"Cache hits: {cache_hits:,}  |  Need fresh lookups: {len(uncached):,}")

    # Step 2: process uncached pairs in chunks via the chosen backend
    if BACKEND == "ors":
        # Each chunk: collect <=50 unique locations, do one matrix call,
        # then look up each pair from the matrix.
        chunk = []
        unique = {}  # pincode -> latlon
        chunk_pairs = []  # list of (rec, pin_from, pin_to)

        def flush_chunk():
            nonlocal api_calls, live_routes, failures
            if not chunk_pairs:
                return
            loc_items = list(unique.items())
            loc_index = {pin: i for i, (pin, _) in enumerate(loc_items)}
            location_list = [latlon for _, latlon in loc_items]
            try:
                data = ors_matrix(location_list)
                api_calls += 1
                distances = data["distances"]
                durations = data["durations"]
                for rec, pf, pt in chunk_pairs:
                    i, j = loc_index[pf], loc_index[pt]
                    dk = distances[i][j]
                    ds = durations[i][j]
                    if dk is None or ds is None:
                        rec["status"] = "no_route"
                        failures += 1
                    else:
                        dm = ds / 60.0
                        rec["road_km"] = round(dk, 3)
                        rec["duration_min"] = round(dm, 1)
                        rec["status"] = "ok"
                        cache_put(conn, pf, pt, dk, dm)
                        live_routes += 1
            except Exception as e:
                err = f"ors_error: {e}"
                for rec, _, _ in chunk_pairs:
                    rec["status"] = err
                    failures += 1
            if ORS_DELAY > 0:
                time.sleep(ORS_DELAY)

        for rec, latlon1, latlon2 in uncached:
            pf = rec["from"]
            pt = rec["to"]
            new_pins = {p: ll for p, ll in [(pf, latlon1), (pt, latlon2)] if p not in unique}
            # If adding these pushes us over the 50-location limit, flush first.
            if len(unique) + len(new_pins) > ORS_MAX_LOCATIONS:
                flush_chunk()
                unique = {}
                chunk_pairs = []
            unique.update(new_pins)
            unique[pf] = latlon1
            unique[pt] = latlon2
            chunk_pairs.append((rec, pf, pt))

            if len(chunk_pairs) % 100 == 0:
                done = cache_hits + live_routes + failures
                elapsed = time.time() - started
                print(
                    f"  pairs queued={done}  api_calls={api_calls}  "
                    f"live={live_routes}  failed={failures}  "
                    f"({elapsed:.1f}s elapsed)"
                )
        flush_chunk()

    else:  # BACKEND == "osrm"
        for idx, (rec, latlon1, latlon2) in enumerate(uncached, 1):
            try:
                dk, dm = osrm_pair(*latlon1, *latlon2)
                rec["road_km"] = round(dk, 3)
                rec["duration_min"] = round(dm, 1)
                rec["status"] = "ok"
                cache_put(conn, rec["from"], rec["to"], dk, dm)
                live_routes += 1
                if OSRM_DELAY > 0:
                    time.sleep(OSRM_DELAY)
            except Exception as e:
                rec["status"] = f"osrm_error: {e}"
                failures += 1
            if idx % 50 == 0:
                print(f"  osrm {idx}/{len(uncached)} live={live_routes} failed={failures}")

    # Step 3: write everything in original order
    for rec, _, _ in enriched:
        writer.writerow(rec)
    out_f.close()

    elapsed = time.time() - started
    print(
        f"\nDone in {elapsed:.1f}s. "
        f"cached={cache_hits} live={live_routes} api_calls={api_calls} "
        f"failed={failures} -> {output_csv}"
    )


# ---------- entry ----------

def main():
    args = sys.argv[1:]
    if len(args) == 2 and args[0] != "--batch":
        single_lookup(args[0].strip(), args[1].strip())
    elif len(args) == 3 and args[0] == "--batch":
        batch_lookup(args[1], args[2])
    else:
        print(__doc__)
        sys.exit(1)


if __name__ == "__main__":
    main()
