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

const LOCALIZACOES_INICIAIS = [
  { nome: 'Sala da Liderança', emoji: '👔', descricao: 'Sala da diretoria e líderes' },
  { nome: 'Recepção', emoji: '🛎️', descricao: 'Recepção principal' },
  { nome: 'Copa', emoji: '☕', descricao: 'Área de café e descompressão' },
  { nome: 'Sala de Reunião', emoji: '👥', descricao: 'Salas de reunião' },
  { nome: 'Área Comum', emoji: '🏢', descricao: 'Espaços compartilhados' },
  { nome: 'TI', emoji: '💻', descricao: 'Sala da TI e infraestrutura' },
];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }
  try {
    const existing = await db.collection('imob_localizacoes').get();
    if (!existing.empty) {
      return res.status(200).json({
        ok: true,
        msg: 'Já existem localizações cadastradas, não vou criar de novo',
        total: existing.size,
      });
    }
    const wb = db.batch();
    let added = 0;
    for (const l of LOCALIZACOES_INICIAIS) {
      const ref = db.collection('imob_localizacoes').doc();
      wb.set(ref, {
        ...l,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      added++;
    }
    await wb.commit();
    return res.status(200).json({ ok: true, added });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
