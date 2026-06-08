// Reconcilia uma nova planilha com o patrimônio existente:
// - num_patrimonio existe em ambos → mantém (marca como validado)
// - só na nova → adiciona (status: validado)
// - só na antiga → EXCLUI definitivamente
//
// POST body: { items: [{ num_patrimonio, nome, categoria, localizacao, ... }, ...] }
// Retorna: { matched, added, removed, errors }

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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST com body { items: [...] }' });
  }

  try {
    const items = req.body?.items;
    const importLabel = req.body?.label || `validacao_${new Date().toISOString().substring(0,10)}`;
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ ok: false, error: 'body.items deve ser array não-vazio' });
    }

    // Normaliza patrimonios da planilha nova
    const novosPatrimonios = new Set();
    const novosItems = new Map();
    items.forEach(it => {
      const p = String(it.num_patrimonio || '').trim();
      if (p) {
        novosPatrimonios.add(p);
        novosItems.set(p, it);
      }
    });

    // Carrega TODOS os patrimônios existentes
    const existentesSnap = await db.collection('imob_patrimonio').get();
    const existentes = new Map();
    existentesSnap.docs.forEach(d => {
      existentes.set(d.id, d.data());
    });

    const matched = [];   // bate nos dois — atualizar e marcar como validado
    const added = [];     // só na nova
    const removed = [];   // só na antiga — excluir

    for (const p of novosPatrimonios) {
      if (existentes.has(p)) matched.push(p);
      else added.push(p);
    }
    for (const p of existentes.keys()) {
      if (!novosPatrimonios.has(p)) removed.push(p);
    }

    // Executa as operações em batches de 400
    async function runBatched(ops) {
      for (let i = 0; i < ops.length; i += 400) {
        const chunk = ops.slice(i, i + 400);
        const wb = db.batch();
        chunk.forEach(op => op(wb));
        await wb.commit();
      }
    }

    // (1) MATCHED — atualiza + marca como validado
    const opsMatched = matched.map(p => (wb) => {
      const ref = db.collection('imob_patrimonio').doc(p);
      const dadosNovos = novosItems.get(p);
      const dadosAntigos = existentes.get(p);
      // Mescla: preserva campos extras (contrato_url, fornecedor, etc) que NÃO vêm da planilha
      const mesclado = {
        ...dadosAntigos,
        ...dadosNovos,
        // Mas se a planilha tem null e o existente tem valor, mantém o existente
        nome: dadosNovos.nome || dadosAntigos.nome,
        categoria: dadosNovos.categoria || dadosAntigos.categoria,
        localizacao: dadosNovos.localizacao || dadosAntigos.localizacao,
        responsavel: dadosNovos.responsavel || dadosAntigos.responsavel,
        // Campos extras preservados
        contrato_url: dadosAntigos.contrato_url || dadosNovos.contrato_url || null,
        fornecedor: dadosAntigos.fornecedor || dadosNovos.fornecedor || null,
        responsavel_compra: dadosAntigos.responsavel_compra || dadosNovos.responsavel_compra || null,
        // Status atualizado
        status_validacao: 'validado',
        ultima_validacao: importLabel,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      wb.set(ref, mesclado);
    });

    // (2) ADDED — novos
    const opsAdded = added.map(p => (wb) => {
      const ref = db.collection('imob_patrimonio').doc(p);
      const dadosNovos = novosItems.get(p);
      wb.set(ref, {
        ...dadosNovos,
        status_validacao: 'validado',
        origem_importacao: importLabel,
        ultima_validacao: importLabel,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    });

    // (3) REMOVED — exclui
    const opsRemoved = removed.map(p => (wb) => {
      const ref = db.collection('imob_patrimonio').doc(p);
      wb.delete(ref);
    });

    await runBatched(opsMatched);
    await runBatched(opsAdded);
    await runBatched(opsRemoved);

    // Salva log da reconciliação
    await db.collection('imob_reconciliacoes').add({
      label: importLabel,
      executedAt: admin.firestore.FieldValue.serverTimestamp(),
      total_planilha_nova: items.length,
      total_antes: existentes.size,
      total_depois: existentes.size + added.length - removed.length,
      matched: matched.length,
      added: added.length,
      removed: removed.length,
      sample_removed: removed.slice(0, 50),
      sample_added: added.slice(0, 50),
    });

    return res.status(200).json({
      ok: true,
      label: importLabel,
      summary: {
        matched: matched.length,
        added: added.length,
        removed: removed.length,
      },
      sample_removed: removed.slice(0, 20),
      sample_added: added.slice(0, 20),
    });
  } catch (e) {
    console.error('reconciliar-patrimonio erro:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '5mb' } }
};
