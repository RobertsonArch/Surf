// Buoy forecast chart: NOAA GFS-Wave point forecast (the model Stormsurf charts),
// with the buoy's own readings for the last day drawn over it.
window.buoyForecast = (() => {
  const ARROW = 'M0,-6 L4,4 L0,2 L-4,4 Z';
  const fmt = (ms, tz, o) => new Date(ms).toLocaleString('en-US', { timeZone: tz, ...o });
  const localMs = (at) => Date.UTC(+at.slice(0, 4), +at.slice(5, 7) - 1, +at.slice(8, 10), +at.slice(11, 13), +at.slice(14, 16));

  // obs: rows with {utc|at, wave_ft}; tz: page time zone. at strings are local, so convert via the utc field when present.
  function draw(el, fc, stationId, obs, tz, color) {
    const rows = (fc && fc.stations && fc.stations[stationId]) || [];
    if (!rows.length) { el.replaceChildren('No forecast for this buoy right now.'); return; }
    const now = Date.now();
    const t0 = now - 24 * 3600e3, t1 = now + 7 * 864e5;
    const F = rows.map((r) => ({ ...r, t: Date.parse(r.utc) })).filter((r) => r.t >= t0 && r.t <= t1);
    const O = obs.map((r) => ({ t: r.utc ? Date.parse(r.utc) : NaN, v: r.wave_ft })).filter((r) => r.t >= t0 && r.v != null);
    const W = Math.max(300, el.clientWidth), H = 264;
    const m = { l: 40, r: 10, t: 14, b: 72 };
    el.replaceChildren();
    const svg = d3.select(el).append('svg').attr('width', '100%').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', 'Buoy wave height forecast for the next 7 days');
    const x = d3.scaleTime([t0, t1], [m.l, W - m.r]);
    const ymax = Math.max(4, d3.max(F, (r) => r.hs_ft) || 0, d3.max(O, (r) => r.v) || 0) * 1.12;
    const y = d3.scaleLinear([0, ymax], [H - m.b, m.t]).nice();
    // day bands + labels
    for (let d = 0; d <= 8; d++) {
      const day = new Date(now + (d - 1) * 864e5).toLocaleDateString('en-CA', { timeZone: tz });
      const noon = Date.parse(`${day}T12:00:00Z`);
      const start = Date.parse(`${day}T00:00:00Z`) - (localMs(fmtAt(noon, tz)) - noon);
      if (start > t1) break;
      if (d % 2 === 0) svg.append('rect').attr('x', x(Math.max(t0, start))).attr('width', Math.max(0, x(Math.min(t1, start + 864e5)) - x(Math.max(t0, start)))).attr('y', m.t).attr('height', H - m.b - m.t).style('fill', 'var(--cds-chart-grid)').attr('opacity', 0.45);
      const mid = Math.min(t1, Math.max(t0, start + 864e5 / 2));
      if (start + 864e5 / 2 > t0 && start + 864e5 / 2 < t1) svg.append('text').attr('x', x(mid)).attr('y', H - m.b + 14).attr('text-anchor', 'middle').text(fmt(start + 43200e3, tz, { weekday: 'short' }));
    }
    y.ticks(4).forEach((tk) => {
      svg.append('line').attr('x1', m.l).attr('x2', W - m.r).attr('y1', y(tk)).attr('y2', y(tk)).attr('stroke', 'var(--cds-chart-grid)');
      svg.append('text').attr('x', m.l - 6).attr('y', y(tk)).attr('dy', '0.32em').attr('text-anchor', 'end').text(`${tk} ft`);
    });
    // forecast: total height (area + line) and the largest swell train (dashed)
    const g = svg.append('defs').append('linearGradient').attr('id', 'fc-g-' + stationId).attr('x1', 0).attr('x2', 0).attr('y1', 0).attr('y2', 1);
    [[0, .22], [1, 0]].forEach(([o, a]) => g.append('stop').attr('offset', o).attr('style', `stop-color:${color};stop-opacity:${a}`));
    svg.append('path').datum(F).attr('d', d3.area((r) => x(r.t), y(0), (r) => y(r.hs_ft))).attr('fill', `url(#fc-g-${stationId})`);
    svg.append('path').datum(F).attr('d', d3.line((r) => x(r.t), (r) => y(r.hs_ft))).attr('fill', 'none').style('stroke', color).attr('stroke-width', 2);
    svg.append('path').datum(F.filter((r) => r.trains[0])).attr('d', d3.line((r) => x(r.t), (r) => y(r.trains[0].height_ft))).attr('fill', 'none').style('stroke', color).attr('stroke-width', 1.3).attr('stroke-dasharray', '4 3').attr('opacity', 0.8);
    // measured
    if (O.length > 1) svg.append('path').datum(O.sort((a, b) => a.t - b.t)).attr('d', d3.line((r) => x(r.t), (r) => y(r.v))).attr('fill', 'none').style('stroke', 'var(--color-fg)').attr('stroke-width', 1.6);
    // now
    svg.append('line').attr('x1', x(now)).attr('x2', x(now)).attr('y1', m.t).attr('y2', H - m.b).style('stroke', 'var(--color-fg)').attr('stroke-width', 1).attr('stroke-dasharray', '2 2');
    svg.append('text').attr('class', 'val').attr('x', x(now) + 4).attr('y', m.t + 8).text('Now');
    // every 12 h: the largest train's period and direction
    const step = W < 520 ? 24 : 12;
    const marks = F.filter((r) => r.t > now && new Date(r.t).getUTCHours() % step === 0 && r.trains[0]);
    marks.forEach((r) => {
      const tr = r.trains[0], cx = x(r.t);
      svg.append('path').attr('d', ARROW).attr('transform', `translate(${cx},${H - m.b + 28}) rotate(${(tr.dir_deg + 180) % 360})`).style('fill', 'var(--color-fg)');
      svg.append('text').attr('x', cx).attr('y', H - m.b + 48).attr('text-anchor', 'middle').style('font-size', '10px').text(`${Math.round(tr.period_s)}s`);
      svg.append('text').attr('x', cx).attr('y', H - m.b + 61).attr('text-anchor', 'middle').style('font-size', '10px').text(`${tr.dir_deg}°`);
    });
    // hover
    let tip = el.querySelector('.fc-tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'fc-tip'; tip.hidden = true; el.append(tip); }
    const guide = svg.append('line').attr('y1', m.t).attr('y2', H - m.b).attr('stroke', 'var(--cds-chart-reference)').style('display', 'none');
    const bis = d3.bisector((r) => r.t).center;
    svg.append('rect').attr('x', m.l).attr('width', W - m.l - m.r).attr('y', 0).attr('height', H).attr('fill', 'transparent')
      .on('pointermove', (evt) => {
        const [px] = d3.pointer(evt);
        const t = x.invert(px).getTime();
        const r = F[bis(F, t)];
        if (!r) return;
        guide.attr('x1', x(r.t)).attr('x2', x(r.t)).style('display', null);
        const o = O.length ? O.reduce((a, c) => (Math.abs(c.t - t) < Math.abs(a.t - t) ? c : a), O[0]) : null;
        const lines = [fmt(r.t, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric' }), `Forecast ${r.hs_ft} ft total`,
          ...r.trains.map((tr) => `${tr.height_ft} ft @ ${tr.period_s} s ${tr.direction} ${tr.dir_deg}°`)];
        if (o && Math.abs(o.t - t) < 45 * 60e3) lines.push(`Measured ${o.v} ft`);
        tip.replaceChildren(...lines.map((l, i) => { const d = document.createElement('div'); d.textContent = l; if (!i) d.className = 't'; return d; }));
        tip.hidden = false;
        const [hx] = d3.pointer(evt, el);
        tip.style.left = Math.max(0, Math.min(el.clientWidth - tip.offsetWidth, hx - tip.offsetWidth / 2)) + 'px';
        tip.style.top = '0px';
      })
      .on('pointerleave', () => { tip.hidden = true; guide.style('display', 'none'); });
  }
  function fmtAt(ms, tz) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms)).map((q) => [q.type, q.value]));
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
  }

  // Section with buoy tabs. buoys: [{id, name, obsId, color}]
  function section(el, buoys, tz) {
    if (dash.data('wave_forecast').status !== 'ok') { el.replaceChildren(dash.data('wave_forecast').status === 'loading' ? '' : 'Forecast unavailable right now.'); return; }
    const fc = dash.data('wave_forecast').data;
    el.__sel = el.__sel || buoys[0].id;
    const avail = buoys.filter((b) => (fc.stations[b.id] || []).length);
    if (!avail.find((b) => b.id === el.__sel) && avail.length) el.__sel = avail[0].id;
    const tabs = document.createElement('div'); tabs.className = 'fc-tabs';
    avail.forEach((b) => { const bt = document.createElement('button'); bt.type = 'button'; bt.textContent = b.name; bt.setAttribute('aria-pressed', b.id === el.__sel); bt.onclick = () => { el.__sel = b.id; section(el, buoys, tz); }; tabs.append(bt); });
    const chart = document.createElement('div'); chart.className = 'fc-chart';
    const cap = document.createElement('p'); cap.className = 'fc-cap';
    cap.textContent = `${fc.model}, run of ${fmt(Date.parse(fc.cycle), tz, { month: 'short', day: 'numeric', hour: 'numeric' })}. Solid line: forecast total height; dashed: largest swell train (its period and direction, in degrees, marked along the bottom). Black: measured.`;
    el.replaceChildren(tabs, chart, cap);
    const b = buoys.find((q) => q.id === el.__sel) || buoys[0];
    draw(chart, fc, b.id, dash.data(b.obsId).status === 'ok' ? b.obs(dash.data(b.obsId).data) : [], tz, b.color);
  }
  return { draw, section };
})();
