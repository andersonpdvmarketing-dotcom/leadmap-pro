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

  try {
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
        body: JSON.stringify({
          textQuery: q,
          languageCode: 'pt-PT',
          regionCode: 'PT',
          pageSize: 20
        })
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
