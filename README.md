<div align="center">

# Indian Pincode Distance Calculator

**Find the real road (driving) distance between any two Indian pincodes.**

Powered by the official India Post pincode dataset and the OSRM routing engine.

[![Python](https://img.shields.io/badge/python-3.7+-blue.svg)](https://www.python.org/downloads/)
[![License](https://img.shields.io/badge/license-MIT-green.svg)](#license)
[![Dataset](https://img.shields.io/badge/pincodes-19%2C586-orange.svg)](#dataset)
[![OSRM](https://img.shields.io/badge/routing-OSRM-red.svg)](https://project-osrm.org/)

</div>

---

## What this does

Given two Indian pincodes, this tool returns:

- **Road distance** (actual driving distance along roads) via OSRM
- **Estimated driving time** (hours/minutes)
- **Aerial distance** (straight-line haversine) for comparison
- **Detour factor** (how much longer the road is vs. straight line)

No API keys. No sign-up. Zero dependencies beyond the Python standard library.

---

## Quick start (3 steps)

### 1. Fork & clone

Click the **Fork** button at the top-right of this repo, then:

```bash
git clone https://github.com/<your-username>/Indian-Pincode-Distance.git
cd Indian-Pincode-Distance
```

### 2. Make sure Python 3.7+ is installed

```bash
python3 --version
```

That's it — no `pip install` needed. The script uses only the standard library.

### 3. Run the script

```bash
python3 pincode_distance.py <from_pincode> <to_pincode>
```

**Example:** Delhi to Mumbai

```bash
python3 pincode_distance.py 110001 400001
```

---

## Sample output

```
Loading pincode_data.csv ...
Loaded 19,561 pincodes with valid coordinates.

From: 110001  Baroda House SO, NEW DELHI, DELHI  (28.61742, 77.21292)
To  : 400001  MPT SO, MUMBAI, MAHARASHTRA  (18.93614, 72.83778)

Aerial (haversine) distance : 1,164.61 km
Road distance (OSRM)        : 1,416.23 km
Estimated driving time      : 24h 31m
Detour factor (road/aerial) : 1.22x
```

---

## More examples

| From | To | Route |
|---|---|---|
| `110001` | `560001` | New Delhi -> Bangalore |
| `700001` | `600001` | Kolkata -> Chennai |
| `380001` | `411001` | Ahmedabad -> Pune |
| `682001` | `695001` | Kochi -> Thiruvananthapuram |

```bash
python3 pincode_distance.py 700001 600001
```

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
      +-----------------+        +------------------+        +--------------+
      | pincode_data.csv| -----> | Build lat/long   | -----> |  OSRM API    |
      |  (India Post)   |        | lookup per pin   |        | (road route) |
      +-----------------+        +------------------+        +------+-------+
                                                                     |
                                                                     v
                                                          +----------+---------+
                                                          |  Distance + time   |
                                                          |  + detour factor   |
                                                          +--------------------+
```

1. **`load_pincode_coords()`** — parses `pincode_data.csv` and builds a `{pincode: (lat, lon, office, district, state)}` map. Uses the **first valid** coordinate per pincode and skips rows with `NA`.
2. **`haversine_km()`** — great-circle straight-line distance in km, used for the aerial comparison.
3. **`osrm_route()`** — calls the public OSRM API at `https://router.project-osrm.org/route/v1/driving/lon,lat;lon,lat` and parses the response for distance (metres) and duration (seconds).
4. **`main()`** — prints both distances, the estimated driving time, and the detour factor.

---

## FAQ

**Q: Do I need a Google Maps API key?**
No. This uses the free public OSRM demo — no key, no sign-up.

**Q: Is the road distance exact?**
It's as accurate as OpenStreetMap road data for India. For most urban and highway routes it's within a few percent of Google Maps.

**Q: Why are some pincodes not found?**
About 25 unique pincodes in the dataset have no valid coordinates (all their post-office rows are `NA`). Those can't be looked up.

**Q: Can I use this for thousands of lookups?**
The public OSRM demo is rate-limited. For heavy/batch use, self-host OSRM or switch to [OpenRouteService](https://openrouteservice.org/) / Google Maps Distance Matrix.

**Q: Multiple post offices share one pincode — which location does it use?**
The **first valid row** per pincode in the CSV. This is typically the head post office but may not be the geographic centroid.

---

## Limitations

- Requires internet access (OSRM is an online API).
- The OSRM public demo has rate limits — don't hammer it in a loop.
- Straight-line detour factor assumes both points are reachable by road. Island pincodes (e.g., Andaman & Nicobar, Lakshadweep) may fail to route.
- Post office coordinates are not always precise — rural BOs in particular may be off by a few km.

---

## Contributing

Pull requests welcome. Ideas that would be nice to have:

- [ ] Batch mode: read pairs from a CSV, write a result CSV
- [ ] Simple Flask / FastAPI web UI
- [ ] Caching of OSRM responses to avoid repeat calls
- [ ] Fallback to OpenRouteService if OSRM is down
- [ ] Nearest-pincode search (given a lat/long)

Open an issue or PR on [the repo](https://github.com/roy-substrate/indian-pincode-distance).

---

## License

MIT. Dataset belongs to India Post; please check their terms before redistribution.

---

<div align="center">

**If this helped you, please star the repo!**

Built with Python and OSRM.

</div>
