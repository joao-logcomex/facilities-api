// /api/seed-sublocalizacoes.js
// Endpoint TEMP: cadastra as 18 salas de reuniao como sublocalizacoes da "Sala de Reuniao"
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

const SALAS = [
  // 2º andar
  { nome: '2º andar - War Room', parente: 'Sala de Reunião', emoji: '🪖' },
  { nome: '2º andar - XGH', parente: 'Sala de Reunião', emoji: '🧪' },
  { nome: '2º andar - IA', parente: 'Sala de Reunião', emoji: '🤖' },
  { nome: '2º andar - Deploy', parente: 'Sala de Reunião', emoji: '🚀' },
  { nome: '2º andar - Root', parente: 'Sala de Reunião', emoji: '🌱' },
  { nome: '2º andar - Roadmap', parente: 'Sala de Reunião', emoji: '🗺️' },
  // 1º andar
  { nome: '1º andar - Full Stack', parente: 'Sala de Reunião', emoji: '🧱' },
  { nome: '1º andar - Git', parente: 'Sala de Reunião', emoji: '🔀' },
  { nome: '1º andar - Bot', parente: 'Sala de Reunião', emoji: '🤖' },
  { nome: '1º andar - Linux', parente: 'Sala de Reunião', emoji: '🐧' },
  { nome: '1º andar - Cron', parente: 'Sala de Reunião', emoji: '⏰' },
  { nome: '1º andar - IA', parente: 'Sala de Reunião', emoji: '🧠' },
  { nome: '1º andar - HTML', parente: 'Sala de Reunião', emoji: '📄' },
  { nome: '1º andar - Cloud', parente: 'Sala de Reunião', emoji: '☁️' },
  { nome: '1º andar - Container', parente: 'Sala de Reunião', emoji: '📦' },
  { nome: '1º andar - Python', parente: 'Sala de Reunião', emoji: '🐍' },
  { nome: '1º andar - Javascript', parente: 'Sala de Reunião', emoji: '📜' },
  { nome: '1º andar - PHP', parente: 'Sala de Reunião', emoji: '🐘' },
];

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Use POST' });
  }
  try {
    const existing = await db.collection('imob_sublocalizacoes').get();
    if (!existing.empty) {
      return res.status(200).json({
        ok: true,
        msg: 'Ja existem sublocalizacoes cadastradas',
        total: existing.size,
      });
    }
    const wb = db.batch();
    let added = 0;
    for (const s of SALAS) {
      const ref = db.collection('imob_sublocalizacoes').doc();
      wb.set(ref, {
        ...s,
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