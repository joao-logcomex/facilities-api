// /api/diagnostico-sla.js
// TEMPORÁRIO: investiga a taxa real de SLA no Firebase
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

  const total = tickets.length;
  const slaTrue   = tickets.filter(t => t.dentroSLA === true).length;
  const slaFalse  = tickets.filter(t => t.dentroSLA === false).length;
  const slaNull   = tickets.filter(t => t.dentroSLA === null).length;
  const slaUndef  = tickets.filter(t => t.dentroSLA === undefined).length;

  const comSLA = slaTrue + slaFalse;
  const pct = comSLA > 0 ? Math.round((slaTrue / comSLA) * 100) : 0;

  const porOrigem = {};
  tickets.forEach(t => {
    const o = t.origem || 'sem_origem';
    porOrigem[o] = porOrigem[o] || { total: 0, slaTrue: 0, slaFalse: 0, slaNull: 0 };
    porOrigem[o].total++;
    if (t.dentroSLA === true)  porOrigem[o].slaTrue++;
    else if (t.dentroSLA === false) porOrigem[o].slaFalse++;
    else porOrigem[o].slaNull++;
  });
  Object.keys(porOrigem).forEach(o => {
    const v = porOrigem[o];
    const c = v.slaTrue + v.slaFalse;
    v.pctSLA = c > 0 ? Math.round((v.slaTrue / c) * 100) + '%' : 'N/A';
  });

  const porAno = {};
  tickets.forEach(t => {
    let ano = 'sem_data';
    try {
      const d = t.data_abertura?.toDate ? t.data_abertura.toDate() :
                (t.data_abertura ? new Date(t.data_abertura) : null);
      if (d && !isNaN(d)) ano = d.getFullYear();
    } catch {}
    porAno[ano] = porAno[ano] || { total: 0, slaTrue: 0, slaFalse: 0, slaNull: 0 };
    porAno[ano].total++;
    if (t.dentroSLA === true) porAno[ano].slaTrue++;
    else if (t.dentroSLA === false) porAno[ano].slaFalse++;
    else porAno[ano].slaNull++;
  });
  Object.keys(porAno).forEach(a => {
    const v = porAno[a];
    const c = v.slaTrue + v.slaFalse;
    v.pctSLA = c > 0 ? Math.round((v.slaTrue / c) * 100) + '%' : 'N/A';
  });

  const amostraFora = tickets.filter(t => t.dentroSLA === false).slice(0, 20).map(t => ({
    titulo: t.titulo || t.nome,
    categoria: t.categoria,
    origem: t.origem,
    status: t.status,
    _motivoForaSLA: t._motivoForaSLA,
    _recalculadoEm: t._recalculadoEm,
    data_abertura: t.data_abertura?.toDate ? t.data_abertura.toDate().toISOString() : t.data_abertura,
  }));

  res.status(200).json({
    total,
    contagens: { slaTrue, slaFalse, slaNull, slaUndef, comSLA, pct: pct + '%' },
    porOrigem,
    porAno,
    amostraFora,
  });
}
