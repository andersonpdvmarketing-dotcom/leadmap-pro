export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({
      error: 'Method Not Allowed'
    });
  }

  const key = process.env.GOOGLE_PLACES_API_KEY;

  if (!key) {
    return res.status(503).json({
      error: 'GOOGLE_PLACES_API_KEY não configurada na Vercel.'
    });
  }

  const id = String(req.query.id || '').trim();

  if (!id) {
    return res.status(400).json({
      error: 'Parâmetro id é obrigatório.'
    });
  }

  try {
    const response = await fetch(
      `https://places.googleapis.com/v1/places/${encodeURIComponent(id)}`,
      {
        method: 'GET',
        headers: {
          'X-Goog-Api-Key': key,
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

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[LeadMap Places Details]', error);

    return res.status(502).json({
      error: 'Falha ao contactar a Google Places Details API.'
    });
  }
}
