// Hourly forecast strip: today, hour by hour of weather, wind, swell and tide (and,
// for the Elwha, current and the spot's surf rules), in one scrollable table.
window.hourly = (() => {
  const WX = (c, day) => {
    if (c == null) return ['', ''];
    if (c === 0) return [day ? '☀️' : '🌙', 'Clear'];
    if (c <= 2) return [day ? '🌤️' : '☁️', 'Partly cloudy'];
    if (c === 3) return ['☁️', 'Cloudy'];
    if (c === 45 || c === 48) return ['🌫️', 'Fog'];
    if (c >= 51 && c <= 57) return ['🌦️', 'Drizzle'];
    if (c >= 61 && c <= 67) return ['🌧️', 'Rain'];
    if (c >= 71 && c <= 77) return ['🌨️', 'Snow'];
    if (c >= 80 && c <= 82) return ['🌦️', 'Showers'];
    if (c >= 85 && c <= 86) return ['🌨️', 'Snow showers'];
    if (c >= 95) return ['⛈️', 'Thunderstorm'];
    return ['', ''];
  };
  const ARROW = (deg) => (deg == null ? '' : `<svg viewBox="-8 -8 16 16" width="12" height="12" aria-hidden="true" style="vertical-align:-1px"><path d="M0,-7 L5,5 L0,2 L-5,5 Z" transform="rotate(${(deg + 180) % 360})" fill="currentColor"/></svg>`);
  const localKey = (ms, tz) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((q) => [q.type, q.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:00`;
  };
  // local "YYYY-MM-DDTHH:MM" strings as plain minutes, for interpolating between turns
  const mins = (at) => Date.UTC(+at.slice(0, 4), +at.slice(5, 7) - 1, +at.slice(8, 10), +at.slice(11, 13), +at.slice(14, 16)) / 6e4;
  const curve = (pts) => (t) => {
    if (!pts.length || t < pts[0].x || t > pts[pts.length - 1].x) return null;
    let i = 1; while (pts[i].x < t) i++;
    const a = pts[i - 1], b = pts[i], f = b.x === a.x ? 0 : (t - a.x) / (b.x - a.x);
    return a.v + (b.v - a.v) * (1 - Math.cos(Math.PI * f)) / 2;
  };
  const hm = (s) => +s.slice(0, 2) * 60 + +s.slice(3, 5);

  // opts: { tz, wind, tides, currents?, sun, waves: [{label, rows}], elwha? }
  function render(el, o) {
    if (!o.wind || !o.wind.length) { el.replaceChildren('Forecast unavailable right now.'); return; }
    const nowKey = localKey(Date.now(), o.tz);
    // today, every hour (hours already gone are greyed out)
    const today = nowKey.slice(0, 10);
    const hours = o.wind.filter((r) => r.day === today).sort((a, b) => (a.at < b.at ? -1 : 1));
    const tide = curve((o.tides || []).map((r) => ({ x: mins(r.at), v: +r.height_ft })).sort((a, b) => a.x - b.x));
    const cur = o.currents ? curve(o.currents.map((r) => ({ x: mins(r.at), v: r.type === 'Flood' ? +r.speed_kt : r.type === 'Ebb' ? -r.speed_kt : 0 })).sort((a, b) => a.x - b.x)) : null;
    const sun = Object.fromEntries((o.sun || []).map((r) => [r.day, r]));
    const waves = (o.waves || []).map((w) => ({ label: w.label, dir: !!w.dir, map: Object.fromEntries((w.rows || []).map((r) => [localKey(Date.parse(r.utc), o.tz), r])) }));
    const cols = hours.map((r) => {
      const t = mins(r.at), s = sun[r.day];
      const light = s ? (t % 1440) + 30 >= hm(s.sunrise) && (t % 1440) + 30 <= hm(s.sunset) : r.is_day === 1;
      const th = tide(t + 30), cv = cur ? cur(t + 30) : null;
      const east = r.dir_deg != null && r.dir_deg >= 45 && r.dir_deg <= 135 && r.wind_kmh >= 10;
      const tideOk = th != null && th >= 0 && th <= 6;
      const best = o.elwha && light && tideOk && cv != null && cv > 0.05 && !east;
      const ok = o.elwha && light && tideOk && !east;
      return { r, light, th, cv, east, best, ok, past: r.at < nowKey, now: r.at === nowKey };
    });
    const hdr = (c, i) => {
      const h = c.r.hour, newDay = i === 0 || h === 0;
      const d = newDay ? new Date(`${c.r.day}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) : '';
      return `<th class="${newDay ? 'nd' : ''}${c.light ? '' : ' dk'}"><span class="d">${d}</span>${(h + 11) % 12 + 1}${h < 12 ? 'a' : 'p'}</th>`;
    };
    const mark = (c, html) => (c.past || c.now ? html.replace(/^<(td|th)( class="([^"]*)")?/, (m, tg, _a, cl) => `<${tg} class="${[cl, c.past ? 'past' : '', c.now ? 'now' : ''].filter(Boolean).join(' ')}"`) : html);
    const row = (label, fn) => `<tr><th class="rl">${label}</th>${cols.map((c, i) => mark(c, fn(c, i))).join('')}</tr>`;
    let html = `<table class="hr-t"><thead><tr><th class="rl"></th>${cols.map((c, i) => mark(c, hdr(c, i))).join('')}</tr></thead><tbody>`;
    if (o.elwha) html += row('Surf rules', (c) => `<td class="${c.best ? 'best' : c.ok ? 'okc' : ''}" title="${c.best ? 'Flood, tide 0–6 ft, daylight, no east wind' : c.ok ? 'Tide 0–6 ft, daylight, no east wind' : ''}">${c.best ? 'Best' : c.ok ? '✓' : ''}</td>`);
    html += row('Weather', (c) => { const [ic, tt] = WX(c.r.code, c.r.is_day !== 0); return `<td title="${tt}">${ic}</td>`; });
    html += row('Temp °C', (c) => `<td>${c.r.temp_c ?? '–'}</td>`);
    html += row('Rain', (c) => `<td class="mut">${c.r.pop != null ? c.r.pop + '%' : '–'}${c.r.rain_mm ? `<br><small>${c.r.rain_mm} mm</small>` : ''}</td>`);
    html += row('Wind km/h', (c) => `<td class="${o.elwha && c.east ? 'bad' : ''}">${ARROW(c.r.dir_deg)}<br>${c.r.wind_kmh}<small>${c.r.wind_dir ? ' ' + c.r.wind_dir : ''}</small></td>`);
    html += row('Gusts', (c) => `<td class="mut">${c.r.gust_kmh ?? '–'}</td>`);
    waves.forEach((w) => {
      html += row(`${w.label} swell`, (c) => {
        const f = w.map[c.r.at];
        if (!f) return '<td class="mut">–</td>';
        const tr = f.trains[0];
        const sub = tr ? (w.dir ? `<br><small>${Math.round(tr.period_s)}s</small><br>${ARROW(tr.dir_deg)}<small> ${tr.direction} ${tr.dir_deg}°</small>` : `<br><small>${Math.round(tr.period_s)}s</small>`) : '';
        return `<td title="${f.trains.map((x) => `${x.height_ft} ft @ ${x.period_s} s ${x.direction}`).join(' · ')}">${f.hs_ft}<small> ft</small>${sub}</td>`;
      });
    });
    html += row('Tide ft', (c) => `<td class="${o.elwha && c.th != null && !(c.th >= 0 && c.th <= 6) ? 'mut' : ''}">${c.th == null ? '–' : c.th.toFixed(1)}</td>`);
    if (cur) html += row('Current kt', (c) => `<td class="mut">${c.cv == null ? '–' : Math.abs(c.cv) < 0.1 ? 'S' : (c.cv > 0 ? 'F' : 'E') + Math.abs(c.cv).toFixed(1)}</td>`);
    el.innerHTML = `<div class="hr-wrap">${html}</tbody></table></div>`;
    const w = el.querySelector('.hr-wrap'), n = el.querySelector('thead th.now');
    if (w && n) requestAnimationFrame(() => { const lw = (el.querySelector('thead th.rl') || {}).offsetWidth || 80; w.scrollLeft = Math.max(0, n.offsetLeft - lw); });
  }
  return { render };
})();
