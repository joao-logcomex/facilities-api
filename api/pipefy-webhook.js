// api/pipefy-webhook.js
// Webhook que recebe eventos do Pipefy em tempo real e salva no Firebase

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

// Inicializar Firebase Admin (usa variável de ambiente)
function getDB() {
  if (!getApps().length) {
    initializeApp({
      credential: cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
      }),
    });
  }
  return getFirestore();
}

// Mapeamento de tipo → categoria (igual ao admin.html)
const CAT_MAP = {
  'Suprimentos de escritório': 'suprimentos',
  'Manutenção': 'manutencao',
  'Brinde': 'brindes',
  'Recebimento de Encomendas': 'outros',
  'Elogios ou Sugestões': 'outros',
  'Acessos': 'plataformas',
};

// Mapeamento de fase → status
const FASE_STATUS = {
  'Solicitações': 'Aberto',
  'Aprovação Gestor CS': 'Aguardando aprovação',
  'Brinde': 'Aguardando aprovação',
  'Brinde Comercial': 'Aguardando aprovação',
  'Brinde Coleta': 'Em andamento',
  'Acessos': 'Em andamento',
  'Suprimentos de escritório': 'Em andamento',
  'Manutenção': 'Em andamento',
  'Recebimento de Encomendas': 'Concluído',
  'Elogios ou Sugestões': 'Concluído',
  'Solicitações concluídas': 'Concluído',
  'Solicitações Canceladas': 'Cancelado',
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = req.body;
    console.log('Webhook Pipefy recebido:', JSON.stringify(payload).substring(0, 500));

    // O Pipefy envia { data: { action, card: { id, title, current_phase, fields, ... } } }
    const action = payload?.data?.action;
    const card = payload?.data?.card;

    if (!card || !card.id) {
      return res.status(200).json({ ok: true, msg: 'Sem card no payload, ignorado' });
    }

    const db = getDB();
    const docId = `pipefy-${card.id}`;
    const now = new Date();

    // Pegar fase atual
    const faseNome = card.current_phase?.name || '';
    const status = FASE_STATUS[faseNome] || 'Em andamento';

    // Pegar tipo de solicitação dos campos
    const tipo = card.fields?.find(f => f.name === 'Tipo de solicitação')?.value || faseNome;
    const descricao = card.fields?.find(f => f.name === 'Descrição do problema ou necessidade')?.value || '';
    const itens = card.fields?.find(f => f.name === 'Itens recebidos')?.value || '';

    const docData = {
      id: docId,
      titulo: card.title || 'Sem título',
      descricao: descricao || itens,
      categoria: CAT_MAP[tipo] || 'outros',
      tipo_pipefy: tipo,
      fase_pipefy: faseNome,
      status,
      prioridade: 'Média',
      userId: 'pipefy-import',
      userEmail: card.assignees?.[0]?.email || 'pipefy@logcomex.com',
      origem: 'pipefy',
      pipefy_id: String(card.id),
      dentroSLA: null,
      data_abertura: card.created_at ? new Date(card.created_at) : now,
      data_conclusao: card.finished_at ? new Date(card.finished_at) : null,
      updatedAt: now,
    };

    // Se o card foi deletado/movido para cancelado
    if (action === 'card.delete') {
      docData.status = 'Cancelado';
    }

    // Recuperar fase anterior (se houver) ANTES de salvar
    const docRef = db.collection('tickets').doc(docId);
    const snapAntes = await docRef.get();
    const faseAnterior = snapAntes.exists ? (snapAntes.data().fase_pipefy || null) : null;
    const statusAnterior = snapAntes.exists ? (snapAntes.data().status || null) : null;

    await docRef.set(docData, { merge: true });

    console.log(`✅ Card ${docId} salvo — ação: ${action}, status: ${status}`);

    // ── Notificações Slack ─────────────────────────────────────
    // 1) Novo chamado → DM para o admin
    // 2) Mudança de fase → DM para o colaborador
    const baseUrl = process.env.VERCEL_URL
      ? `https://${process.env.VERCEL_URL}`
      : 'https://facilities-api.vercel.app';

    try {
      if (action === 'card.create') {
        // Pula brindes (já tem fluxo próprio com aprovação)
        if (docData.categoria !== 'brindes') {
          fetch(`${baseUrl}/api/notify-slack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tipo: 'novo_chamado_admin',
              ticket: docId,
              ticketId: docId,
              titulo: docData.titulo,
              categoria: docData.tipo_pipefy || docData.categoria,
              solicitanteEmail: docData.userEmail,
              solicitanteNome: docData.userEmail?.split('@')[0] || '—',
            })
          }).catch(err => console.error('Erro notif admin:', err));
        }
      } else if (action === 'card.move' && faseAnterior && faseAnterior !== faseNome) {
        // Notificar colaborador apenas se a fase mudou de verdade
        // E só se tiver email de colaborador real (não pipefy-import genérico)
        const emailColab = docData.userEmail;
        if (emailColab && emailColab !== 'pipefy@logcomex.com' && emailColab.includes('@')) {
          fetch(`${baseUrl}/api/notify-slack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              tipo: 'mudanca_fase_colaborador',
              ticket: docId,
              ticketId: docId,
              titulo: docData.titulo,
              solicitanteEmail: emailColab,
              solicitanteNome: emailColab.split('@')[0],
              faseAnterior,
              faseAtual: faseNome,
              statusAtual: status,
            })
          }).catch(err => console.error('Erro notif colaborador:', err));
        }
      }
    } catch (slackErr) {
      console.error('Erro ao notificar Slack:', slackErr);
      // Não falha o webhook por causa do Slack
    }

    return res.status(200).json({ ok: true, docId, status, action });

  } catch (err) {
    console.error('Erro webhook Pipefy:', err);
    return res.status(500).json({ error: err.message });
  }
}
