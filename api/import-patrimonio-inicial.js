// Endpoint temporário pra importar planilha inicial de patrimônio
// Roda 1x, depois pode apagar
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

// Os 827 itens vão ser enviados via POST com body=JSON
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  // GET: status
  if (req.method === 'GET') {
    try {
      const snap = await db.collection('imob_patrimonio').limit(1).get();
      const total = (await db.collection('imob_patrimonio').count().get()).data().count;
      return res.status(200).json({
        ok: true,
        total_atual_no_firebase: total,
        sample: snap.empty ? null : snap.docs[0].data(),
      });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // POST: importa em lote
  if (req.method === 'POST') {
    try {
      const items = req.body?.items;
      if (!Array.isArray(items)) {
        return res.status(400).json({ ok: false, error: 'body.items deve ser um array' });
      }

      let imported = 0;
      let errors = 0;
      const errorList = [];

      // Firestore batch limit = 500 ops
      const batches = [];
      for (let i = 0; i < items.length; i += 400) {
        batches.push(items.slice(i, i + 400));
      }

      for (const batch of batches) {
        const wb = db.batch();
        for (const item of batch) {
          try {
            // Doc ID = número do patrimônio (limpando caracteres inválidos pra Firestore)
            const docId = String(item.patrimonio || '').replace(/[\/\\]/g, '_').trim();
            if (!docId) { errors++; continue; }
            const ref = db.collection('imob_patrimonio').doc(docId);
            wb.set(ref, {
              ...item,
              createdAt: admin.firestore.FieldValue.serverTimestamp(),
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            }, { merge: false });
            imported++;
          } catch (e) {
            errors++;
            errorList.push({ patrimonio: item.patrimonio, error: e.message });
          }
        }
        await wb.commit();
      }

      return res.status(200).json({
        ok: true,
        imported,
        errors,
        errorList: errorList.slice(0, 10),
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
