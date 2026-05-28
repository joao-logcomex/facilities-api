// /api/recalcular-sla.js
// Endpoint admin para recalcular o campo dentroSLA dos tickets de 2024 e 2025
// baseado em dados da planilha Pipefy (coluna STATUS: "Dentro da SLA" / "Fora da SLA")
//
// Uso (POST):
//   - dryRun: true (padrão) → só mostra o preview, não altera nada
//   - dryRun: false → aplica as alterações no Firebase
//   - paraFora: array de objetos { nome, dataAbertura }
//     Lista dos tickets que devem ser marcados como "Fora da SLA"

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

const db = admin.firestore();

// Admin emails permitidos
const ADMIN_EMAILS = [
  'joao.faria@logcomex.com',
  'christian.bertolino@logcomex.com',
  'henrique.silva@logcomex.com',
  'adriano.martins@logcomex.com',
  'daniel.alle@logcomex.com',
];

// Normalizar nome para comparação (remove acentos, lowercase, trim)
function norm(s) {
  if (!s) return '';
  return s
    .toString()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Normalizar data para YYYY-MM-DD (sem hora) para match aproximado
function dataKey(d) {
  if (!d) return '';
  try {
    const dt = d.toDate ? d.toDate() : new Date(d);
    if (isNaN(dt)) return '';
    return dt.toISOString().substring(0, 10);
  } catch {
    return '';
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido. Use POST.' });
  }

  // Validar admin via header (token simples baseado em email)
  const adminEmail = (req.headers['x-admin-email'] || '').toLowerCase().trim();
  if (!ADMIN_EMAILS.includes(adminEmail)) {
    return res.status(403).json({ error: 'Acesso negado. Apenas administradores.' });
  }

  const { paraFora = [], dryRun = true } = req.body || {};

  if (!Array.isArray(paraFora)) {
    return res.status(400).json({ error: 'paraFora deve ser um array.' });
  }

  try {
    // 1. Buscar todos os tickets de 2024 e 2025
    const snap = await db.collection('tickets')
      .where('data_abertura', '>=', new Date('2024-01-01'))
      .where('data_abertura', '<', new Date('2026-01-01'))
      .get();

    console.log(`📦 Encontrados ${snap.size} tickets de 2024-2025`);

    // 2. Indexar planilha por nome+data
    const planilhaIdx = new Map();
    paraFora.forEach((item) => {
      const key = `${norm(item.nome)}|${item.dataAbertura?.substring(0, 10) || ''}`;
      planilhaIdx.set(key, item);
    });

    // 3. Comparar e classificar
    const alterar = []; // tickets que mudarão de true → false
    const manterFalse = []; // já estão false (não precisa mexer)
    const naoEncontrados = []; // listados na planilha mas não acharam ticket
    let totalTrue = 0;
    let totalFalse = 0;

    snap.forEach((doc) => {
      const t = doc.data();
      // No Firebase histórico, o nome do colaborador está em "titulo" (não em "nome")
      const nomeKey = norm(t.titulo || t.nome || t.userEmail?.split('@')[0] || '');
      const dataK = dataKey(t.data_abertura);
      const key = `${nomeKey}|${dataK}`;

      if (t.dentroSLA === true) totalTrue++;
      else totalFalse++;

      if (planilhaIdx.has(key)) {
        const planItem = planilhaIdx.get(key);
        planilhaIdx.delete(key); // marca como "encontrado"
        if (t.dentroSLA === true) {
          alterar.push({
            docId: doc.id,
            id: t.id,
            titulo: t.titulo,
            categoria: t.categoria,
            tipo_pipefy: t.tipo_pipefy,
            data_abertura: dataK,
            statusAtual: 'Dentro da SLA',
            statusNovo: 'Fora da SLA',
            motivo: planItem.motivo || 'Marcado como Fora na planilha Pipefy',
          });
        } else {
          manterFalse.push({ docId: doc.id, id: t.id, titulo: t.titulo });
        }
      }
    });

    // O que sobrou no planilhaIdx = não encontrou ticket correspondente
    planilhaIdx.forEach((item, key) => {
      naoEncontrados.push({ chave: key, ...item });
    });

    // 4. Resumo
    const resumo = {
      modo: dryRun ? 'DRY-RUN (nenhuma alteração feita)' : 'APLICADO',
      totalTicketsAnalisados: snap.size,
      ticketsAtuaisDentroSLA: totalTrue,
      ticketsAtuaisForaSLA: totalFalse,
      planilhaInformou: paraFora.length,
      vaoSerAlterados: alterar.length,
      jaEstavamForaSLA: manterFalse.length,
      naoEncontradosNoFirebase: naoEncontrados.length,
      taxaSLAAtual: totalTrue + totalFalse > 0
        ? `${((totalTrue / (totalTrue + totalFalse)) * 100).toFixed(1)}%`
        : '0%',
      taxaSLADepoisDaAlteracao: totalTrue + totalFalse > 0
        ? `${(((totalTrue - alterar.length) / (totalTrue + totalFalse)) * 100).toFixed(1)}%`
        : '0%',
    };

    // 5. Se NÃO for dry-run, aplicar alterações
    if (!dryRun && alterar.length > 0) {
      const now = new Date();
      // Firestore batch máximo de 500 ops
      const chunks = [];
      for (let i = 0; i < alterar.length; i += 400) {
        chunks.push(alterar.slice(i, i + 400));
      }
      for (const chunk of chunks) {
        const batch = db.batch();
        chunk.forEach((item) => {
          batch.update(db.collection('tickets').doc(item.docId), {
            dentroSLA: false,
            _dentroSLA_antes_recalculo: true,
            _recalculadoEm: now,
            _motivoForaSLA: item.motivo,
          });
        });
        await batch.commit();
      }
      resumo.aplicadoEm = now.toISOString();
    }

    return res.status(200).json({
      sucesso: true,
      resumo,
      ...(alterar.length <= 100 ? { alterar } : { alterar: alterar.slice(0, 100), nota: `Mostrando 100 de ${alterar.length}` }),
      naoEncontrados: naoEncontrados.slice(0, 50),
    });
  } catch (err) {
    console.error('Erro no recálculo:', err);
    return res.status(500).json({ error: err.message, stack: err.stack });
  }
};
