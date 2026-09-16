// /api/classificar-patrimonio.js
// Recebe um nome de item OU categoria e devolve sugestões usando Claude Haiku
//
// POST body:
//   { tipo: 'categoria', nome: 'Cadeira de escritório' }  → devolve emoji
//   { tipo: 'item', nome: 'Cadeira ergonômica Frisokar', categorias_disponiveis: ['Cadeira', 'Mesa', ...] }
//     → devolve { categoria, emoji_sugerido }

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const EMOJI_FALLBACK = {
  cadeira: '🪑', mesa: '🪵', monitor: '🖥️', notebook: '💻', computador: '🖥️',
  tv: '📺', televisão: '📺', televisao: '📺', teclado: '⌨️', mouse: '🖱️',
  webcam: '📷', headset: '🎧', fone: '🎧', sofá: '🛋️', sofa: '🛋️',
  armário: '🗄️', armario: '🗄️', rack: '📦', controle: '🎮',
  impressora: '🖨️', roteador: '🌐', telefone: '📱', celular: '📱',
  câmera: '📷', camera: '📷', projetor: '📽️', geladeira: '🧊',
  bebedouro: '🚰', cafeteira: '☕', microondas: '🔥', ar: '❄️',
};

function fallbackEmoji(nome) {
  const lower = (nome || '').toLowerCase();
  for (const [k, v] of Object.entries(EMOJI_FALLBACK)) {
    if (lower.includes(k)) return v;
  }
  return '📦';
}


// Esta rota consome créditos da Anthropic a cada chamada e estava aberta:
// qualquer POST da internet podia queimar a cota da API.
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}
const ADMINS_EMAILS = [
  'joao.faria@logcomex.com',
  'christian.bertolino@logcomex.com',
  'henrique.silva@logcomex.com',
  'adriano.martins@logcomex.com',
  'daniel.alle@logcomex.com',
];

async function exigirAdmin(req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) { const e = new Error('token ausente'); e.status = 401; throw e; }
  let decoded;
  try { decoded = await admin.auth().verifyIdToken(token); }
  catch { const e = new Error('token inválido'); e.status = 401; throw e; }
  const email = (decoded.email || '').toLowerCase();
  if (!ADMINS_EMAILS.includes(email)) { const e = new Error('sem permissão'); e.status = 403; throw e; }
  return email;
}

module.exports = async (req, res) => {
  try { await exigirAdmin(req); }
  catch (e) { return res.status(e.status || 401).json({ ok: false, error: e.message }); }

  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    const { tipo, nome, categorias_disponiveis } = req.body || {};
    if (!nome || !nome.trim()) {
      return res.status(400).json({ ok: false, error: 'nome é obrigatório' });
    }

    let prompt;
    if (tipo === 'categoria') {
      prompt = `Você está ajudando a criar uma categoria de patrimônio. O usuário digitou o nome: "${nome}".

Responda APENAS com um emoji que melhor representa essa categoria. Apenas o emoji, sem texto, sem explicação, sem aspas.

Exemplos:
- "Cadeira" → 🪑
- "Monitor LCD" → 🖥️
- "Notebook" → 💻
- "Smart TV" → 📺
- "Sofá" → 🛋️
- "Bebedouro" → 🚰
- "Cafeteira industrial" → ☕

Sua resposta (apenas o emoji):`;
    } else if (tipo === 'item') {
      const cats = Array.isArray(categorias_disponiveis) && categorias_disponiveis.length
        ? categorias_disponiveis.join(', ')
        : 'Monitor, Notebook, Computador, TV, Teclado, Mouse, Webcam, Headset, Cadeira, Mesa, Sofá, Armário, Rack, Controle, Impressora, Roteador, Telefone, Outro';

      prompt = `Você ajuda a classificar itens de patrimônio. O usuário digitou: "${nome}".

Categorias disponíveis: ${cats}

Responda APENAS com um JSON válido nesse formato (sem markdown, sem \`\`\`):
{"categoria": "<categoria escolhida da lista>", "emoji": "<emoji do item>"}

Exemplos:
- "Cadeira Frisokar ergonômica" → {"categoria": "Cadeira", "emoji": "🪑"}
- "Monitor Dell 24 polegadas" → {"categoria": "Monitor", "emoji": "🖥️"}
- "Notebook Lenovo ThinkPad" → {"categoria": "Notebook", "emoji": "💻"}
- "Geladeira Brastemp" → {"categoria": "Outro", "emoji": "🧊"}

Sua resposta (apenas o JSON):`;
    } else {
      return res.status(400).json({ ok: false, error: "tipo deve ser 'categoria' ou 'item'" });
    }

    // Chama Claude Haiku
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 150,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!aiRes.ok) {
      const errTxt = await aiRes.text();
      console.error('IA erro:', errTxt);
      // Fallback
      return res.status(200).json({
        ok: true,
        from_ai: false,
        emoji: fallbackEmoji(nome),
        categoria: 'Outro',
      });
    }

    const aiData = await aiRes.json();
    const resposta = (aiData.content?.[0]?.text || '').trim();

    if (tipo === 'categoria') {
      // Resposta é só o emoji
      const emoji = resposta.replace(/["'`]/g, '').trim();
      return res.status(200).json({
        ok: true,
        from_ai: true,
        emoji: emoji || fallbackEmoji(nome),
      });
    } else {
      // Resposta é JSON
      try {
        // Tenta limpar caso venha com ```json
        const limpo = resposta.replace(/```json|```/g, '').trim();
        const parsed = JSON.parse(limpo);
        return res.status(200).json({
          ok: true,
          from_ai: true,
          categoria: parsed.categoria || 'Outro',
          emoji: parsed.emoji || fallbackEmoji(nome),
        });
      } catch (e) {
        return res.status(200).json({
          ok: true,
          from_ai: false,
          categoria: 'Outro',
          emoji: fallbackEmoji(nome),
          parse_error: e.message,
          raw: resposta,
        });
      }
    }
  } catch (e) {
    console.error('classificar-patrimonio erro:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
