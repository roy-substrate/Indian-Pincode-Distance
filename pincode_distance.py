"""
Calculate road (transport) distance between two Indian pincodes.

Uses the OSRM public demo server (https://router.project-osrm.org) to get
driving distance and duration. Also prints the aerial (haversine) distance
for comparison.

Usage:
    python pincode_distance.py <pincode_from> <pincode_to>

Example:
    python pincode_distance.py 110001 400001
"""

import csv
import math
import sys
from urllib.parse import quote
from urllib.request import urlopen
import json

CSV_PATH = "pincode_data.csv"
OSRM_BASE = "https://router.project-osrm.org/route/v1/driving"


def load_pincode_coords(csv_path):
    """Return {pincode: (lat, lon, office_name, district, state)} using the
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


def haversine_km(lat1, lon1, lat2, lon2):
    """Great-circle distance between two points in kilometres."""
    r = 6371.0
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlam = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlam / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def osrm_route(lat1, lon1, lat2, lon2):
    """Call OSRM public demo and return (distance_km, duration_min)."""
    # OSRM expects lon,lat order
    coords = f"{lon1},{lat1};{lon2},{lat2}"
    url = f"{OSRM_BASE}/{quote(coords, safe=',;')}?overview=false"
    with urlopen(url, timeout=30) as resp:
        data = json.loads(resp.read().decode("utf-8"))
    if data.get("code") != "Ok" or not data.get("routes"):
        raise RuntimeError(f"OSRM error: {data.get('message', data.get('code'))}")
    route = data["routes"][0]
    return route["distance"] / 1000.0, route["duration"] / 60.0


def format_duration(minutes):
    hours, mins = divmod(int(round(minutes)), 60)
    if hours:
        return f"{hours}h {mins}m"
    return f"{mins}m"


def main():
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)

    pin_from, pin_to = sys.argv[1].strip(), sys.argv[2].strip()

    print(f"Loading {CSV_PATH} ...")
    coords = load_pincode_coords(CSV_PATH)
    print(f"Loaded {len(coords):,} pincodes with valid coordinates.\n")

    missing = [p for p in (pin_from, pin_to) if p not in coords]
    if missing:
        print(f"Pincode(s) not found or missing coordinates: {', '.join(missing)}")
        sys.exit(2)

    lat1, lon1, o1, d1, s1 = coords[pin_from]
    lat2, lon2, o2, d2, s2 = coords[pin_to]

    print(f"From: {pin_from}  {o1}, {d1}, {s1}  ({lat1:.5f}, {lon1:.5f})")
    print(f"To  : {pin_to}  {o2}, {d2}, {s2}  ({lat2:.5f}, {lon2:.5f})\n")

    aerial = haversine_km(lat1, lon1, lat2, lon2)
    print(f"Aerial (haversine) distance : {aerial:,.2f} km")

    try:
        road_km, dur_min = osrm_route(lat1, lon1, lat2, lon2)
        print(f"Road distance (OSRM)        : {road_km:,.2f} km")
        print(f"Estimated driving time      : {format_duration(dur_min)}")
        if aerial > 0:
            print(f"Detour factor (road/aerial) : {road_km / aerial:.2f}x")
    except Exception as e:
        print(f"OSRM request failed: {e}")
        sys.exit(3)


if __name__ == "__main__":
    main()
