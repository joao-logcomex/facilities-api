// Atualiza emoji da Mini Agenda no Firebase (1x só, depois apaga)
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
  try {
    const ref = db.collection('estoque_brindes').doc('mini-agenda');
    await ref.update({
      emoji: '📔',
      updatedAt: new Date(),
    });
    const docNow = await ref.get();
    return res.status(200).json({
      ok: true,
      msg: 'Emoji atualizado',
      data: docNow.data()
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
