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
module.exports = async function handler(req, res) {
  try {
    const snap = await db.collection('slack_debug_logs').limit(50).get();
    const logs = snap.docs.map(d => ({
      ...d.data(),
      at: d.data().at?.toDate ? d.data().at.toDate().toISOString() : null
    }));
    logs.sort((a, b) => (b.at || '').localeCompare(a.at || ''));
    res.status(200).json({ count: logs.length, logs: logs.slice(0, 30) });
  } catch (err) {
    res.status(200).json({ error: err.message });
  }
};
