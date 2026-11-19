'use strict';

const state = {
  smMetric: 'mit',       // 'mit' | 'ohne'
  forwatt: true,
  smRange: [0, 1],       // ratio
  coverage: null,        // { partners, matchedVnbIds }
  matched: new Set(),
  selected: null,
  hovered: null,         // vnb_id currently under the cursor
};

let map, geoLayer, dsoById = {}, dsoList = [], smData = {}, layersByVnb = {};

// ---------- sidebar (mobile overlay) ----------
const isMobile = () => window.matchMedia('(max-width: 768px)').matches;
function setSidebarOpen(open) {
  const sidebarEl = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  sidebarEl.classList.toggle('collapsed', !open);
  toggleBtn.classList.toggle('collapsed', !open);
  toggleBtn.textContent = open ? '◀' : '▶';
  if (backdrop) backdrop.classList.toggle('visible', open && isMobile());
  if (map) setTimeout(() => map.invalidateSize(), 320);
}

// ---------- color scale ----------
// for.Watt logo gradient: yellow (low quota) -> orange (high quota).
// Most quotas sit between 0 and 40 %, so the scale saturates at SM_SCALE_MAX
// instead of 100 % - otherwise nearly every region would look the same yellow.
const SM_LOW = [0xFF, 0xC1, 0x00], SM_HIGH = [0xFF, 0x73, 0x00], SM_SCALE_MAX = .5;
// partner without a published quota ("k. A."): a solid slate, clearly visible
// on the greyscale base map and clearly not part of the yellow-orange scale
const SM_NA = [0x5E, 0x75, 0x80];
function smColor(r, shade = 1) {   // shade < 1 darkens (used for hover)
  if (r == null) return `rgb(${SM_NA.map(v => Math.round(v * shade)).join(',')})`;
  const t = Math.min(Math.max(r / SM_SCALE_MAX, 0), 1);
  const c = SM_LOW.map((lo, i) => Math.round((lo + (SM_HIGH[i] - lo) * t) * shade));
  return `rgb(${c.join(',')})`;
}
const smValue = id => { const e = smData[id]; return e ? e[state.smMetric] : null; };
const smMit = id => { const e = smData[id]; return e ? e.mit : null; };        // fixed metric for partner figures

// ---------- filtering ----------
function passes(id) {
  const sm = smValue(id);
  return sm == null || (sm >= state.smRange[0] && sm <= state.smRange[1]);
}

// ---------- map styling ----------
function styleFor(feature) {
  const id = feature.properties.vnb_id;
  const ok = passes(id);
  const fill = smColor(smValue(id));
  const covered = state.forwatt && state.matched.has(id);

  // `stroke` is set explicitly everywhere: setStyle() merges, so a stroke:false
  // would otherwise stick when a feature switches to another state
  if (!ok) return { stroke: false, fillColor: fill, fillOpacity: .05 };
  if (state.forwatt) {
    // covered: each VNB is made of many Gemeinde polygons. Drawn opaque with a
    // 1px outline in the fill colour, so neither inner borders nor the hairline
    // anti-aliasing gaps between neighbouring polygons show. The see-through
    // look comes from the opacity of the whole regions pane (REGIONS_OPACITY),
    // which - unlike per-shape opacity - doesn't darken where shapes overlap.
    if (covered) return solidStyle(fill);
    // non-covered: not drawn at all (still hoverable for the tooltip)
    return { stroke: false, fillOpacity: 0 };
  }
  if (state.selected === id) return { stroke: true, fillColor: fill, weight: 3, color: '#1D1D1D', opacity: 1, fillOpacity: .9 };
  return { stroke: true, fillColor: fill, weight: 1, color: '#ffffff', opacity: .8, fillOpacity: smValue(id) != null ? .72 : .3 };
}
const REGIONS_OPACITY = .85;
const solidStyle = c => ({ stroke: true, color: c, weight: 1, opacity: 1, fillColor: c, fillOpacity: 1 });
// hover: covered regions turn a darker shade of their own colour; non-covered
// regions, invisible at rest, show up in blue
function hoverStyleFor(feature) {
  const base = styleFor(feature);
  const id = feature.properties.vnb_id;
  if (state.forwatt) return solidStyle(state.matched.has(id) ? smColor(smValue(id), .78) : '#6FA3D6');
  const lift = Math.min(Math.max(base.fillOpacity, .5) + .22, .95);
  return { ...base, weight: 1.6, color: '#1D1D1D', opacity: .9, dashArray: null, fillOpacity: lift };
}
function restyle() {
  if (!geoLayer) return;
  geoLayer.setStyle(styleFor);
  const layers = state.hovered != null ? layersByVnb[state.hovered] : null;
  if (layers) layers.forEach(layer => layer.setStyle(hoverStyleFor(layer.feature)));
}

// ---------- tooltip ----------
function tooltipHtml(f) {
  const p = f.properties, id = p.vnb_id;
  const sm = smValue(id);
  const cov = state.matched.has(id);
  const partner = cov && state.coverage
    ? state.coverage.partners.find(x => x.vnbId === id) : null;
  return `<div class="vnb-tt">
    <h3>${esc(p.name)}</h3>
    <div class="c">${esc(p.city || '')} · ${(p.types || []).length} Spannungsebenen</div>
    <div class="kv"><span>Smart Meter (Pflichteinbaufälle)</span><b>${sm != null ? (sm * 100).toFixed(1) + ' %' : 'k. A.'}</b></div>
    ${cov ? `<div class="fw">✓ Abgedeckt durch for.Watt</div>` : ''}
  </div>`;
}
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- init ----------
async function init() {
  const [geo, dso, sm, border] = await Promise.all([
    fetch('data/geo.json').then(r => r.json()),
    fetch('data/dso.json').then(r => r.json()),
    fetch('data/sm.json').then(r => r.json()),
    fetch('data/de-border.json').then(r => r.json()).catch(() => null),  // optional decoration
  ]);

  dsoList = dso;
  dso.forEach(d => { dsoById[d.id] = d; });
  const period = sm.periods[sm.periods.length - 1];
  smData = period.data;
  document.getElementById('period-label').textContent = period.label;

  map = L.map('map', {
    zoomControl: true, preferCanvas: true,
    // gentler mouse-wheel zoom: Leaflet's defaults (snap 1, 60 px/level) jump
    // ~2 levels per wheel notch; this gives ~0.75 levels per notch. The +/-
    // buttons keep zoomDelta 1.
    zoomSnap: 0.25,
    wheelPxPerZoomLevel: 120,
  }).setView([51.2, 10.4], 6);
  L.tileLayer(
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }
  ).addTo(map);


  if (border) addOutsideMask(border);

  // own pane + canvas for the regions, so their transparency is applied once
  // to the finished picture (see styleFor)
  const regionsPane = map.createPane('regions');
  regionsPane.style.opacity = REGIONS_OPACITY;
  regionsPane.style.zIndex = 400;
  geoLayer = L.geoJSON(geo, {
    renderer: L.canvas({ pane: 'regions' }),
    style: styleFor,
    onEachFeature: (f, layer) => {
      const id = f.properties.vnb_id;
      (layersByVnb[id] || (layersByVnb[id] = [])).push(layer);
      layer.bindTooltip(() => tooltipHtml(f), { className: 'vnb-tt', sticky: true, direction: 'top' });
      layer.on('click', () => { state.selected = id; restyle(); });
      layer.on('mouseover', () => {
        state.hovered = id;
        layersByVnb[id].forEach(l => {
          l.setStyle(hoverStyleFor(l.feature));
          if (!L.Browser.ie && !L.Browser.opera && !L.Browser.edge) l.bringToFront();
        });
      });
      layer.on('mouseout', () => {
        if (state.hovered === id) state.hovered = null;
        layersByVnb[id].forEach(l => l.setStyle(styleFor(l.feature)));
      });
    },
  }).addTo(map);

  addMapLegend();
  document.getElementById('loading').style.display = 'none';
  wireControls();
  // renderLegend();  // Kartenmodus-Panel (inkl. #legend) ist im HTML auskommentiert
  renderList();
  updateCount();
  loadForwatt();  // auto-refresh coverage on every page open
}
/*new*/
function addMapSearch() {
  const search = L.control({ position: 'bottomleft' });

  search.onAdd = () => {
    const el = L.DomUtil.create('div', 'map-search');

    el.innerHTML = `
      <input
        type="text"
        id="map-search-input"
        placeholder="VNB suchen..."
        autocomplete="off"
      >
      <div id="map-search-results"></div>
    `;

    L.DomEvent.disableClickPropagation(el);
    L.DomEvent.disableScrollPropagation(el);

    // Warten, bis das Element tatsächlich im DOM ist
    setTimeout(() => {
      const input = document.getElementById('map-search-input');
      const results = document.getElementById('map-search-results');

      input.addEventListener('input', () => {
        const query = input.value.trim().toLowerCase();

        if (query.length < 2) {
          results.innerHTML = '';
          results.style.display = 'none';
          return;
        }

        // In den Features des bereits vorhandenen GeoJSON-Layers suchen
        const matches = [];

        geoLayer.eachLayer(layer => {
          const p = layer.feature?.properties;
          if (!p) return;

          const name = String(p.name || '');
          const city = String(p.city || '');

          if (
            name.toLowerCase().includes(query) ||
            city.toLowerCase().includes(query)
          ) {
            // Mehrteilige VNB-Gebiete nur einmal anzeigen
            if (!matches.some(m => m.id === p.vnb_id)) {
              matches.push({
                id: p.vnb_id,
                name,
                city
              });
            }
          }
        });

        results.innerHTML = '';

        matches.slice(0, 8).forEach(match => {
          const item = document.createElement('div');
          item.className = 'map-search-result';

          item.innerHTML = `
            <strong>${esc(match.name)}</strong>
            ${match.city ? `<span>${esc(match.city)}</span>` : ''}
          `;

          item.addEventListener('click', () => {
            const layers = layersByVnb[match.id];
            if (!layers || !layers.length) return;

            // Alle Teilflächen des VNB gemeinsam betrachten
            const group = L.featureGroup(layers);
            map.fitBounds(group.getBounds(), {
              padding: [30, 30],
              maxZoom: 11
            });

            // Gebiet wie bei einem normalen Klick auswählen
            state.selected = match.id;
            restyle();

            input.value = match.name;
            results.style.display = 'none';
          });

          results.appendChild(item);
        });

        results.style.display = matches.length ? 'block' : 'none';
      });
    }, 0);

    return el;
  };

  search.addTo(map);
}
/*new*/
addMapSearch();

// ---------- outside Germany: a veil over foreign countries and the sea ----------
// One polygon: a world-sized ring with every German land polygon cut out as a
// hole (Leaflet fills even-odd), drawn between the base map and the regions.
function addOutsideMask(border) {
  const pane = map.createPane('outside');
  pane.style.zIndex = 390;
  pane.style.pointerEvents = 'none';
  const toLatLngs = ring => ring.map(([lng, lat]) => [lat, lng]);
  const world = [[-85, -180], [-85, 180], [85, 180], [85, -180]];
  const holes = border.geometry.coordinates.flatMap(poly => poly.map(toLatLngs));
  L.polygon([world, ...holes], {
    renderer: L.canvas({ pane: 'outside' }), interactive: false,
    stroke: true, color: '#394D55', weight: 1, opacity: .55,   // national border line
    fillColor: '#394D55', fillOpacity: .28, fillRule: 'evenodd',
  }).addTo(map);
}

// ---------- controls ----------
function wireControls() {
  document.querySelectorAll('input[name=smmetric]').forEach(r =>
    r.onchange = () => { state.smMetric = r.value; restyle(); renderLegend(); renderList(); });

  // Schalter deaktiviert: for.Watt-Abdeckung ist dauerhaft aktiv (state.forwatt bleibt true).
  // document.getElementById('forwatt-toggle').onchange = e => {
  //   state.forwatt = e.target.checked;
  //   if (state.forwatt && !state.coverage) loadForwatt(); // in case it hasn't landed yet
  //   restyle();
  // };

  const sidebarEl = document.getElementById('sidebar');
  const toggleBtn = document.getElementById('sidebar-toggle');
  const backdrop = document.getElementById('sidebar-backdrop');
  toggleBtn.onclick = () => setSidebarOpen(sidebarEl.classList.contains('collapsed'));
  if (backdrop) backdrop.onclick = () => setSidebarOpen(false);
  // start with the map in view on phones; the sidebar opens as an overlay on demand
  if (isMobile()) setSidebarOpen(false);

  // Filter-Panel (inkl. #reset-btn) ist im HTML auskommentiert.
  const resetBtn = document.getElementById('reset-btn');
  if (resetBtn) resetBtn.onclick = () => {
    state.smRange = [0, 1]; state.selected = null;
    buildSliders(); applyFilterUi(); restyle();
  };

  buildSliders();
}

// dual range slider
function buildSliders() {
  makeDual('sm-slider', 0, 100, state.smRange[0] * 100, state.smRange[1] * 100, (lo, hi) => {
    state.smRange = [lo / 100, hi / 100];
    document.getElementById('sm-range-label').textContent = `${lo} – ${hi} %`;
    onFilterChange();
  });
}
function makeDual(elId, min, max, valLo, valHi, cb) {
  const el = document.getElementById(elId);
  if (!el) return;  // Filter-Panel ist im HTML auskommentiert
  el.innerHTML = `<div class="track"><div class="fill"></div></div>
    <input type="range" class="lo" min="${min}" max="${max}" value="${valLo}">
    <input type="range" class="hi" min="${min}" max="${max}" value="${valHi}">`;
  const lo = el.querySelector('.lo'), hi = el.querySelector('.hi'), fill = el.querySelector('.fill');
  const upd = () => {
    let a = +lo.value, b = +hi.value; if (a > b) [a, b] = [b, a];
    fill.style.left = ((a - min) / (max - min) * 100) + '%';
    fill.style.right = (100 - (b - min) / (max - min) * 100) + '%';
    cb(a, b);
  };
  lo.oninput = hi.oninput = upd; upd();
}
function applyFilterUi() { buildSliders(); }

let filterTimer;
function onFilterChange() { clearTimeout(filterTimer); filterTimer = setTimeout(() => { restyle(); renderList(); updateCount(); }, 60); }

function updateCount() {
  const el = document.getElementById('vnb-count');
  if (!el) return;  // Filter-Panel ist im HTML auskommentiert
  const total = Object.keys(dsoById).length;
  const n = Object.keys(dsoById).filter(passes).length;
  el.textContent = `${n} / ${total} VNB`;
}

// ---------- map legend (colour scale, bottom right of the map) ----------
function addMapLegend() {
  const legend = L.control({ position: 'bottomright' });
  legend.onAdd = () => {
    const el = L.DomUtil.create('div', 'map-legend');
    const max = SM_SCALE_MAX * 100;
    el.innerHTML = `
      <div class="ml-title">Smart-Meter-Quote der Partner</div>
      <div class="ml-sub">Pflichteinbaufälle mit iMSys</div>
      <div class="ml-bar" style="background:linear-gradient(90deg, ${smColor(0)}, ${smColor(SM_SCALE_MAX)}); opacity:${REGIONS_OPACITY}"></div>
      <div class="ml-ticks"><span>0 %</span><span>${max / 2} %</span><span>≥ ${max} %</span></div>
      <div class="ml-na"><span class="ml-swatch" style="background:${smColor(null)}; opacity:${REGIONS_OPACITY}"></span>keine Angabe (k. A.)</div>`;
    L.DomEvent.disableClickPropagation(el);
    return el;
  };
  legend.addTo(map);
}

// ---------- legend (sidebar, currently commented out in the HTML) ----------
function renderLegend() {
  const el = document.getElementById('legend');
  const ids = Object.keys(dsoById).filter(passes);
  const grad = `linear-gradient(90deg, ${smColor(0)}, ${smColor(SM_SCALE_MAX)})`;
  const ticks = ['0 %', '25 %', `≥ ${SM_SCALE_MAX * 100} %`];
  const vals = ids.map(smValue).filter(v => v != null);
  const kA = ids.length - vals.length;
  el.innerHTML = legendBody(grad, ticks, vals.map(v => v * 100), '%', kA);
}
function legendBody(grad, ticks, vals, unit, kA) {
  const mean = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  const min = vals.length ? Math.min(...vals) : null, max = vals.length ? Math.max(...vals) : null;
  const f = n => n == null ? '-' : n.toFixed(1) + unit;
  return `<div class="bar" style="background:${grad}"></div>
    <div class="ticks">${ticks.map(t => `<span>${t}</span>`).join('')}</div>
    <div class="stats"><span>Mittel <b>${f(mean)}</b></span><span>Min <b>${f(min)}</b></span><span>Max <b>${f(max)}</b></span><span>k. A. <b>${kA}</b></span></div>`;
}

// ---------- ranking list ----------
function renderList() {
  const el = document.getElementById('vnb-list');
  const title = document.getElementById('list-title');
  if (!el || !title) return;  // Ranking-Panel ist im HTML auskommentiert
  const ids = Object.keys(dsoById).filter(passes);
  title.textContent = 'Ranking Smart-Meter-Quote';
  ids.sort((a, b) => (smValue(b) ?? -1) - (smValue(a) ?? -1));
  el.innerHTML = ids.slice(0, 200).map((id, i) => {
    const d = dsoById[id], v = smValue(id);
    const label = v == null ? 'k. A.' : (v * 100).toFixed(1) + ' %';
    const bg = smColor(v);
    const cov = state.matched.has(id);
    return `<div class="vnb-row" data-id="${id}">
      <span class="rank">${i + 1}</span>
      <span class="name">${esc(d.name)}</span>
      ${cov ? '<span class="fwtag" title="for.Watt-Abdeckung">●</span>' : ''}
      <span class="badge" style="background:${bg}">${label}</span>
    </div>`;
  }).join('');
  el.querySelectorAll('.vnb-row').forEach(row => row.onclick = () => focusVnb(row.dataset.id));
}

function focusVnb(id) {
  state.selected = id; restyle();
  const d = dsoById[id];
  if (d && d.bbox) map.fitBounds([[d.bbox[1], d.bbox[0]], [d.bbox[3], d.bbox[2]]], { maxZoom: 10, padding: [40, 40] });
  const layers = layersByVnb[id];
  if (layers && layers.length) layers[0].openTooltip();
  if (isMobile()) setSidebarOpen(false);  // reveal the map after picking a VNB from the list
}

// ---------- for.Watt coverage (from the maintained list, resolved on each load) ----------
async function loadForwatt() {
  const status = document.getElementById('forwatt-status');
  status.className = 'forwatt-status'; status.textContent = 'Messstellenbetreiber werden geladen…';
  try {
    // cache-bust so each page open reflects the latest committed list
    const list = await fetch('data/messstellenbetreiber.json?t=' + Date.now()).then(r => r.json());
    const cov = MsbMatch.resolve(list.operators, dsoList, list.aliases);
    state.coverage = cov;
    state.matched = new Set(cov.matchedVnbIds);
    status.className = 'forwatt-status ok';
    status.textContent = `${cov.matchedVnbIds.length} von ${cov.partners.length} Messstellenbetreiber auf VNB-Gebiete abgebildet`;
    renderForwattList();
    renderList();
    restyle();
  } catch (e) {
    status.className = 'forwatt-status err';
    status.textContent = 'Messstellenbetreiber-Liste nicht verfügbar: ' + e.message;
  }
}
function renderForwattList() {
  const el = document.getElementById('forwatt-list');
  const parts = state.coverage.partners;
  const matched = parts.filter(p => p.vnbId).sort((a, b) => a.vnbName.localeCompare(b.vnbName));
  const other = parts.filter(p => !p.vnbId).sort((a, b) => a.name.localeCompare(b.name));
  const matchedItem = p => {
    const v = smMit(p.vnbId);
    const label = v == null ? 'k. A.' : Math.round(v * 100) + '%';
    // some VNBs from the registry have no mapped municipality polygon (no shape
    // to zoom to) - show them, but don't dress them up as clickable
    const hasGeo = !!(layersByVnb[p.vnbId] && layersByVnb[p.vnbId].length);
    const where = hasGeo ? esc(p.city || '') : '<span class="no-geo">nicht kartiert</span>';
    return `
    <div class="fw-item${hasGeo ? ' matched' : ''}" data-id="${p.vnbId}">
      <div class="fw-row1">
        <span class="check">✓</span>
        <span class="who">${esc(p.vnbName)} <span class="fw-pct" title="Smart-Meter-Quote: Pflichteinbaufälle mit iMSys">(${label})</span></span>
        <span class="where">${where}</span>
      </div>
    </div>`;
  };
  const otherItem = p => `
    <div class="fw-item unmatched">
      <div class="fw-row1"><span class="check">✓</span><span class="who">${esc(p.name)}</span></div>
    </div>`;
  // one scrolling list; the group headings are sticky so "wMSB" stays visible
  // once you scroll to it, while its items only appear as you scroll further
  el.innerHTML =
    `<div class="fw-group">
      <span>Grundzuständige MSB · mit Netzgebiet · ${matched.length}</span>
      <span class="fw-group-metric">Messstellenbetreiber (% Pflichteinbaufälle mit iMSys)</span>
    </div>` +
    matched.map(matchedItem).join('') +
    `<div class="fw-group fw-group-wmsb">Wettbewerbliche / überregionale MSB · ${other.length}</div>` +
    other.map(otherItem).join('');
  el.querySelectorAll('.fw-item.matched').forEach(it => it.onclick = () => focusVnb(it.dataset.id));
}

init();
