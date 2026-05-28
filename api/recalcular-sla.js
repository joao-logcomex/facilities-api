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
const FORA_SLA = [
  { nome: "Alef", dataAbertura: "2025-04-02", motivo: "Excedeu em 100% (Acessos)" },
  { nome: "amandha afonso alves", dataAbertura: "2025-07-08", motivo: "Excedeu em 100% (Acessos)" },
  { nome: "Ana Paula Busato Karp", dataAbertura: "2025-04-01", motivo: "Excedeu em 150% (Acessos)" },
  { nome: "Andressa Fernanda Jacoby Fuks", dataAbertura: "2025-06-24", motivo: "Excedeu em 150% (Acessos)" },
  { nome: "Andressa Viana", dataAbertura: "2025-04-16", motivo: "Excedeu em 250% (Acessos)" },
  { nome: "Andreza Sandim Pinto", dataAbertura: "2025-04-16", motivo: "Excedeu em 200% (Acessos)" },
  { nome: "Bruna Petel", dataAbertura: "2025-07-08", motivo: "Excedeu em 100% (Acessos)" },
  { nome: "Bruno Carstens Mombelli", dataAbertura: "2025-07-08", motivo: "Excedeu em 100% (Acessos)" },
  { nome: "Caio Ferreira Silva", dataAbertura: "2025-01-08", motivo: "Excedeu em 150% (Acessos)" },
  { nome: "Fábio Rodrigues Siqueira", dataAbertura: "2025-06-11", motivo: "Excedeu em 140% (Brinde)" },
  { nome: "Fernanda Capelari", dataAbertura: "2025-05-27", motivo: "Excedeu em 40% (Brinde)" },
  { nome: "Ladyane Camila Silva Guetten", dataAbertura: "2025-01-08", motivo: "Excedeu em 150% (Acessos)" },
  { nome: "Lauryn Rodrigues Charneski", dataAbertura: "2025-04-24", motivo: "Excedeu em 771% (Suprimentos)" },
  { nome: "Lucas Carrer", dataAbertura: "2025-01-21", motivo: "Excedeu em 14% (Suprimentos)" },
  { nome: "Marcel Klingenfus Scheibe", dataAbertura: "2025-04-16", motivo: "Excedeu em 57% (Suprimentos)" },
  { nome: "QUETLEN VERONICA DA SILVA CAPISTRANO", dataAbertura: "2025-03-21", motivo: "Excedeu em 200% (Suprimentos)" },
  { nome: "Sabrina Correa de Oliveira Marques", dataAbertura: "2025-07-24", motivo: "Excedeu em 100% (Suprimentos)" },
  { nome: "Yasmim Nunes Barbosa", dataAbertura: "2025-04-15", motivo: "Excedeu em 86% (Suprimentos)" },
  { nome: "Laura Rigonato Oratz", dataAbertura: "2025-01-23", motivo: "Excedeu em 886% (Suprimentos)" },
];
function norm(s) { return s ? s.toString().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim() : ''; }
function dataKey(d) { try { const dt = d?.toDate ? d.toDate() : (d ? new Date(d) : null); return dt && !isNaN(dt) ? dt.toISOString().substring(0,10) : ''; } catch { return ''; } }

module.exports = async function handler(req, res) {
  const dryRun = req.query.apply !== '1';
  const snap = await db.collection('tickets').where('origem', '==', 'pipefy').get();
  const tickets2024_2025 = [];
  snap.forEach(doc => {
    const t = doc.data();
    const ano = dataKey(t.data_abertura).substring(0, 4);
    if (ano === '2024' || ano === '2025') tickets2024_2025.push({ docId: doc.id, ...t });
  });
  const planilhaIdx = new Map();
  FORA_SLA.forEach(item => planilhaIdx.set(`${norm(item.nome)}|${item.dataAbertura}`, item));
  const reset_to_true = [], marcar_false = [];
  tickets2024_2025.forEach(t => {
    const key = `${norm(t.titulo || t.nome || '')}|${dataKey(t.data_abertura)}`;
    const naLista = planilhaIdx.get(key);
    if (naLista) {
      planilhaIdx.delete(key);
      if (t.dentroSLA !== false) marcar_false.push({ docId: t.docId, motivo: naLista.motivo });
    } else {
      if (t.dentroSLA === false) reset_to_true.push({ docId: t.docId });
    }
  });
  const resumo = {
    modo: dryRun ? 'DRY-RUN' : 'APLICADO',
    total: tickets2024_2025.length,
    reset_para_true: reset_to_true.length,
    marcar_como_false: marcar_false.length,
    nao_encontrados: planilhaIdx.size,
  };
  if (!dryRun) {
    const now = new Date();
    for (let i = 0; i < reset_to_true.length; i += 400) {
      const batch = db.batch();
      reset_to_true.slice(i, i+400).forEach(item => {
        batch.update(db.collection('tickets').doc(item.docId), {
          dentroSLA: true,
          _slaReset: now,
          _motivoForaSLA: admin.firestore.FieldValue.delete(),
        });
      });
      await batch.commit();
    }
    for (let i = 0; i < marcar_false.length; i += 400) {
      const batch = db.batch();
      marcar_false.slice(i, i+400).forEach(item => {
        batch.update(db.collection('tickets').doc(item.docId), {
          dentroSLA: false,
          _recalculadoEm: now,
          _motivoForaSLA: item.motivo,
        });
      });
      await batch.commit();
    }
  }
  res.status(200).json({ sucesso: true, resumo });
};
