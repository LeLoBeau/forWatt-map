'use strict';
// Build data/de-border.json: the German land area (BKG VG250 "Staat" layer)
// as one simplified MultiPolygon. app.js uses it to grey out everything outside
// Germany (foreign countries and the sea).
//
// Source: BKG VG250 WFS, public, © GeoBasis-DE / BKG, dl-de/by-2-0.
// Only the land features are kept (gf 3/4); the water features (gf 1/2: North
// and Baltic Sea, Bodensee) count as "outside" like the neighbouring countries.
//
// Run: node scripts/build-border.cjs   (or: npm run build-border)

const fs = require('fs');
const path = require('path');
const https = require('https');
const { simplifyGeometry } = require('./lib/simplify.cjs');

// a country outline at mask level needs less detail than the Gemeinde shapes
const SIMPLIFY_TOLERANCE_DEG = 0.002;
const COORD_DECIMALS = 4;
const URL = 'https://sgx.geodatenzentrum.de/wfs_vg250?SERVICE=WFS&REQUEST=GetFeature&VERSION=2.0.0' +
  '&TYPENAMES=vg250:vg250_sta&OUTPUTFORMAT=application/json&SRSNAME=EPSG:4326';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`${url} -> HTTP ${res.statusCode}`)); }
      let d = ''; res.setEncoding('utf8');
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
      res.on('error', reject);
    }).on('error', reject);
  });
}

(async () => {
  const data = await fetchJson(URL);
  const land = data.features.filter(f => f.properties.lkz === 'DE' && f.properties.gf >= 3);
  if (!land.length) throw new Error('no German land features in VG250 response');

  const polygons = [];
  for (const f of land) {
    const g = simplifyGeometry(f.geometry, SIMPLIFY_TOLERANCE_DEG, COORD_DECIMALS);
    if (g.type === 'Polygon') polygons.push(g.coordinates);
    else if (g.type === 'MultiPolygon') polygons.push(...g.coordinates);
  }

  const out = { type: 'Feature', properties: { source: 'BKG VG250 (vg250_sta, gf 3/4)' },
    geometry: { type: 'MultiPolygon', coordinates: polygons } };
  const file = path.join(__dirname, '..', 'data', 'de-border.json');
  fs.writeFileSync(file, JSON.stringify(out));
  console.log(`wrote ${path.relative(process.cwd(), file)}: ${polygons.length} polygons, ${fs.statSync(file).size} bytes`);
})().catch(e => { console.error(e); process.exit(1); });
