export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const key = process.env.GOOGLE_PLACES_API_KEY;

  if (!key) {
    return res.status(503).json({
      error: 'GOOGLE_PLACES_API_KEY não configurada na Vercel.'
    });
  }

  const q = String(req.query.q || '').trim();

  if (!q) {
    return res.status(400).json({
      error: 'Parâmetro q é obrigatório.'
    });
  }

  /* locationBias opcional (lat/lon/radius) — dá contexto geográfico à Google e
     reduz resultados fora da região. Retrocompatível: sem estes parâmetros o
     comportamento é exatamente o anterior. A distância real continua a ser
     validada a jusante; o bias é uma pista, não uma garantia. */
  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Number(req.query.radius);
  const temBias = Number.isFinite(lat) && Number.isFinite(lon) &&
    lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180;

  try {
    const corpo = {
      textQuery: q,
      languageCode: 'pt-PT',
      regionCode: 'PT',
      pageSize: 20
    };
    if (temBias) {
      corpo.locationBias = {
        circle: {
          center: { latitude: lat, longitude: lon },
          radius: Math.min(Math.max(Number.isFinite(radius) ? radius : 5000, 1), 50000)
        }
      };
    }

    const response = await fetch(
      'https://places.googleapis.com/v1/places:searchText',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': key,
          'X-Goog-FieldMask': [
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
        },
        body: JSON.stringify(corpo)
      }
    );

    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[LeadMap Places Text]', error);

    return res.status(502).json({
      error: 'Falha ao contactar a Google Places API.'
    });
  }
}
