// api/brinde-aprovacao.js
// Recebe o clique do botão de Aprovar/Recusar do Slack (Slack Interactivity)
// e atualiza o Firebase + notifica o colaborador

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
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

  // Slack envia como application/x-www-form-urlencoded com campo "payload"
  let payload;
  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const params = new URLSearchParams(body);
    payload = JSON.parse(params.get('payload') || body);
  } catch {
    payload = req.body;
  }

  if (!payload || payload.type !== 'block_actions') {
    return res.status(200).json({ ok: true });
  }

  const action = payload.actions?.[0];
  if (!action) return res.status(200).json({ ok: true });

  const { action_id, value } = action;
  const { docId, ticketId, emailColaborador, nomeColaborador, itens, titulo } = JSON.parse(value || '{}');

  const db = initFirebase();
  const isAprovado = action_id === 'aprovar_brinde';
  const motivo = isAprovado ? '' : (payload.actions?.[0]?.selected_option?.value || '');

  try {
    // 1. Atualizar Firebase
    const ticketRef = db.collection('tickets').doc(docId);
    const ticketSnap = await ticketRef.get();
    const ticketData = ticketSnap.data() || {};
    const historico = ticketData.historico || [];

    await ticketRef.update({
      status: isAprovado ? 'Em andamento' : 'Cancelado',
      motivo_recusa: isAprovado ? '' : motivo,
      updatedAt: new Date(),
      historico: [...historico, {
        acao: isAprovado
          ? 'Brinde aprovado pelo gestor via Slack — encaminhado para Facilities'
          : `Brinde recusado pelo gestor via Slack${motivo ? ': ' + motivo : ''}`,
        data: new Date().toISOString(),
        usuario: payload.user?.name || 'Gestor'
      }]
    });

    // 2. Baixar estoque automaticamente quando aprovado
    if (isAprovado && itens) {
      try {
        // itens vem como string: "Contêiner Laranja x2, Moleskine x1"
        const itensList = itens.split(',').map(s => s.trim()).filter(Boolean);
        for (const itemStr of itensList) {
          // Formato: "Nome do Item xQTD" ou "Nome do Item (QTD)"
          const matchQty = itemStr.match(/x(\d+)$/) || itemStr.match(/\((\d+)\)$/);
          const qty = matchQty ? parseInt(matchQty[1]) : 1;
          const nomeItem = itemStr.replace(/\s*x\d+$/, '').replace(/\s*\(\d+\)$/, '').trim();

          // Buscar o item no estoque
          const estoqueSnap = await db.collection('estoque_brindes').get();
          const estoqueDoc = estoqueSnap.docs.find(d => 
            d.data().nome?.toLowerCase() === nomeItem.toLowerCase()
          );

          if (estoqueDoc) {
            const dados = estoqueDoc.data();
            const novoTotal = Math.max(0, (dados.estoque_total || 0) - qty);
            const novoSede = Math.max(0, (dados.estoque_sede || 0) - qty);
            await db.collection('estoque_brindes').doc(estoqueDoc.id).update({
              estoque_total: novoTotal,
              estoque_sede: novoSede,
              updatedAt: new Date()
            });
            console.log(`Estoque ${nomeItem}: -${qty} unidades → total: ${novoTotal}`);
          }
        }
      } catch(estoqueErr) {
        console.error('Erro ao baixar estoque:', estoqueErr);
      }
    }

    // 2. Atualizar a mensagem original no Slack (substituir pelos botões por status)
    const responseUrl = payload.response_url;
    if (responseUrl) {
      await fetch(responseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replace_original: true,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: isAprovado
                  ? `✅ *Brinde aprovado por você!*\nChamado *${ticketId}* encaminhado para o time de Facilities.`
                  : `❌ *Brinde recusado por você.*\nChamado *${ticketId}* cancelado.${motivo ? '\nMotivo: ' + motivo : ''}`
              }
            }
          ]
        })
      });
    }

    // 3. Notificar colaborador via DM
    if (emailColaborador) {
      await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://facilities-api.vercel.app'}/api/notify-slack`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tipo: 'aprovacao_brinde',
          ticket: ticketId,
          titulo,
          nome: nomeColaborador,
          email: emailColaborador,
          itens,
          aprovado: isAprovado,
          motivo
        })
      });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro aprovacao brinde:', err);
    return res.status(500).json({ error: err.message });
  }
}
