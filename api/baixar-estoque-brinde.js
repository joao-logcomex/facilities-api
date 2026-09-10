// /api/baixar-estoque-brinde.js
// Baixa do estoque (sede) os brindes pedidos via Slack bot
// POST { texto: "2 moleskines e 3 garrafas pretas" }
// Devolve { ok, baixas: [{nome, qtd, antes, depois, alerta}], naoEncontrados: [...] }

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
const db = admin.firestore();

// ── Supabase: estoque_brindes migrou do Firestore ──
const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

async function listarEstoque() {
  const r = await fetch(`${SB_URL}/rest/v1/estoque_brindes?select=*&ativo=eq.true&order=nome.asc`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
  });
  if (!r.ok) throw new Error(`Supabase respondeu ${r.status} em estoque_brindes`);
  return r.json();
}

// Baixa atômica no Postgres: nunca fica negativo e não corre risco de
// sobrescrever a baixa da aprovação do gestor no mesmo instante.
async function baixarNoSupabase(id, qtd, por) {
  const r = await fetch(`${SB_URL}/rest/v1/rpc/baixar_estoque_brinde`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
    body: JSON.stringify({ p_id: id, p_qtd: qtd, p_por: por }),
  });
  if (!r.ok) throw new Error(`RPC baixar_estoque_brinde ${r.status}: ${await r.text()}`);
  return r.json();
}

// Normaliza texto: minúsculo, sem acentos, singular básico
function norm(s) {
  return (s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/s\b/g, '') // remove 's' final
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Pra cada brinde do estoque, procura no texto:
// - "<numero> <nome>" ex: "3 canetas"
// - "<nome> x <numero>" ex: "moleskine x 2"
function detectarPedido(textoNorm, brindeNomeNorm) {
  // Quebra nome em palavras-chave (ex: "garrafa preta" -> ["garrafa", "preta"])
  const palavras = brindeNomeNorm.split(' ').filter(p => p.length >= 3);
  if (!palavras.length) return null;

  // Constrói regex que aceita as palavras em qualquer ordem
  // Caso simples: nome com 1 palavra (ex "caneta")
  if (palavras.length === 1) {
    const p = palavras[0];
    // Padrão 1: número antes
    const re1 = new RegExp(`(\\d+)\\s+\\w*${p}\\w*`, 'i');
    const m1 = textoNorm.match(re1);
    if (m1) return parseInt(m1[1], 10);
    // Padrão 2: número depois (ex: "canetas x 5" / "canetas 5")
    const re2 = new RegExp(`\\w*${p}\\w*\\s+(?:x\\s+)?(\\d+)`, 'i');
    const m2 = textoNorm.match(re2);
    if (m2) return parseInt(m2[1], 10);
    return null;
  }

  // Nome com 2+ palavras (ex "garrafa preta")
  // Padrão: número + as duas palavras próximas
  const p1 = palavras[0];
  const p2 = palavras[palavras.length - 1];
  const re = new RegExp(`(\\d+)\\s+\\w*${p1}\\w*(?:\\s+\\w+){0,3}\\s+\\w*${p2}\\w*`, 'i');
  const m = textoNorm.match(re);
  if (m) return parseInt(m[1], 10);
  // Tenta também: nome + número
  const re2 = new RegExp(`\\w*${p1}\\w*(?:\\s+\\w+){0,3}\\s+\\w*${p2}\\w*\\s+(?:x\\s+)?(\\d+)`, 'i');
  const m2 = textoNorm.match(re2);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    const texto = (req.body?.texto || '').trim();
    if (!texto) return res.status(400).json({ ok: false, error: 'texto obrigatorio' });

    const textoNorm = norm(texto);
    const estoque = await listarEstoque();
    if (!estoque.length) {
      return res.status(200).json({ ok: true, baixas: [], naoEncontrados: [], aviso: 'Estoque vazio' });
    }

    const baixas = [];
    const alertas = [];

    for (const dados of estoque) {
      const nome = dados.nome || dados.id;
      const nomeNorm = norm(nome);

      const qtdPedida = detectarPedido(textoNorm, nomeNorm);
      if (!qtdPedida || qtdPedida <= 0) continue;

      const sedeAntes = typeof dados.estoque_sede === 'number' ? dados.estoque_sede : 0;
      const minimo = typeof dados.minimo_alerta === 'number' ? dados.minimo_alerta : 0;

      // Pedido maior que o disponível: avisa, mas baixa o que tem.
      // O Postgres trava em 0 (greatest), então nunca fica negativo.
      const alertaPedido = qtdPedida > sedeAntes ? 'pedido_maior_que_estoque' : null;

      let linha;
      try {
        linha = await baixarNoSupabase(dados.id, qtdPedida, 'bot_slack');
      } catch (errBaixa) {
        console.error(`Falha ao baixar ${dados.id} (-${qtdPedida}):`, errBaixa.message);
        continue;
      }
      const sedeDepois = linha && typeof linha.estoque_sede === 'number'
        ? linha.estoque_sede
        : Math.max(0, sedeAntes - qtdPedida);

      const alerta = alertaPedido || (sedeDepois <= minimo ? 'abaixo_minimo' : null);

      baixas.push({
        nome,
        qtd: qtdPedida,
        sedeAntes,
        sedeDepois,
        alerta,
      });

      if (alerta) {
        alertas.push({ nome, qtd: qtdPedida, sedeDepois, minimo, alerta });
      }
    }

    return res.status(200).json({
      ok: true,
      baixas,
      alertas,
      total_itens_baixados: baixas.length,
    });
  } catch (e) {
    console.error('baixar-estoque-brinde erro:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};