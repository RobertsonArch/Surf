// Tiny runtime for the surf pages: loads data/*.json, runs calcs, redraws.
// Pages register dash.draw(name, fn) for elements with data-draw="name".
window.dash = (() => {
  const store = {};
  const draws = {};
  const calcs = {};
  let sources = {};
  let watch = [];
  const css = getComputedStyle(document.documentElement);
  const colors = [0, 1, 2, 3, 4].map((i) => css.getPropertyValue(`--series-${i}`).trim() || '#888');

  const data = (id) => store[id] || { status: 'loading', data: [] };
  const draw = (name, fn) => { draws[name] = fn; };
  const calc = (name, spec) => { calcs[name] = spec; };

  function render() {
    for (const [name, spec] of Object.entries(calcs)) {
      const ins = spec.inputs.map((i) => data(i));
      if (ins.every((d) => d.status === 'ok')) {
        try { store[name] = { status: 'ok', data: spec.fn(...ins.map((d) => d.data)) }; }
        catch (e) { console.error(name, e); store[name] = { status: 'error', data: [] }; }
      } else store[name] = { status: ins.some((d) => d.status === 'loading') ? 'loading' : 'error', data: [] };
    }
    for (const [name, fn] of Object.entries(draws)) {
      document.querySelectorAll(`[data-draw="${name}"]`).forEach((el) => {
        try { fn(el); } catch (e) { console.error(name, e); }
      });
    }
    showUpdated();
  }

  function showUpdated() {
    const el = document.getElementById('updated');
    const m = store.meta && store.meta.data;
    if (!el || !m || !m.updated) return;
    const mins = Math.round((Date.now() - Date.parse(m.updated)) / 60000);
    const ago = mins < 2 ? 'just now' : mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`;
    const bad = Object.entries(m.sources || {}).filter(([k, v]) => v.ok === false && watch.includes(k)).map(([k]) => k);
    el.textContent = `Data updated ${ago}` + (bad.length ? ` · could not refresh: ${bad.join(', ')}` : '');
    el.classList.toggle('stale', mins > 150 || bad.length > 0);
  }

  async function load(map, metaKeys) {
    sources = map;
    if (metaKeys) watch = metaKeys;
    const bust = Math.floor(Date.now() / 120000);
    await Promise.all(Object.entries({ ...map, meta: 'data/meta.json' }).map(async ([id, url]) => {
      try {
        const r = await fetch(`${url}?v=${bust}`, { cache: 'no-cache' });
        if (!r.ok) throw new Error(r.status);
        store[id] = { status: 'ok', data: await r.json() };
      } catch (e) {
        if (!store[id] || store[id].status !== 'ok') store[id] = { status: 'error', data: [] };
      }
    }));
    render();
  }

  let t;
  window.addEventListener('resize', () => { clearTimeout(t); t = setTimeout(render, 150); });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') load(sources); });
  setInterval(() => { if (document.visibilityState === 'visible') load(sources); }, 10 * 60 * 1000);

  return { data, draw, calc, colors, load, render };
})();
