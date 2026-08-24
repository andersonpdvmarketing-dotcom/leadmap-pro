/**
 * LeadMap Pro — proxy opcional para Google Maps Platform
 * =======================================================
 * Protege as API keys: o browser fala apenas com este servidor; as keys
 * vivem em variáveis de ambiente e NUNCA chegam ao frontend.
 *
 * Uso local:
 *   npm init -y && npm i express
 *   GOOGLE_MAPS_API_KEY="A_TUA_KEY" node google-proxy.js
 *   → http://localhost:3333 (serve o index.html + /api/google/*)
 *
 * Produção: adaptar cada rota a uma serverless function (Netlify/Vercel)
 * e definir as env vars no painel do host.
 *
 * Requer Node 18+ (fetch nativo).
 */

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3333;

// Keys por variável de ambiente — nunca hardcoded.
const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || MAPS_KEY;

if (!MAPS_KEY) {
  console.warn('[aviso] GOOGLE_MAPS_API_KEY não definida — os endpoints /api/google/* vão responder 503.');
}

// Serve a app estática (index.html na mesma pasta)
app.use(express.static(path.join(__dirname)));

const requireKey = (key, res) => {
  if (!key) { res.status(503).json({ error: 'API key não configurada no servidor.' }); return false; }
  return true;
};

/** Geocoding API — alternativa ao Nominatim
 *  GET /api/google/geocode?q=R.+de+São+José+3,+Caneças */
app.get('/api/google/geocode', async (req, res) => {
  if (!requireKey(MAPS_KEY, res)) return;
  try {
    const url = 'https://maps.googleapis.com/maps/api/geocode/json?address=' +
      encodeURIComponent(req.query.q || '') + '&region=pt&language=pt-PT&key=' + MAPS_KEY;
    const r = await fetch(url);
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Falha a contactar a Geocoding API.' });
  }
});

/** Places API (New) — Nearby Search
 *  GET /api/google/places/nearby?lat=38.81&lon=-9.22&radius=30000&keyword=clinica
 *  Devolve leads mais ricos que o OSM (telefone, website, horários, rating). */
app.get('/api/google/places/nearby', async (req, res) => {
  if (!requireKey(PLACES_KEY, res)) return;
  try {
    const { lat, lon, radius, keyword } = req.query;
    const r = await fetch('https://places.googleapis.com/v1/places:searchNearby', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_KEY,
        // FieldMask: pedir só o necessário controla os custos por pedido.
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.internationalPhoneNumber,places.websiteUri,places.types,places.postalAddress'
      },
      body: JSON.stringify({
        languageCode: 'pt-PT',
        maxResultCount: 20,
        locationRestriction: {
          circle: {
            center: { latitude: Number(lat), longitude: Number(lon) },
            radius: Math.min(Number(radius) || 5000, 50000)
          }
        },
        ...(keyword ? { includedTypes: undefined, rankPreference: 'DISTANCE' } : {})
      })
    });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Falha a contactar a Places API.' });
  }
});

/** Places API (New) — Text Search (palavra-chave livre, ex. "imobiliária em Odivelas")
 *  GET /api/google/places/text?q=imobiliária+Odivelas */
app.get('/api/google/places/text', async (req, res) => {
  if (!requireKey(PLACES_KEY, res)) return;
  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': PLACES_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.nationalPhoneNumber,places.websiteUri,places.types'
      },
      body: JSON.stringify({ textQuery: String(req.query.q || ''), languageCode: 'pt-PT' })
    });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Falha a contactar a Places API (Text Search).' });
  }
});

/** Places API (New) — Place Details (contactos completos de um lead)
 *  GET /api/google/places/details?id=PLACE_ID */
app.get('/api/google/places/details', async (req, res) => {
  if (!requireKey(PLACES_KEY, res)) return;
  try {
    const r = await fetch('https://places.googleapis.com/v1/places/' + encodeURIComponent(req.query.id || ''), {
      headers: {
        'X-Goog-Api-Key': PLACES_KEY,
        'X-Goog-FieldMask': 'id,displayName,formattedAddress,location,nationalPhoneNumber,internationalPhoneNumber,websiteUri,types,postalAddress'
      }
    });
    res.json(await r.json());
  } catch (err) {
    res.status(502).json({ error: 'Falha a contactar a Places API (Details).' });
  }
});

app.listen(PORT, () => {
  console.log('LeadMap Pro + proxy Google em http://localhost:' + PORT);
});
