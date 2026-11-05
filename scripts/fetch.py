#!/usr/bin/env python3
"""Hourly data refresh for the surf site.

Pulls live buoy readings and wind (NOAA NDBC), tide and current predictions
(NOAA CO-OPS; Fisheries and Oceans Canada for Tofino) and the hourly wind
forecast plus sunrise/sunset (Open-Meteo), and writes JSON files into data/.

Each source is fetched independently: if one fails, its previous file is kept
and the failure is recorded in data/meta.json.
"""
import datetime as dt
import json
import math
import os
import re
import sys
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Vancouver")      # Tofino / Ucluelet (BC)
TZ_WA = ZoneInfo("America/Los_Angeles")  # Angeles Point (Washington)
UTC = dt.timezone.utc
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("SURF_DATA") or os.path.join(ROOT, "data")
UA = "surf-dashboard (github.com/RobertsonArch/surf)"
FIX = os.environ.get("SURF_FIXTURES")  # directory of saved responses, for offline tests

M2FT = 3.28084
COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE",
           "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]

NOW = dt.datetime.now(UTC)
TODAY = NOW.astimezone(TZ).date()
TODAY_WA = NOW.astimezone(TZ_WA).date()


def compass(deg):
    if deg is None:
        return None
    return COMPASS[int((deg % 360) / 22.5 + 0.5) % 16]


_CACHE = {}


def get(url, key=None):
    ck = key or url
    if ck in _CACHE:
        return _CACHE[ck]
    _CACHE[ck] = _get(url, key)
    return _CACHE[ck]


def _get(url, key=None):
    if FIX and key:
        with open(os.path.join(FIX, key)) as f:
            return f.read()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Cache-Control": "no-cache"})
    with urllib.request.urlopen(req, timeout=60) as r:
        raw = r.read()
    if url.split("?")[0].endswith(".gz"):
        import gzip
        try:
            raw = gzip.decompress(raw)
        except OSError:
            pass
    return raw.decode("utf-8", "replace")


def at_str(t, tz=TZ):
    return t.astimezone(tz).strftime("%Y-%m-%dT%H:%M")


def clock(t, tz=TZ):
    t = t.astimezone(tz)
    return f"{(t.hour + 11) % 12 + 1}:{t.minute:02d} {'AM' if t.hour < 12 else 'PM'}"


def hour_label(h):
    return f"{(h + 11) % 12 + 1} {'AM' if h < 12 else 'PM'}"


def write(name, obj):
    path = os.path.join(DATA, name)
    with open(path + ".tmp", "w") as f:
        json.dump(obj, f, separators=(",", ":"))
    os.replace(path + ".tmp", path)


# ---------------------------------------------------------------- NDBC

def ndbc(station, ext="txt"):
    """Parse an NDBC realtime2 file into a list of dicts (UTC datetime under 't')."""
    txt = get(f"https://www.ndbc.noaa.gov/data/realtime2/{station}.{ext}?t={int(NOW.timestamp())}",
              f"{station}.{ext}")
    lines = txt.splitlines()
    head = lines[0].lstrip("#").split()
    out = []
    for ln in lines:
        if not ln.strip() or ln.startswith("#"):
            continue
        p = ln.split()
        row = dict(zip(head, p))
        try:
            row["t"] = dt.datetime(int(p[0]), int(p[1]), int(p[2]), int(p[3]), int(p[4]), tzinfo=UTC)
        except (ValueError, IndexError):
            continue
        out.append(row)
    return out


def fnum(v):
    if v in (None, "MM", "N/A", "999", "999.0", "99.00", "9999.0"):
        return None
    try:
        return float(v)
    except ValueError:
        return None


def recent(rows, hours=26):
    cut = NOW - dt.timedelta(hours=hours)
    return sorted((r for r in rows if r["t"] >= cut), key=lambda r: r["t"])


def ndbc_spectrum(station):
    """Latest spectral density (m^2/Hz) and mean direction per frequency."""
    def parse(ext):
        txt = get(f"https://www.ndbc.noaa.gov/data/realtime2/{station}.{ext}?t={int(NOW.timestamp())}",
                  f"{station}.{ext}")
        for ln in txt.splitlines():
            if ln.startswith("#") or not ln.strip():
                continue
            p = ln.split()
            t = dt.datetime(int(p[0]), int(p[1]), int(p[2]), int(p[3]), int(p[4]), tzinfo=UTC)
            pairs = re.findall(r"([-\d.]+)\s*\(([\d.]+)\)", ln)
            return t, [(float(f), float(v)) for v, f in pairs]
        return None, []
    t, dens = parse("data_spec")
    t2, dirs = parse("swdir")
    dmap = {f: v for f, v in dirs} if t2 == t else {}
    freqs = [f for f, _ in dens]
    return t, freqs, [v for _, v in dens], [dmap.get(f) for f in freqs]


def circ_mean(angles, weights):
    x = sum(w * math.cos(math.radians(a)) for a, w in zip(angles, weights))
    y = sum(w * math.sin(math.radians(a)) for a, w in zip(angles, weights))
    if x == 0 and y == 0:
        return None
    return math.degrees(math.atan2(y, x)) % 360


def ang_diff(a, b):
    if a is None or b is None:
        return 180
    return abs((a - b + 180) % 360 - 180)


def split_swells(freqs, dens, dirs):
    """Split a 1-D spectrum into swell trains (watershed on peaks, then merge).

    Returns up to 4 trains, largest first: height ft, peak period s, direction.
    """
    n = len(freqs)
    if n < 5:
        return []
    bw = []
    for i in range(n):
        lo = (freqs[i] + freqs[i - 1]) / 2 if i > 0 else freqs[0] - (freqs[1] - freqs[0]) / 2
        hi = (freqs[i] + freqs[i + 1]) / 2 if i < n - 1 else freqs[-1] + (freqs[-1] - freqs[-2]) / 2
        bw.append(hi - lo)
    s = [(dens[max(i - 1, 0)] + 2 * dens[i] + dens[min(i + 1, n - 1)]) / 4 for i in range(n)]

    def climb(i):
        while True:
            j = i
            if i > 0 and s[i - 1] > s[j]:
                j = i - 1
            if i < n - 1 and s[i + 1] > s[j]:
                j = i + 1
            if j == i:
                return i
            i = j

    groups = {}
    for i in range(n):
        if s[i] <= 0:
            continue
        groups.setdefault(climb(i), []).append(i)
    parts = []
    for pk, bins in groups.items():
        bins.sort()
        m0 = sum(dens[b] * bw[b] for b in bins)
        okd = [(dirs[b], dens[b] * bw[b]) for b in bins if dirs[b] is not None and dirs[b] < 400]
        parts.append({"bins": bins, "pk": pk, "m0": m0,
                      "dir": circ_mean([a for a, _ in okd], [w for _, w in okd]) if okd else None})
    parts.sort(key=lambda p: p["bins"][0])
    total = sum(p["m0"] for p in parts) or 1

    def merge(a, b):
        bins = sorted(a["bins"] + b["bins"])
        okd = [(dirs[x], dens[x] * bw[x]) for x in bins if dirs[x] is not None and dirs[x] < 400]
        pk = a["pk"] if s[a["pk"]] >= s[b["pk"]] else b["pk"]
        return {"bins": bins, "pk": pk, "m0": a["m0"] + b["m0"],
                "dir": circ_mean([d for d, _ in okd], [w for _, w in okd]) if okd else None}

    changed = True
    while changed and len(parts) > 1:
        changed = False
        for i in range(len(parts) - 1):
            a, b = parts[i], parts[i + 1]
            valley = min(s[x] for x in range(a["bins"][-1], b["bins"][0] + 1))
            lower = min(s[a["pk"]], s[b["pk"]])
            tiny = min(a["m0"], b["m0"]) < 0.04 * total
            same = ang_diff(a["dir"], b["dir"]) <= 30 and valley >= 0.6 * lower
            if tiny or same:
                parts[i:i + 2] = [merge(a, b)]
                changed = True
                break
    out = []
    for p in sorted(parts, key=lambda p: -p["m0"]):
        hs = 4 * math.sqrt(p["m0"]) * M2FT
        if hs < 0.3:
            continue
        out.append({"height_ft": round(hs, 1), "period_s": round(1 / freqs[p["pk"]], 1),
                    "dir_deg": None if p["dir"] is None else round(p["dir"]),
                    "direction": compass(p["dir"])})
    return out[:4]


def spec_table(station):
    """The .spec summary: swell / wind-wave split and swell-only direction."""
    rows = {}
    for r in ndbc(station, "spec"):
        rows[r["t"]] = r
    return rows


def buoy_rows(station, spec=None, tz=TZ):
    out = []
    for r in recent(ndbc(station)):
        wv = fnum(r.get("WVHT"))
        if wv is None:
            continue
        row = {"at": at_str(r["t"], tz), "utc": r["t"].isoformat(), "wave_ft": round(wv * M2FT, 1),
               "period_s": fnum(r.get("DPD")), "avg_period_s": fnum(r.get("APD")),
               "mwd_deg": fnum(r.get("MWD")),
               "wind_kmh": None if fnum(r.get("WSPD")) is None else round(fnum(r["WSPD"]) * 3.6),
               "_t": r["t"]}
        if row["period_s"] is None and out and (r["t"] - out[-1]["_t"]).total_seconds() <= 40 * 60:
            row["period_s"] = out[-1]["period_s"]  # some 10-minute rows report height without period
        if row["period_s"] is not None:
            row["period_s"] = round(row["period_s"])
        swd, dtype = None, None
        if spec:
            near = [k for k in spec if abs((k - r["t"]).total_seconds()) <= 40 * 60]
            if near:
                k = min(near, key=lambda k: abs((k - r["t"]).total_seconds()))
                sd = spec[k].get("SwD")
                if sd and sd not in ("MM", "N/A"):
                    swd, dtype = sd, "swell only"
        if swd is None and row["mwd_deg"] is not None:
            swd, dtype = compass(row["mwd_deg"]), "mean wave"
        row["direction"], row["dir_type"] = swd, dtype
        out.append(row)
    return out


def strip(rows, keep):
    return [{k: r.get(k) for k in keep} for r in rows]


def wind_obs(station, name, tz=TZ_WA):
    out = []
    for r in recent(ndbc(station), 24):
        sp = fnum(r.get("WSPD"))
        if sp is None:
            continue
        d = fnum(r.get("WDIR"))
        g = fnum(r.get("GST"))
        out.append({"station": name, "at": at_str(r["t"], tz), "dir_deg": d, "wind_dir": compass(d),
                    "wind_kmh": round(sp * 3.6), "gust_kmh": None if g is None else round(g * 3.6)})
    return out


# ---------------------------------------------------------------- buoy history (for the calculator)

MONS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


def parse_std(txt):
    """Rows of an NDBC stdmet text file -> {hour_epoch: (h_cm, p_ds, d)} keeping the largest wave per hour."""
    out = {}
    for ln in txt.splitlines():
        p = ln.split()
        if len(p) < 12 or not re.fullmatch(r"\d{4}", p[0]):
            continue
        try:
            t = dt.datetime(int(p[0]), int(p[1]), int(p[2]), int(p[3]), int(p[4]), tzinfo=UTC)
        except ValueError:
            continue
        h, per, d = fnum(p[8]), fnum(p[9]), fnum(p[11])
        if h is None or h >= 99:
            continue
        per = None if per is None or per >= 99 else per
        d = None if d is None or d >= 999 else d
        k = int(t.timestamp()) // 3600
        if k not in out or h * 100 > out[k][0]:
            out[k] = (round(h * 100), None if per is None else round(per * 10), None if d is None else round(d))
    return out


def history(station, seed=False):
    """Hourly wave history per year in data/history/<station>_<year>.json as [hour, h_cm, p_ds, dir]."""
    hdir = os.path.join(DATA, "history")
    os.makedirs(hdir, exist_ok=True)
    rows = parse_std(get(f"https://www.ndbc.noaa.gov/data/realtime2/{station}.txt?t={int(NOW.timestamp())}", f"{station}.txt"))
    years = {}
    if seed:
        for y in range(2020, NOW.year):
            path = os.path.join(hdir, f"{station}_{y}.json")
            if os.path.exists(path):
                continue
            try:
                txt = get(f"https://www.ndbc.noaa.gov/data/historical/stdmet/{station}h{y}.txt.gz")
                years[y] = parse_std(txt)
            except Exception as e:
                print("WARN history", station, y, e, file=sys.stderr)
        for m in range(1, 13):
            if m > NOW.month:
                break
            base = "https://www.ndbc.noaa.gov/view_text_file.php?filename={}&dir=data/stdmet/" + MONS[m - 1] + "/"
            for url in (base.format(f"{station}{m}{NOW.year}.txt.gz"), base.format(f"{station}{m:x}{NOW.year}.txt.gz"),
                        f"https://www.ndbc.noaa.gov/data/stdmet/{MONS[m - 1]}/{station}.txt"):
                try:
                    got = parse_std(get(url))
                    if not got:
                        continue
                    rows = {**got, **rows}
                    break
                except Exception:
                    continue
    for k, v in rows.items():
        y = dt.datetime.fromtimestamp(k * 3600, UTC).year
        years.setdefault(y, {})[k] = v
    for y, new in years.items():
        path = os.path.join(hdir, f"{station}_{y}.json")
        old = {}
        if os.path.exists(path):
            old = {r[0]: tuple(r[1:]) for r in json.load(open(path))}
        old.update(new)
        with open(path, "w") as f:
            json.dump([[k, *v] for k, v in sorted(old.items())], f, separators=(",", ":"))


# ---------------------------------------------------------------- GFS-Wave buoy forecast (what Stormsurf charts)

NOMADS = "https://nomads.ncep.noaa.gov/pub/data/nccf/com/gfs/prod"
AWS_GFS = "https://noaa-gfs-bdp-pds.s3.amazonaws.com"  # NOAA's open-data copy; NOMADS blocks many cloud hosts


def wave_bulletin(station, cycle):
    """Parse NOAA's GFS-Wave point bulletin. Bulletin dir is where waves travel to; we return 'from'."""
    d, hh = cycle
    path = f"gfs.{d:%Y%m%d}/{hh:02d}/wave/station/bulls.t{hh:02d}z/gfswave.{station}.bull"
    try:
        txt = get(f"{AWS_GFS}/{path}")
    except Exception:
        txt = get(f"{NOMADS}/{path}")
    base = dt.datetime(d.year, d.month, d.day, hh, tzinfo=UTC)
    out = []
    prev = base
    for ln in txt.splitlines():
        m = re.match(r"\s*\|\s*(\d+)\s+(\d+)\s*\|\s*([\d.]+)", ln)
        if not m:
            continue
        day, hour, hst = int(m.group(1)), int(m.group(2)), float(m.group(3))
        t = prev.replace(hour=hour, minute=0)
        while t.day != day or t < prev:  # walk forward to the row's day of month
            t = (t + dt.timedelta(days=1)).replace(hour=hour)
            if (t - prev).days > 3:
                break
        prev = t
        trains = []
        for cell in ln.split("|")[3:]:
            v = re.findall(r"\d+(?:\.\d+)?", cell)  # cells can carry a '*' (local wind sea) marker
            if len(v) >= 3:
                h, tp, to = float(v[0]), float(v[1]), float(v[2])
                trains.append({"height_ft": round(h * M2FT, 1), "period_s": round(tp, 1),
                               "dir_deg": round((to + 180) % 360), "direction": compass((to + 180) % 360)})
        trains.sort(key=lambda x: -x["height_ft"])
        out.append({"utc": t.isoformat(), "hs_ft": round(hst * M2FT, 1), "hs_m": hst, "trains": trains[:3]})
    if not out:
        raise ValueError("empty bulletin")
    return out


def latest_cycle(station="46087"):
    t = NOW - dt.timedelta(hours=4)  # bulletins appear ~4 h after the cycle time
    for _ in range(8):
        hh = (t.hour // 6) * 6
        cyc = (t.date(), hh)
        try:
            wave_bulletin(station, cyc)
            return cyc
        except Exception as e:
            print("WARN cycle", cyc, repr(e)[:200], file=sys.stderr)
            t = t.replace(hour=hh, minute=0) - dt.timedelta(hours=6)
    raise RuntimeError("no GFS-Wave cycle found")


# ---------------------------------------------------------------- NOAA CO-OPS

def coops(params, key):
    q = {"units": "english", "time_zone": "lst_ldt", "format": "json", "application": "surf_dashboard", **params}
    return json.loads(get("https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?" + urllib.parse.urlencode(q), key))


def ldt(s):
    return dt.datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=TZ_WA)


def tides_ap(begin, end, key="coops_tides"):
    j = coops({"product": "predictions", "station": "9444090", "datum": "MLLW", "interval": "hilo",
               "begin_date": begin.strftime("%Y%m%d"), "end_date": end.strftime("%Y%m%d")}, key)
    out = []
    for p in j["predictions"]:
        t = ldt(p["t"])
        out.append({"day": t.strftime("%Y-%m-%d"), "at": t.strftime("%Y-%m-%dT%H:%M"), "time": clock(t, TZ_WA),
                    "type": "High" if p["type"] == "H" else "Low", "height_ft": round(float(p["v"]), 1)})
    return out


CUR_STATION, CUR_BIN = "PUG1639", 16  # Angeles Pt., 2 mi. NNE of — near-surface bin


def currents_ap(begin, end, key="coops_currents"):
    j = coops({"product": "currents_predictions", "station": CUR_STATION, "bin": CUR_BIN, "interval": "MAX_SLACK",
               "begin_date": begin.strftime("%Y%m%d"), "end_date": end.strftime("%Y%m%d")}, key)
    out = []
    for p in j["current_predictions"]["cp"]:
        t = ldt(p["Time"])
        typ = p["Type"].capitalize()
        v = abs(float(p["Velocity_Major"]))
        d = p.get("meanFloodDir") if typ == "Flood" else p.get("meanEbbDir") if typ == "Ebb" else None
        out.append({"day": t.strftime("%Y-%m-%d"), "at": t.strftime("%Y-%m-%dT%H:%M"), "time": clock(t, TZ_WA),
                    "type": typ, "speed_kt": None if typ == "Slack" else round(v, 1),
                    "direction": None if typ == "Slack" or d is None else compass(float(d))})
    return out


# ---------------------------------------------------------------- DFO (Tofino tides)

TOFINO_IWLS = "5cebf1e23d0f4a073c4bc07c"


def tides_tofino():
    a = dt.datetime.combine(TODAY - dt.timedelta(days=1), dt.time(0), TZ).astimezone(UTC)
    b = a + dt.timedelta(days=4)
    q = urllib.parse.urlencode({"time-series-code": "wlp-hilo",
                                "from": a.strftime("%Y-%m-%dT%H:%M:%SZ"), "to": b.strftime("%Y-%m-%dT%H:%M:%SZ")})
    j = json.loads(get(f"https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/{TOFINO_IWLS}/data?{q}", "iwls_tofino"))
    pts = [(dt.datetime.fromisoformat(p["eventDate"].replace("Z", "+00:00")), float(p["value"])) for p in j]
    pts.sort()
    out = []
    for i, (t, v) in enumerate(pts):
        nb = [pts[k][1] for k in (i - 1, i + 1) if 0 <= k < len(pts)]
        typ = "High" if all(v > x for x in nb) else "Low"
        lt = t.astimezone(TZ)
        out.append({"day": lt.strftime("%Y-%m-%d"), "at": lt.strftime("%Y-%m-%dT%H:%M"), "time": clock(t),
                    "type": typ, "height_ft": round(v * M2FT, 1)})
    return out


# ---------------------------------------------------------------- Open-Meteo

def open_meteo(lat, lon, key, tzname):
    q = urllib.parse.urlencode({
        "latitude": lat, "longitude": lon, "timezone": tzname,
        "hourly": "wind_speed_10m,wind_direction_10m,wind_gusts_10m",
        "daily": "sunrise,sunset", "past_days": 1, "forecast_days": 4, "wind_speed_unit": "kmh"})
    j = json.loads(get("https://api.open-meteo.com/v1/forecast?" + q, key))
    h = j["hourly"]
    wind = []
    for t, sp, d, g in zip(h["time"], h["wind_speed_10m"], h["wind_direction_10m"], h["wind_gusts_10m"]):
        if sp is None:
            continue
        hr = int(t[11:13])
        wind.append({"day": t[:10], "hour": hr, "time": hour_label(hr), "at": t[:13] + ":00",
                     "dir_deg": None if d is None else round(d), "wind_dir": compass(d),
                     "wind_kmh": round(sp), "gust_kmh": None if g is None else round(g)})
    sun = [{"day": d, "sunrise": r[11:16], "sunset": s[11:16]}
           for d, r, s in zip(j["daily"]["time"], j["daily"]["sunrise"], j["daily"]["sunset"])]
    return wind, sun


# ---------------------------------------------------------------- main

def main():
    os.makedirs(DATA, exist_ok=True)
    meta_path = os.path.join(DATA, "meta.json")
    try:
        meta = json.load(open(meta_path))
    except (OSError, ValueError):
        meta = {}
    meta.setdefault("sources", {})
    errors = []

    def job(name, fn):
        try:
            fn()
            meta["sources"][name] = {"ok": True, "at": NOW.isoformat(timespec="seconds")}
        except Exception as e:  # keep the previous file
            errors.append(f"{name}: {e!r}")
            meta["sources"].setdefault(name, {})["ok"] = False
            meta["sources"][name]["error"] = repr(e)[:300]
            meta["sources"][name]["failed_at"] = NOW.isoformat(timespec="seconds")

    def buoys():
        spec87 = spec_table("46087")
        spec67 = spec_table("46267")
        ap = buoy_rows("46267", spec67, TZ_WA)
        neah = buoy_rows("46087", spec87, TZ_WA)
        lp = buoy_rows("46206", None, TZ_WA)
        write("ap_buoy.json", strip(ap, ["at", "utc", "wave_ft", "period_s", "direction", "dir_type"]))
        write("neah_buoy.json", strip(neah, ["at", "utc", "wave_ft", "period_s", "direction", "dir_type"]))
        write("lp_buoy.json", strip(lp, ["at", "utc", "wave_ft", "period_s", "wind_kmh"]))
        bc = lambda rows: [{**r, "at": dt.datetime.fromisoformat(r["utc"]).astimezone(TZ).strftime("%Y-%m-%dT%H:%M")} for r in rows]
        lp, neah = bc(lp), bc(neah)
        both = ([{"buoy": "La Perouse Bank", "at": r["at"], "utc": r["utc"], "wave_ft": r["wave_ft"], "swell_dir": None,
                  "period_s": r["period_s"], "avg_period_s": r["avg_period_s"], "wind_kmh": r["wind_kmh"],
                  "dir_type": None} for r in lp]
                + [{"buoy": "Neah Bay", "at": r["at"], "utc": r["utc"], "wave_ft": r["wave_ft"], "swell_dir": r["direction"],
                    "period_s": r["period_s"], "avg_period_s": r["avg_period_s"], "wind_kmh": r["wind_kmh"],
                    "dir_type": r["dir_type"]} for r in neah])
        write("buoys.json", both)

    def swells():
        out = []
        for st, name in (("46087", "Neah Bay"), ("46267", "Angeles Point")):
            t, f, d, a = ndbc_spectrum(st)
            if t is None:
                continue
            out.append({"buoy": name, "utc": t.isoformat(), "trains": split_swells(f, d, a)})
        write("swells.json", out)

    def wind_measured():
        rows = []
        for st, name in (("46087", "Neah Bay"), ("46206", "La Perouse Bank"),
                         ("PTAW1", "Port Angeles"), ("46088", "New Dungeness")):
            try:
                rows += wind_obs(st, name)
            except Exception as e:
                errors.append(f"wind {st}: {e!r}")
        write("wind_obs.json", rows)

    def ap_tides():
        write("tides.json", tides_ap(TODAY_WA - dt.timedelta(days=1), TODAY_WA + dt.timedelta(days=2)))

    def ap_currents():
        write("currents.json", currents_ap(TODAY_WA - dt.timedelta(days=1), TODAY_WA + dt.timedelta(days=2)))

    def ap_wind():
        wind, sun = open_meteo(48.146, -123.565, "om_ap", "America/Los_Angeles")
        write("wind.json", wind)
        write("sun.json", sun)

    def tofino_wind():
        wind, sun = open_meteo(49.12, -125.90, "om_tofino", "America/Vancouver")
        write("tofino_wind.json", wind)
        write("tofino_sun.json", sun)

    def tofino_tides():
        write("tofino_tides.json", tides_tofino())

    def calendar():
        # Six months of predicted tide turns and current max/slack for the Elwha calendars.
        start = TODAY_WA.replace(day=1)
        months = []
        y, m = start.year, start.month
        for _ in range(7):
            months.append((y, m))
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        tides, cur = [], []
        for (y, m), (y2, m2) in zip(months, months[1:]):
            a = dt.date(y, m, 1) - dt.timedelta(days=1)
            b = dt.date(y2, m2, 1)
            tides += tides_ap(a, b, f"coops_tides_{y}{m:02d}")
            cur += currents_ap(a, b, f"coops_currents_{y}{m:02d}")
        dedup = lambda rows: list({r["at"]: r for r in rows}.values())
        write("cal_tides.json", sorted(dedup(tides), key=lambda r: r["at"]))
        write("cal_currents.json", sorted(dedup(cur), key=lambda r: r["at"]))

    def hist():
        seed = "--seed" in sys.argv or not os.path.exists(os.path.join(DATA, "history", f"46087_{NOW.year - 1}.json"))
        for st in ("46087", "46267"):
            history(st, seed)

    def wave_fc():
        cyc = latest_cycle()
        out = {"cycle": dt.datetime(cyc[0].year, cyc[0].month, cyc[0].day, cyc[1], tzinfo=UTC).isoformat(),
               "model": "NOAA GFS-Wave (WAVEWATCH III)", "stations": {}}
        for st in ("46087", "46206"):  # Angeles Point (46267) is not a model output point
            try:
                out["stations"][st] = wave_bulletin(st, cyc)
            except Exception as e:
                errors.append(f"forecast {st}: {e!r}")
        write("wave_forecast.json", out)

    job("buoys", buoys)
    job("history", hist)
    job("wave_forecast", wave_fc)
    job("swells", swells)
    job("wind_obs", wind_measured)
    job("tides", ap_tides)
    job("currents", ap_currents)
    job("wind", ap_wind)
    job("tofino_wind", tofino_wind)
    job("tofino_tides", tofino_tides)
    hour = NOW.astimezone(TZ_WA).hour
    daily = hour == 3 and NOW.minute < 10
    if "--calendar" in sys.argv or daily or not os.path.exists(os.path.join(DATA, "cal_tides.json")):
        job("calendar", calendar)

    meta["updated"] = NOW.isoformat(timespec="seconds")
    meta["current_station"] = f"{CUR_STATION} bin {CUR_BIN}"
    write("meta.json", meta)
    for e in errors:
        print("WARN", e, file=sys.stderr)


if __name__ == "__main__":
    main()
