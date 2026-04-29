// api/pipefy.js
// Proxy Vercel para Pipefy GraphQL — resolve CORS

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const PIPEFY_TOKEN = process.env.PIPEFY_TOKEN;
  if (!PIPEFY_TOKEN) return res.status(500).json({ error: 'PIPEFY_TOKEN não configurado' });

  const { query } = req.body;
  if (!query) return res.status(400).json({ error: 'query obrigatória' });

  try {
    const r = await fetch('https://api.pipefy.com/graphql', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${PIPEFY_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query }),
    });

    const data = await r.json();
    return res.status(200).json(data);
  } catch (err) {
    console.error('Erro Pipefy proxy:', err);
    return res.status(500).json({ error: err.message });
  }
}
