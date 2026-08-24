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

  const lat = Number(req.query.lat);
  const lon = Number(req.query.lon);
  const radius = Math.min(Number(req.query.radius) || 5000, 50000);
  const type = String(req.query.type || '').trim();

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return res.status(400).json({
      error: 'lat e lon devem ser números válidos.'
    });
  }

  try {
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
        body: JSON.stringify(body)
      }
    );

    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[LeadMap Places Nearby]', error);

    return res.status(502).json({
      error: 'Falha ao contactar a Google Places API.'
    });
  }
}
