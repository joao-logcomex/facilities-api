// Endpoint temporário pra ler últimos logs do bot Slack
// Use só pra debug, apaga depois
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
    const snap = await db.collection('slack_debug_logs')
      .orderBy('at', 'desc')
      .limit(30)
      .get();

    const logs = snap.docs.map(d => {
      const x = d.data();
      return {
        at: x.at?.toDate?.()?.toISOString() || x.at,
        user: x.user,
        texto: x.texto,
        etapa: x.etapa,
        ...Object.fromEntries(Object.entries(x).filter(([k]) => !['at','user','texto','etapa'].includes(k))),
      };
    });

    return res.status(200).json({ ok: true, count: logs.length, logs });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
};
