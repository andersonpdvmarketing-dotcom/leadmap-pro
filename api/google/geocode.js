export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  const key = process.env.GOOGLE_MAPS_API_KEY;

  if (!key) {
    return res.status(503).json({
      error: 'GOOGLE_MAPS_API_KEY não configurada.'
    });
  }

  const q = String(req.query.q || '').trim();

  if (!q) {
    return res.status(400).json({
      error: 'Parâmetro q é obrigatório.'
    });
  }

  try {
    const params = new URLSearchParams({
      address: q,
      region: 'pt',
      language: 'pt-PT',
      key
    });

    const response = await fetch(
      `https://maps.googleapis.com/maps/api/geocode/json?${params}`
    );

    const data = await response.json();

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('[LeadMap Geocode]', error);

    return res.status(502).json({
      error: 'Falha ao contactar a Google Geocoding API.'
    });
  }
}
