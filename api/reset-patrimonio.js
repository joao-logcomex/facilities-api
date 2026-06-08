// Endpoint temp: zera imob_patrimonio + cadastra categorias iniciais
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

const CATEGORIAS_INICIAIS = [
  { nome: 'Monitor', emoji: '🖥️', descricao: 'Monitores de mesa' },
  { nome: 'Notebook', emoji: '💻', descricao: 'Notebooks e laptops' },
  { nome: 'Computador', emoji: '🖥️', descricao: 'Desktops e all-in-one' },
  { nome: 'TV', emoji: '📺', descricao: 'Smart TVs e televisores' },
  { nome: 'Teclado', emoji: '⌨️', descricao: 'Teclados' },
  { nome: 'Mouse', emoji: '🖱️', descricao: 'Mouses' },
  { nome: 'Webcam', emoji: '📷', descricao: 'Webcams e câmeras de videoconferência' },
  { nome: 'Headset', emoji: '🎧', descricao: 'Fones e headsets' },
  { nome: 'Cadeira', emoji: '🪑', descricao: 'Cadeiras e poltronas' },
  { nome: 'Mesa', emoji: '🪵', descricao: 'Mesas, escrivaninhas, bancadas' },
  { nome: 'Sofá', emoji: '🛋️', descricao: 'Sofás e poltronas de descanso' },
  { nome: 'Armário', emoji: '🗄️', descricao: 'Armários e estantes' },
  { nome: 'Rack', emoji: '📦', descricao: 'Racks e suportes' },
  { nome: 'Controle', emoji: '🎮', descricao: 'Controles remotos e similares' },
  { nome: 'Impressora', emoji: '🖨️', descricao: 'Impressoras e multifuncionais' },
  { nome: 'Roteador', emoji: '🌐', descricao: 'Roteadores e access points' },
  { nome: 'Telefone', emoji: '📱', descricao: 'Telefones, celulares' },
  { nome: 'Outro', emoji: '📦', descricao: 'Itens diversos' },
];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }

  try {
    // 1. Apagar todos os patrimônios atuais
    let deletedPatrim = 0;
    while (true) {
      const snap = await db.collection('imob_patrimonio').limit(400).get();
      if (snap.empty) break;
      const wb = db.batch();
      snap.docs.forEach(d => { wb.delete(d.ref); deletedPatrim++; });
      await wb.commit();
    }

    // 2. Apagar categorias antigas se existirem
    let deletedCat = 0;
    const catSnap = await db.collection('imob_categorias').get();
    if (!catSnap.empty) {
      const wb = db.batch();
      catSnap.docs.forEach(d => { wb.delete(d.ref); deletedCat++; });
      await wb.commit();
    }

    // 3. Cadastrar categorias iniciais
    const wb = db.batch();
    let addedCat = 0;
    for (const c of CATEGORIAS_INICIAIS) {
      const ref = db.collection('imob_categorias').doc();
      wb.set(ref, {
        ...c,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      addedCat++;
    }
    await wb.commit();

    return res.status(200).json({
      ok: true,
      patrimonio_apagado: deletedPatrim,
      categorias_antigas_apagadas: deletedCat,
      categorias_cadastradas: addedCat,
    });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
};
