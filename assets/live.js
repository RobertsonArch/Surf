// Live fetches done in the browser when a page opens (sources that allow it).
// Each returns rows in the same shape as the hourly data files.
window.live = (() => {
  const C16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const compass = (d) => (d == null ? null : C16[Math.round(((d % 360) + 360) % 360 / 22.5) % 16]);
  const clock = (hh, mm) => `${(hh + 11) % 12 + 1}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
  const hourLbl = (h) => `${(h + 11) % 12 + 1} ${h < 12 ? 'AM' : 'PM'}`;
  const ymd = (tz, offDays = 0) => {
    const d = new Date(Date.now() + offDays * 864e5);
    return d.toLocaleDateString('en-CA', { timeZone: tz });
  };
  const localAt = (ms, tz) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  };
  const get = async (url) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 12000);
    try {
      const r = await fetch(url, { signal: ctl.signal, cache: 'no-cache' });
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  const CO = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?units=english&time_zone=gmt&format=json&application=surf_dashboard';
  const BC = 'America/Vancouver', WA = BC; // every page shows BC time
  const range = (tz) => `&begin_date=${ymd(tz, -1).replace(/-/g, '')}&end_date=${ymd(tz, 2).replace(/-/g, '')}`;

  async function apTides() {
    const j = await get(`${CO}&product=predictions&station=9444090&datum=MLLW&interval=hilo${range(WA)}`);
    return j.predictions.map((p) => {
      const at = localAt(Date.parse(p.t.replace(' ', 'T') + ':00Z'), BC);
      return { day: at.slice(0, 10), at, time: clock(+at.slice(11, 13), +at.slice(14, 16)), type: p.type === 'H' ? 'High' : 'Low', height_ft: Math.round(+p.v * 10) / 10 };
    });
  }
  async function apCurrents() {
    const j = await get(`${CO}&product=currents_predictions&station=PUG1639&bin=16&interval=MAX_SLACK${range(WA)}`);
    return j.current_predictions.cp.map((p) => {
      const at = localAt(Date.parse(p.Time.replace(' ', 'T') + ':00Z'), BC);
      const type = p.Type[0].toUpperCase() + p.Type.slice(1);
      const d = type === 'Flood' ? p.meanFloodDir : type === 'Ebb' ? p.meanEbbDir : null;
      return { day: at.slice(0, 10), at, time: clock(+at.slice(11, 13), +at.slice(14, 16)), type, speed_kt: type === 'Slack' ? null : Math.round(Math.abs(+p.Velocity_Major) * 10) / 10, direction: d == null ? null : compass(+d) };
    });
  }
  async function meteo(lat, lon, tz) {
    const q = new URLSearchParams({ latitude: lat, longitude: lon, timezone: tz, hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation_probability,precipitation,weather_code,is_day', daily: 'sunrise,sunset', past_days: 1, forecast_days: 4, wind_speed_unit: 'kmh' });
    const j = await get('https://api.open-meteo.com/v1/forecast?' + q);
    const h = j.hourly;
    const wind = h.time.map((t, i) => (h.wind_speed_10m[i] == null ? null : {
      day: t.slice(0, 10), hour: +t.slice(11, 13), time: hourLbl(+t.slice(11, 13)), at: t.slice(0, 13) + ':00',
      dir_deg: h.wind_direction_10m[i] == null ? null : Math.round(h.wind_direction_10m[i]), wind_dir: compass(h.wind_direction_10m[i]),
      wind_kmh: Math.round(h.wind_speed_10m[i]), gust_kmh: h.wind_gusts_10m[i] == null ? null : Math.round(h.wind_gusts_10m[i]),
      temp_c: h.temperature_2m?.[i] == null ? null : Math.round(h.temperature_2m[i]), pop: h.precipitation_probability?.[i] ?? null, rain_mm: h.precipitation?.[i] ?? null, code: h.weather_code?.[i] ?? null, is_day: h.is_day?.[i] ?? null,
    })).filter(Boolean);
    const sun = j.daily.time.map((d, i) => ({ day: d, sunrise: j.daily.sunrise[i].slice(11, 16), sunset: j.daily.sunset[i].slice(11, 16) }));
    return { wind, sun };
  }
  async function tofinoTides() {
    const a = new Date(`${ymd(BC, -1)}T00:00:00Z`).getTime() - 864e5 / 2, b = a + 4.5 * 864e5;
    const q = new URLSearchParams({ 'time-series-code': 'wlp-hilo', from: new Date(a).toISOString().slice(0, 19) + 'Z', to: new Date(b).toISOString().slice(0, 19) + 'Z' });
    const j = await get('https://api-iwls.dfo-mpo.gc.ca/api/v1/stations/5cebf1e23d0f4a073c4bc07c/data?' + q);
    const pts = j.map((p) => ({ t: Date.parse(p.eventDate), v: +p.value })).sort((x, y) => x.t - y.t);
    return pts.map((p, i) => {
      const nb = [pts[i - 1], pts[i + 1]].filter(Boolean).map((x) => x.v);
      const at = localAt(p.t, BC);
      return { day: at.slice(0, 10), at, time: clock(+at.slice(11, 13), +at.slice(14, 16)), type: nb.every((x) => p.v > x) ? 'High' : 'Low', height_ft: Math.round(p.v * 3.28084 * 10) / 10 };
    });
  }
  // shared promise per page load so wind and sun come from one request
  const memo = {};
  const once = (k, fn) => (memo[k] = memo[k] || fn());
  return {
    apTides, apCurrents, tofinoTides,
    apWind: () => once('ap', () => meteo(48.146, -123.565, WA)).then((r) => r.wind),
    apSun: () => once('ap', () => meteo(48.146, -123.565, WA)).then((r) => r.sun),
    tofinoWind: () => once('tof', () => meteo(49.12, -125.90, BC)).then((r) => r.wind),
    tofinoSun: () => once('tof', () => meteo(49.12, -125.90, BC)).then((r) => r.sun),
    reset: () => { for (const k in memo) delete memo[k]; },
  };
})();
