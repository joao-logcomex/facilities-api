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
  const snap = await db.collection('imob_categorias').get();
  return res.status(200).json({
    ok: true,
    count: snap.size,
    categorias: snap.docs.map(d => ({ id: d.id, ...d.data() }))
  });
};
