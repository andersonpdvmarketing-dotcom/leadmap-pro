const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3333;

const MAPS_KEY = process.env.GOOGLE_MAPS_API_KEY || '';
const PLACES_KEY = process.env.GOOGLE_PLACES_API_KEY || MAPS_KEY;

const requireKey = (key, res) => {
  if (!key) {
    res.status(503).json({
      error: 'API key não configurada no servidor.'
    });
    return false;
  }

  return true;
};

const googleHeaders = (key, fieldMask) => ({
  'Content-Type': 'application/json',
  'X-Goog-Api-Key': key,
  'X-Goog-FieldMask': fieldMask
});

if (!MAPS_KEY) {
  console.warn('[LeadMap] GOOGLE_MAPS_API_KEY não definida.');
}

if (!PLACES_KEY) {
  console.warn('[LeadMap] GOOGLE_PLACES_API_KEY não definida.');
}

app.use(express.static(path.join(__dirname)));

app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    service: 'LeadMap Pro Google Proxy',
    mapsKeyConfigured: Boolean(MAPS_KEY),
    placesKeyConfigured: Boolean(PLACES_KEY)
  });
});

app.get('/api/google/geocode', async (req, res) => {
  if (!requireKey(MAPS_KEY, res)) return;

  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({
      error: 'Parâmetro q é obrigatório.'
    });
  }

  try {
    const params = new URLSearchParams({
      address: query,
      region: 'pt',
      language: 'pt-PT',
      key: MAPS_KEY
    });

    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params}`
    );

    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    console.error('[Geocoding]', error);

    res.status(502).json({
      error: 'Falha ao contactar a Google Geocoding API.'
    });
  }
});

app.get('/api/google/places/nearby', async (req, res) => {
  if (!requireKey(PLACES_KEY, res)) return;

  try {
    const lat = Number(req.query.lat);
    const lon = Number(req.query.lon);
    const radius = Math.min(
      Number(req.query.radius) || 5000,
      50000
    );

    const type = String(req.query.type || '').trim();

    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      return res.status(400).json({
        error: 'lat e lon devem ser números válidos.'
      });
    }

    const body = {
      languageCode: 'pt-PT',
      maxResultCount: 20,
      locationRestriction: {
        circle: {
          center: {
            latitude: lat,
            longitude: lon
          },
          radius
        }
      },
      rankPreference: 'DISTANCE'
    };

    if (type) {
      body.includedTypes = [type];
    }

    const response = await fetch(
      'https://places.googleapis.com/v1/places:searchNearby',
      {
        method: 'POST',
        headers: googleHeaders(
          PLACES_KEY,
          [
            'places.id',
            'places.displayName',
            'places.formattedAddress',
            'places.location',
            'places.nationalPhoneNumber',
            'places.internationalPhoneNumber',
            'places.websiteUri',
            'places.types',
            'places.postalAddress',
            'places.rating',
            'places.userRatingCount'
          ].join(',')
        ),
        body: JSON.stringify(body)
      }
    );

    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    console.error('[Places Nearby]', error);

    res.status(502).json({
      error: 'Falha ao contactar a Google Places API.'
    });
  }
});

app.get('/api/google/places/text', async (req, res) => {
  if (!requireKey(PLACES_KEY, res)) return;

  const query = String(req.query.q || '').trim();

  if (!query) {
    return res.status(400).json({
      error: 'Parâmetro q é obrigatório.'
    });
  }

  try {
    const body = {
      textQuery: query,
      languageCode: 'pt-PT',
      regionCode: 'PT',
      pageSize: 20
    };

    const response = await fetch(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: googleHeaders(
          PLACES_KEY,
          [
            'places.id',
            'places.displayName',
            'places.formattedAddress',
            'places.location',
            'places.nationalPhoneNumber',
            'places.internationalPhoneNumber',
            'places.websiteUri',
            'places.types',
            'places.postalAddress',
            'places.rating',
            'places.userRatingCount'
          ].join(',')
        ),
        body: JSON.stringify(body)
      }
    );

    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    console.error('[Places Text Search]', error);

    res.status(502).json({
      error: 'Falha ao contactar a Google Places Text Search API.'
    });
  }
});

app.get('/api/google/places/details', async (req, res) => {
  if (!requireKey(PLACES_KEY, res)) return;

  const placeId = String(req.query.id || '').trim();

  if (!placeId) {
    return res.status(400).json({
      error: 'Parâmetro id é obrigatório.'
    });
  }

  try {
    const response = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`,
      {
        headers: {
          'X-Goog-Api-Key': PLACES_KEY,
          'X-Goog-FieldMask': [
            'id',
            'displayName',
            'formattedAddress',
            'location',
            'nationalPhoneNumber',
            'internationalPhoneNumber',
            'websiteUri',
            'types',
            'postalAddress',
            'rating',
            'userRatingCount'
          ].join(',')
        }
      }
    );

    const data = await response.json();

    res.status(response.status).json(data);
  } catch (error) {
    console.error('[Places Details]', error);

    res.status(502).json({
      error: 'Falha ao contactar a Google Places Details API.'
    });
  }
});

app.listen(PORT, () => {
  console.log(
    `LeadMap Pro + Google Proxy em http://localhost:${PORT}`
  );
});
