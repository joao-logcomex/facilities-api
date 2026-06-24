// /api/slack-home.js
// Publica a Home Tab do bot Facilities LogComex
// Chamado quando: evento app_home_opened é recebido

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
const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

async function publishHome(userId) {
  // Buscar chamados abertos do usuário
  let chamadosAbertos = [];
  try {
    const snap = await db.collection('tickets')
      .where('slack_user_id', '==', userId)
      .where('status', 'in', ['Aberto', 'Em andamento', 'Aguardando aprovação'])
      .orderBy('data_abertura', 'desc')
      .limit(3)
      .get();
    chamadosAbertos = snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) { console.warn('Erro buscando chamados:', e.message); }

  const STATUS_EMOJI = {
    'Aberto': '🔵',
    'Em andamento': '🟠',
    'Aguardando aprovação': '🟣',
  };

  // Bloco de chamados abertos
  const chamadosBlocks = chamadosAbertos.length > 0 ? [
    {
      type: 'section',
      text: { type: 'mrkdwn', text: '*Seus chamados em aberto:*' }
    },
    ...chamadosAbertos.map(c => ({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `${STATUS_EMOJI[c.status] || '⚪'} *${c.titulo || 'Chamado'}*\n_${c.status}_ · ${c.categoria || ''}`
      }
    })),
    { type: 'divider' },
  ] : [];

  const view = {
    type: 'home',
    blocks: [
      // Header roxo simulado com context
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: '*🏢 Facilities LogComex*\nOlá! Sou seu assistente de facilities. Pode falar comigo naturalmente — me diga o que precisa e eu cuido do resto.'
        }
      },
      { type: 'divider' },

      // Chamados abertos (se houver)
      ...chamadosBlocks,

      // Atalhos
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*⚡ Atalhos rápidos*\nClique para iniciar uma conversa:' }
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '🎁 Pedir brinde', emoji: true },
            style: 'primary',
            action_id: 'home_brinde',
            value: 'brinde'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '📦 Logística', emoji: true },
            action_id: 'home_logistica',
            value: 'logistica'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔧 Manutenção', emoji: true },
            action_id: 'home_manutencao',
            value: 'manutencao'
          },
        ]
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: '📎 Suprimentos', emoji: true },
            action_id: 'home_suprimentos',
            value: 'suprimentos'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '🔑 Acessos', emoji: true },
            action_id: 'home_acessos',
            value: 'acessos'
          },
          {
            type: 'button',
            text: { type: 'plain_text', text: '📝 Outro assunto', emoji: true },
            action_id: 'home_outros',
            value: 'outros'
          },
        ]
      },
      { type: 'divider' },

      // Rodapé
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: '💬 Ou simplesmente me mande uma mensagem direta descrevendo o que precisa — eu entendo linguagem natural!'
          }
        ]
      }
    ]
  };

  const resp = await fetch('https://slack.com/api/views.publish', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SLACK_BOT_TOKEN}`
    },
    body: JSON.stringify({ user_id: userId, view })
  });

  const data = await resp.json();
  if (!data.ok) console.error('views.publish error:', data.error);
  return data.ok;
}

module.exports = async (req, res) => {
  res.status(200).send('ok');
};

module.exports.publishHome = publishHome;
