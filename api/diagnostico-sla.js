import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
function initFirebase() {
  if (!getApps().length) {
    initializeApp({ credential: cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    })});
  }
  return getFirestore();
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const db = initFirebase();
  const snap = await db.collection('tickets').get();
  const tickets = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  const slaTrue = tickets.filter(t => t.dentroSLA === true).length;
  const slaFalse = tickets.filter(t => t.dentroSLA === false).length;
  const slaNull = tickets.filter(t => t.dentroSLA === null).length;
  const slaUndef = tickets.filter(t => t.dentroSLA === undefined).length;
  const comSLA = slaTrue + slaFalse;
  const pct = comSLA > 0 ? Math.round((slaTrue / comSLA) * 100) : 0;
  const comFlag = tickets.filter(t => t._slaReset || t._recalculadoEm);
  res.status(200).json({
    total: tickets.length,
    slaTrue, slaFalse, slaNull, slaUndef, pct: pct + '%',
    tickets_com_flag_recalculo: comFlag.length,
  });
}
