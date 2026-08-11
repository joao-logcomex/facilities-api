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

    // ── Trava contra decisão duplicada ──
    // Como Leandro e Milena (ou outro gestor futuro) recebem o MESMO pedido em
    // DMs separadas, sem essa checagem os dois poderiam clicar em coisas
    // diferentes (ex: um aprova, o outro recusa depois) e sobrescrever a
    // decisão um do outro sem saber. Se o status já não é mais "Aguardando
    // aprovação", alguém já decidiu — não processa de novo, só avisa.
    if (ticketData.status && ticketData.status !== 'Aguardando aprovação') {
      const ultimaAcao = historico[historico.length - 1];
      const quemDecidiu = ultimaAcao?.usuario || 'outro gestor';
      const responseUrlJaDecidido = payload.response_url;
      if (responseUrlJaDecidido) {
        await fetch(responseUrlJaDecidido, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            replace_original: true,
            blocks: [{
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `⚠️ *Esse brinde já foi decidido por ${quemDecidiu}* antes que você clicasse — nada foi alterado.\nChamado *${ticketId}* está como: *${ticketData.status}*.`
              }
            }]
          })
        });
      }
      return res.status(200).json({ ok: true, ja_decidido: true, por: quemDecidiu });
    }

    await ticketRef.update({
      status: isAprovado ? 'Em andamento' : 'Cancelado',
      motivo_recusa: isAprovado ? '' : motivo,
      updatedAt: new Date(),
      historico: [...historico, {
        acao: isAprovado
          ? 'Brinde aprovado pelo gestor via Slack — encaminhado para Facilities'
          : `Brinde recusado pelo gestor via Slack${motivo ? ': ' + motivo : ''}`,
        data: new Date().toISOString(),
        usuario: payload.user?.real_name || payload.user?.name || 'Gestor'
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
            const sedeAtual = typeof dados.sede === 'number' ? dados.sede : 0;
            const novaSede = Math.max(0, sedeAtual - qty);
            await db.collection('estoque_brindes').doc(estoqueDoc.id).update({
              sede: novaSede,
              ultimaAtualizacao: new Date(),
              ultimaBaixaPor: 'aprovacao_gestor',
            });
            console.log(`Estoque ${nomeItem}: -${qty} unidades → sede: ${novaSede}`);
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

    // 2b. Atualizar a mensagem dos OUTROS gestores que também receberam esse
    // pedido (ex: se a Milena decidiu, a DM do Leandro também precisa mudar,
    // senão ele vê os botões ativos ainda como se nada tivesse acontecido).
    const nomeDecisor = payload.user?.real_name || payload.user?.name || payload.user?.username || 'um gestor';
    const outrasMensagens = (ticketData.aprovacao_slack_msgs || []).filter(m => m.ts && m.channel);
    await Promise.all(outrasMensagens.map(async (msg) => {
      try {
        await fetch('https://slack.com/api/chat.update', {
          method: 'POST',
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            channel: msg.channel,
            ts: msg.ts,
            text: isAprovado ? `✅ Brinde aprovado por ${nomeDecisor}` : `❌ Brinde recusado por ${nomeDecisor}`,
            blocks: [{
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: isAprovado
                  ? `✅ *Brinde aprovado por ${nomeDecisor}.*\nChamado *${ticketId}* encaminhado para o time de Facilities.`
                  : `❌ *Brinde recusado por ${nomeDecisor}.*\nChamado *${ticketId}* cancelado.${motivo ? '\nMotivo: ' + motivo : ''}`
              }
            }]
          })
        });
      } catch (e) {
        console.warn('Não consegui atualizar mensagem de outro gestor:', e.message);
      }
    }));

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

    // 4. Notificar o Joao (admin) via DM direta
    try {
      const JOAO_DM = 'D0B0NEKTYLA';
      const nomeAprovador = payload.user?.real_name || payload.user?.name || payload.user?.username || 'alguém';
      const itensTxt = Array.isArray(itens) && itens.length
        ? itens.map(i => `• ${i.quantidade || ''} ${i.nome || i}`).join('\n')
        : (typeof itens === 'string' ? itens : '(sem detalhes)');

      const textoJoao = isAprovado
        ? `✅ *Brinde APROVADO* por ${nomeAprovador}\n*Chamado:* ${ticketId}\n*Solicitante:* ${nomeColaborador || emailColaborador || '—'}\n*Itens:*\n${itensTxt}`
        : `❌ *Brinde REJEITADO* por ${nomeAprovador}\n*Chamado:* ${ticketId}\n*Solicitante:* ${nomeColaborador || emailColaborador || '—'}\n*Itens:*\n${itensTxt}${motivo ? '\n*Motivo:* ' + motivo : ''}`;

      await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.SLACK_BOT_TOKEN}`
        },
        body: JSON.stringify({
          channel: JOAO_DM,
          text: textoJoao,
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: textoJoao } }
          ]
        })
      });
    } catch (e) {
      console.error('Erro notificar Joao:', e.message);
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Erro aprovacao brinde:', err);
    return res.status(500).json({ error: err.message });
  }
}

