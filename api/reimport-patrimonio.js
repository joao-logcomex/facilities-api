// Endpoint temp: limpa imob_patrimonio e re-importa com schema correto
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

  if (req.method === 'GET') {
    const total = (await db.collection('imob_patrimonio').count().get()).data().count;
    const sample = await db.collection('imob_patrimonio').limit(1).get();
    return res.status(200).json({
      ok: true,
      total,
      sample: sample.empty ? null : sample.docs[0].data(),
    });
  }

  if (req.method === 'POST') {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items)) return res.status(400).json({ ok: false, error: 'body.items deve ser array' });

      // Passo 1: limpar tudo que estava antes
      let deleted = 0;
      while (true) {
        const snap = await db.collection('imob_patrimonio').limit(400).get();
        if (snap.empty) break;
        const wb = db.batch();
        snap.docs.forEach(d => { wb.delete(d.ref); deleted++; });
        await wb.commit();
      }

      // Passo 2: importar com schema novo
      let imported = 0;
      const errors = [];
      const chunks = [];
      for (let i = 0; i < items.length; i += 400) chunks.push(items.slice(i, i + 400));

      for (const chunk of chunks) {
        const wb = db.batch();
        for (const item of chunk) {
          try {
            const docId = String(item.num_patrimonio || '').replace(/[\/\\]/g, '_').trim();
            if (!docId) continue;
            const ref = db.collection('imob_patrimonio').doc(docId);
            wb.set(ref, {
              ...item,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
            imported++;
          } catch (e) {
            errors.push({ patrimonio: item.num_patrimonio, error: e.message });
          }
        }
        await wb.commit();
      }

      return res.status(200).json({
        ok: true,
        deleted,
        imported,
        errors: errors.slice(0, 10),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  return res.status(405).json({ ok: false, error: 'Use GET ou POST' });
};

module.exports.config = {
  api: { bodyParser: { sizeLimit: '5mb' } }
};
