<div align="center">

# Indian Pincode Distance Calculator

**Find the real road (driving) distance between any two Indian pincodes.**

Powered by the official India Post pincode dataset and the OpenRouteService Matrix API.

[![Python](https://img.shields.io/badge/python-3.7+-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Dataset](https://img.shields.io/badge/pincodes-19%2C586-orange.svg)](#dataset)
[![Routing](https://img.shields.io/badge/routing-OpenRouteService-blueviolet.svg)](https://openrouteservice.org/)

</div>

---

## What this does

Given two Indian pincodes, this tool returns:

- **Road distance** — actual driving (transport) distance along roads
- **Estimated driving time** — hours/minutes by car

Built for **bulk use** — handles 20,000+ lookups per day on the **free** OpenRouteService tier, with automatic caching so re-runs are instant.

---

## Quick start (4 steps)

### 1. Fork and clone

Click the **Fork** button at the top-right of this repo, then:

```bash
git clone https://github.com/<your-username>/Indian-Pincode-Distance.git
cd Indian-Pincode-Distance
```

### 2. Get a free OpenRouteService API key

1. Sign up at [openrouteservice.org/dev/#/signup](https://openrouteservice.org/dev/#/signup) (free, no credit card)
2. Verify your email
3. Copy your API token from the dashboard

The free tier gives you **500 matrix calls per day**, with up to **50 locations per call** — easily enough for tens of thousands of pincode pairs daily.

### 3. Set the key

```bash
export ORS_API_KEY="your-key-here"
```

(On Windows PowerShell: `$env:ORS_API_KEY="your-key-here"`)

### 4. Run the script

```bash
python3 pincode_distance.py 560076 560103
```

That's it. No `pip install` — the script uses only the Python standard library.

---

## Sample output

```
Loading pincode_data.csv ...
Loaded 19,561 pincodes with valid coordinates.
Backend: ORS

From: 560076  Mico Layout S.O, BENGALURU URBAN, KARNATAKA
To  : 560103  Bellandur S.O, BENGALURU URBAN, KARNATAKA

Road distance (ORS)  : 13.42 km
Estimated driving time : 32m
```

---

## More examples

| From | To | Route |
|---|---|---|
| `110001` | `400001` | New Delhi -> Mumbai |
| `110001` | `560001` | New Delhi -> Bangalore |
| `700001` | `600001` | Kolkata -> Chennai |
| `380001` | `411001` | Ahmedabad -> Pune |
| `560076` | `560103` | Bengaluru (Mico Layout -> Bellandur) |

```bash
python3 pincode_distance.py 700001 600001
```

---

## Bulk lookups (batch mode)

Calculate thousands of distances in one shot. Prepare a CSV with `from,to`:

```csv
from,to
110001,400001
110001,560001
700001,600001
560076,560103
```

Then run:

```bash
python3 pincode_distance.py --batch sample_pairs.csv results.csv
```

The script will:

1. Load all pincode coordinates
2. Skip pairs already cached (instant)
3. Group remaining pairs into ORS Matrix API calls (up to 50 locations per call)
4. Cache every result so re-runs are free
5. Write a results CSV

### How 20,000 lookups stays in the free tier

| | Free tier limit | Used for 20K pairs |
|---|---|---|
| Matrix calls / day | 500 | ~400 |
| Locations per call | 50 | up to 50 |
| Matrix calls / minute | 40 | rate-limited to ~37 by default |
| Cost | $0 | **$0** |

The script deduplicates locations within each chunk, so if many pairs share endpoints (e.g., one warehouse to many delivery pincodes) you'll use **far fewer** API calls.

### Output CSV columns

| Column | Description |
|---|---|
| `from`, `to` | Input pincodes |
| `from_office`, `from_district`, `from_state` | Origin info from the dataset |
| `to_office`, `to_district`, `to_state` | Destination info from the dataset |
| `road_km` | Road (transport) distance from ORS |
| `duration_min` | Estimated driving time in minutes |
| `status` | `ok`, `ok_cached`, `missing_coords`, `no_route`, or `ors_error: ...` |

---

## Configuration

All settings are environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `ORS_API_KEY` | *(required)* | Your OpenRouteService API key |
| `BACKEND` | `ors` | Routing backend: `ors` or `osrm` |
| `ORS_DELAY` | `1.6` | Seconds between ORS calls (40 calls/min limit) |
| `CACHE_DB` | `.pincode_cache.sqlite` | Local cache file path |
| `PINCODE_CSV` | `pincode_data.csv` | Path to the dataset |
| `OSRM_BASE` | public demo URL | OSRM endpoint when `BACKEND=osrm` |
| `OSRM_DELAY` | `1.0` | Seconds between OSRM calls in batch mode |

---

## Alternative backend: OSRM

If you'd rather use OSRM (no API key needed for the public demo, or self-host it for unlimited calls), set:

```bash
export BACKEND=osrm
python3 pincode_distance.py 560076 560103
```

### Self-hosted OSRM (truly unlimited)

For workloads beyond 20K/day, self-host OSRM with the included Docker setup. One-time preprocessing of the India OpenStreetMap extract takes ~30 min and ~8-16 GB RAM.

```bash
# 1. Download India OSM data + preprocess (one time)
./setup-osrm.sh

# 2. Start your local OSRM server
docker compose up -d

# 3. Point the script at it
export BACKEND=osrm
export OSRM_BASE=http://localhost:5000/route/v1/driving
export OSRM_DELAY=0

# 4. Run unlimited lookups
python3 pincode_distance.py --batch sample_pairs.csv results.csv
```

20K lookups against your local OSRM take roughly 3-4 minutes.

---

## Dataset

The file `pincode_data.csv` is sourced from the official India Post dataset.

| Field | Value |
|---|---|
| Total post offices | 165,627 |
| Unique pincodes | 19,586 |
| States / UTs covered | 37 |
| Rows with valid lat/long | ~93% |
| File size | ~22 MB |

### Columns

| Column | Description |
|---|---|
| `circlename` | Postal circle (e.g., Telangana Circle) |
| `regionname` | Postal region |
| `divisionname` | Postal division |
| `officename` | Name of the post office |
| `pincode` | 6-digit pincode |
| `officetype` | BO / SO / HO |
| `delivery` | Delivery status |
| `district` | District name |
| `statename` | State / UT name |
| `latitude` | Latitude (or `NA`) |
| `longitude` | Longitude (or `NA`) |

---

## How it works

```
   +-----------------+      +------------------+      +---------------------+
   | pincode_data.csv| ---> |  pincode -> lat/ | ---> |  ORS Matrix API     |
   |  (India Post)   |      |  long lookup     |      |  (chunked, cached)  |
   +-----------------+      +------------------+      +----------+----------+
                                                                 |
                                                                 v
                                                       +---------+----------+
                                                       |  road (transport)  |
                                                       |  km + driving time |
                                                       +--------------------+
```

1. **`load_pincode_coords()`** — parses `pincode_data.csv` and builds a `{pincode: (lat, lon, office, district, state)}` map. Uses the **first valid** row per pincode and skips `NA` rows.
2. **`ors_matrix()`** — POSTs locations to `https://api.openrouteservice.org/v2/matrix/driving-car` and returns the road distance + duration matrix.
3. **Batch chunking** — groups pairs so each ORS call carries up to 50 unique locations, deduplicating shared endpoints.
4. **SQLite cache** — every result is keyed `(min(pin1,pin2), max(pin1,pin2), backend)` so symmetric and repeated lookups are free.

---

## FAQ

**Q: Why OpenRouteService and not Google Maps?**
ORS is free, requires no credit card, and has a generous matrix endpoint. Google Maps Distance Matrix charges per call after a small free trial.

**Q: How accurate is the road distance?**
ORS uses the same OpenStreetMap road network as most open-source routers. For Indian highways and urban routes it's typically within a few percent of Google Maps.

**Q: Why are some pincodes not found?**
About 25 unique pincodes in the dataset have no valid coordinates (all rows are `NA`). Those can't be looked up.

**Q: Multiple post offices share one pincode — which location does it use?**
The **first valid row** per pincode in the CSV. This is typically the head post office but may not be the geographic centroid.

**Q: I hit my ORS daily quota — what now?**
Either wait 24 hours, or switch to self-hosted OSRM (`export BACKEND=osrm` after running `setup-osrm.sh`). Cached results never re-call the API.

**Q: Can I use this offline?**
Yes — self-host OSRM with `setup-osrm.sh` + `docker compose up`, then everything runs on `localhost`.

---

## Limitations

- ORS free tier: 500 matrix calls/day, 40/min, 50 locations/call.
- Island pincodes (Andaman & Nicobar, Lakshadweep) may fail to route.
- Post-office coordinates are not always precise — rural BOs in particular may be off by a few km.
- Cache file `.pincode_cache.sqlite` is local; share it across runs to save calls.

---

## Contributing

Pull requests welcome. Ideas:

- [ ] Simple Flask / FastAPI web UI
- [ ] Nearest-pincode search (given a lat/long)
- [ ] Bulk ETA-only mode for delivery planning
- [ ] CSV input that takes office names instead of pincodes

Open an issue or PR on [the repo](https://github.com/roy-substrate/indian-pincode-distance).

---

## License

MIT. Dataset belongs to India Post; please check their terms before redistribution.

---

<div align="center">

**If this helped you, please star the repo!**

Built with Python and OpenRouteService.

</div>
