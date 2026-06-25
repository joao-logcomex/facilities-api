﻿// /api/slack-comando.js
// Endpoint único para abertura de chamados via Slack
//
// Trata 3 tipos de payload:
//   1. Slash command  → /facilities         (Content-Type: application/x-www-form-urlencoded)
//   2. Shortcut       → atalho do Slack     (payload JSON em form-data)
//   3. Interactivity  → cliques/submits     (payload JSON em form-data)
//
// Fluxo:
//   1. Pessoa digita /facilities ou clica no atalho → abre Modal #1 (Selecionar Categoria)
//   2. Pessoa escolhe categoria → modal atualiza com campos específicos
//   3. Pessoa preenche e envia → cria ticket no Firebase + notifica admin + DM confirmação

const admin = require('firebase-admin');
const crypto = require('crypto');

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

// Categorias suportadas (alinhadas com o sistema)
const CATEGORIAS = [
  { value: 'suprimentos', label: '📎 Suprimentos de escritório', emoji: '📎' },
  { value: 'manutencao',  label: '🔧 Manutenção',                emoji: '🔧' },
  { value: 'reforma',     label: '🏗️ Reforma & Melhoria',         emoji: '🏗️' },
  { value: 'acessos',     label: '🔑 Acessos / Plataformas',      emoji: '🔑' },
  { value: 'brindes',     label: '🎁 Brindes',                    emoji: '🎁' },
  { value: 'logistica',   label: '📦 Logística (envio)',          emoji: '📦' },
  { value: 'outros',      label: '📝 Outros',                     emoji: '📝' },
];

const ITENS_BRINDE = [
  { value: 'moleskine',       label: '📓 Moleskine' },
  { value: 'container-preto', label: '⬛ Contêiner Preto' },
  { value: 'container-laranja', label: '🟧 Contêiner Laranja' },
  { value: 'container-branco', label: '⬜ Contêiner Branco' },
  { value: 'container-roxo',  label: '🟪 Contêiner Roxo' },
  { value: 'sacola-preta',    label: '👜 Sacola Preta' },
  { value: 'garrafa-branca',  label: '🥤 Garrafa Branca' },
  { value: 'garrafa-preta',   label: '🍶 Garrafa Preta' },
  { value: 'copo-egg-branco', label: '🥚 Copo Egg Branco' },
  { value: 'copo-egg-preto',  label: '🥚 Copo Egg Preto' },
  { value: 'tapa-camera',     label: '📷 Tapa Câmera' },
  { value: 'caneta',          label: '🖊️ Caneta' },
];

const PRIORIDADES = [
  { value: 'baixa', label: '🟢 Baixa' },
  { value: 'media', label: '🟡 Média' },
  { value: 'alta',  label: '🔴 Alta' },
];

// ─────────────────────────────────────────────────────────────
// CENTROS DE CUSTO DE CS — só esses precisam de aprovação do Leandro
// (qualquer outro CC é tratado como Comercial/Outros: sem aprovação)
// ─────────────────────────────────────────────────────────────
const CC_CS = [
  'CS GERAL GROWTH',
  'CS GROWTH',
  'CS INTERNACIONAL PPMF',
  'CS OPS & INSIGHTS GROWTH',
  'CS PPMF',
  'PROFESSIONAL SERVICES GROWTH',
  'QUALIDADE GERAL GROWTH',
  'QUALIDADE GROWTH',
  'QUALIDADE PPMF',
  'SUPORTE GROWTH',
  'SUPORTE PPMF',
];

// Brindes liberados pra COMERCIAL (e outros não-CS) — sem aprovação
const BRINDES_COMERCIAL = [
  'Mini Agenda',
  'Caneta',
  'Garrafa Preta',
  'Sacola Preta',
];

// Função: detecta se um centro de custo é CS
function isCentroCustoCS(cc) {
  if (!cc) return false;
  const ccUp = String(cc).toUpperCase().trim();
  return CC_CS.some(c => c.toUpperCase() === ccUp);
}

// ============================================================================
// Helpers de parsing
// ============================================================================

async function parseBody(req) {
  // Vercel já parseia application/json em req.body
  // Para application/x-www-form-urlencoded, precisamos parsear manualmente
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  let raw = '';
  if (req.body && Buffer.isBuffer(req.body)) raw = req.body.toString('utf8');
  else if (typeof req.body === 'string') raw = req.body;
  else {
    // ler stream manualmente
    const chunks = [];
    for await (const c of req) chunks.push(c);
    raw = Buffer.concat(chunks).toString('utf8');
  }
  const params = {};
  raw.split('&').forEach(pair => {
    const [k, v] = pair.split('=');
    if (k) params[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent((v || '').replace(/\+/g, ' '));
  });
  // Se tem campo 'payload', é interactivity → parsear JSON dentro
  if (params.payload) {
    try { return JSON.parse(params.payload); } catch { /* segue */ }
  }
  return params;
}

// Verifica assinatura do Slack (proteção contra requisições falsas)
function verificarAssinatura(req, rawBody) {
  const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
  if (!SLACK_SIGNING_SECRET) return true; // se não configurado, pular (dev)
  const ts = req.headers['x-slack-request-timestamp'];
  const sig = req.headers['x-slack-signature'];
  if (!ts || !sig) return false;
  // Reject if timestamp older than 5 minutes (replay protection)
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const baseString = `v0:${ts}:${rawBody}`;
  const mySig = 'v0=' + crypto.createHmac('sha256', SLACK_SIGNING_SECRET).update(baseString).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(sig)); } catch { return false; }
}

// ============================================================================
// Construção dos Modais (Block Kit)
// ============================================================================

// Modal #1: escolha de categoria
function modalEscolherCategoria(privateMetadata = '') {
  return {
    type: 'modal',
    callback_id: 'modal_escolher_categoria',
    private_metadata: privateMetadata,
    title:  { type: 'plain_text', text: 'Abrir chamado' },
    submit: { type: 'plain_text', text: 'Continuar' },
    close:  { type: 'plain_text', text: 'Cancelar' },
    blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: '*🏢 Facilities LogComex*\nSelecione a categoria do seu chamado.' } },
      { type: 'divider' },
      {
        type: 'input',
        block_id: 'b_categoria',
        label: { type: 'plain_text', text: 'Categoria' },
        element: {
          type: 'static_select',
          action_id: 'i_categoria',
          placeholder: { type: 'plain_text', text: 'Escolha uma categoria' },
          options: CATEGORIAS.map(c => ({
            text: { type: 'plain_text', text: c.label, emoji: true },
            value: c.value,
          })),
        }
      }
    ]
  };
}

// Modal #2: campos por categoria
function modalCamposPorCategoria(categoria, dadosUser = {}) {
  const base = {
    type: 'modal',
    callback_id: 'modal_criar_ticket',
    private_metadata: JSON.stringify({ categoria, ...dadosUser }),
    title:  { type: 'plain_text', text: 'Novo chamado' },
    submit: { type: 'plain_text', text: 'Abrir chamado' },
    close:  { type: 'plain_text', text: 'Cancelar' },
    blocks: []
  };

  const catLabel = CATEGORIAS.find(c => c.value === categoria)?.label || categoria;
  base.blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `Categoria: *${catLabel}*` }] });

  // Campos comuns: título + descrição + prioridade
  base.blocks.push({
    type: 'input',
    block_id: 'b_titulo',
    label: { type: 'plain_text', text: categoria === 'logistica' ? 'O que precisa enviar?' : 'Resumo da solicitação' },
    element: {
      type: 'plain_text_input',
      action_id: 'i_titulo',
      placeholder: { type: 'plain_text', text: categoria === 'suprimentos' ? 'Ex: Mouse sem fio' : categoria === 'manutencao' ? 'Ex: Ar condicionado da sala 3 com vazamento' : 'Ex: Mouse novo' },
      max_length: 100
    }
  });

  // Campos específicos por categoria
  if (categoria === 'brindes') {
    base.blocks.push({
      type: 'input',
      block_id: 'b_itens',
      label: { type: 'plain_text', text: 'Quais itens? (escolha quantos quiser)' },
      element: {
        type: 'multi_static_select',
        action_id: 'i_itens',
        placeholder: { type: 'plain_text', text: 'Escolher itens de brinde' },
        options: ITENS_BRINDE.map(i => ({
          text: { type: 'plain_text', text: i.label, emoji: true },
          value: i.value,
        }))
      }
    });
    base.blocks.push({
      type: 'input',
      block_id: 'b_quantidade',
      label: { type: 'plain_text', text: 'Quantidade total (de cada item)' },
      element: {
        type: 'number_input',
        action_id: 'i_quantidade',
        is_decimal_allowed: false,
        min_value: '1',
        max_value: '500',
        initial_value: '1'
      }
    });
    base.blocks.push({
      type: 'input',
      block_id: 'b_entrega',
      label: { type: 'plain_text', text: 'Tipo de entrega' },
      element: {
        type: 'static_select',
        action_id: 'i_entrega',
        options: [
          { text: { type: 'plain_text', text: '🏢 Retirar na sede' }, value: 'retirar' },
          { text: { type: 'plain_text', text: '📦 Enviar para endereço' }, value: 'envio' },
        ]
      }
    });
  }

  if (categoria === 'logistica') {
    base.blocks.push({
      type: 'input',
      block_id: 'b_transportadora',
      label: { type: 'plain_text', text: 'Transportadora' },
      element: {
        type: 'static_select',
        action_id: 'i_transportadora',
        options: [
          { text: { type: 'plain_text', text: '📦 DHL' }, value: 'DHL' },
          { text: { type: 'plain_text', text: '✉️ Correios' }, value: 'Correios' },
          { text: { type: 'plain_text', text: '🛵 Uber Flash' }, value: 'Uber Flash' },
        ]
      }
    });
    base.blocks.push({
      type: 'input',
      block_id: 'b_destinatario',
      label: { type: 'plain_text', text: 'Destinatário' },
      element: {
        type: 'plain_text_input',
        action_id: 'i_destinatario',
        placeholder: { type: 'plain_text', text: 'Nome completo de quem vai receber' }
      }
    });
    base.blocks.push({
      type: 'input',
      block_id: 'b_endereco',
      label: { type: 'plain_text', text: 'Endereço completo' },
      element: {
        type: 'plain_text_input',
        action_id: 'i_endereco',
        multiline: true,
        placeholder: { type: 'plain_text', text: 'Rua, número, bairro, cidade, CEP' }
      }
    });
  }

  if (categoria === 'acessos') {
    base.blocks.push({
      type: 'input',
      block_id: 'b_plataformas',
      label: { type: 'plain_text', text: 'Plataforma(s)' },
      element: {
        type: 'plain_text_input',
        action_id: 'i_plataformas',
        placeholder: { type: 'plain_text', text: 'Ex: Google Workspace, Slack, Pipefy' }
      }
    });
    base.blocks.push({
      type: 'input',
      block_id: 'b_tipoacesso',
      label: { type: 'plain_text', text: 'Tipo de ação' },
      element: {
        type: 'static_select',
        action_id: 'i_tipoacesso',
        options: [
          { text: { type: 'plain_text', text: '➕ Criar/Conceder acesso' }, value: 'criar' },
          { text: { type: 'plain_text', text: '➖ Remover/Revogar acesso' }, value: 'remover' },
          { text: { type: 'plain_text', text: '✏️ Alterar permissão' }, value: 'alterar' },
        ]
      }
    });
  }

  if (categoria === 'manutencao' || categoria === 'reforma') {
    base.blocks.push({
      type: 'input',
      block_id: 'b_localizacao',
      label: { type: 'plain_text', text: 'Localização do problema' },
      element: {
        type: 'plain_text_input',
        action_id: 'i_localizacao',
        placeholder: { type: 'plain_text', text: 'Ex: Sala 3 — 2º andar' }
      }
    });
  }

  // Descrição (todas as categorias)
  base.blocks.push({
    type: 'input',
    block_id: 'b_descricao',
    optional: ['acessos', 'brindes'].includes(categoria),
    label: { type: 'plain_text', text: 'Descrição / detalhes adicionais' },
    element: {
      type: 'plain_text_input',
      action_id: 'i_descricao',
      multiline: true,
      placeholder: { type: 'plain_text', text: 'Detalhes que ajudem o time a entender melhor o pedido' }
    }
  });

  // Prioridade
  base.blocks.push({
    type: 'input',
    block_id: 'b_prioridade',
    label: { type: 'plain_text', text: 'Prioridade' },
    element: {
      type: 'static_select',
      action_id: 'i_prioridade',
      initial_option: { text: { type: 'plain_text', text: '🟡 Média' }, value: 'media' },
      options: PRIORIDADES.map(p => ({
        text: { type: 'plain_text', text: p.label, emoji: true },
        value: p.value,
      }))
    }
  });

  base.blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: '_Você receberá uma DM com o número do chamado após enviar._' }]
  });

  return base;
}

// ============================================================================
// Lookup de usuário e criação de ticket
// ============================================================================

async function getUserInfo(userId) {
  try {
    const r = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` }
    });
    const d = await r.json();
    if (!d.ok) return null;
    const p = d.user?.profile || {};
    const email = p.email || null;
    const result = {
      slackId: userId,
      email,
      nome:  p.real_name || p.display_name || d.user?.name || null,
      centroCusto: null,
      cargo: null,
    };

    // Buscar dados extras (centro de custo, cargo) na coleção colaboradores
    if (email) {
      try {
        const snap = await db.collection('colaboradores')
          .where('email', '==', email).limit(1).get();
        if (!snap.empty) {
          const colab = snap.docs[0].data();
          result.centroCusto = colab.centroCusto || colab.centro_custo || null;
          result.cargo = colab.cargo || null;
          if (colab.nome) result.nome = colab.nome;
        }
      } catch (e) { console.warn('busca colaborador falhou:', e.message); }
    }
    return result;
  } catch { return null; }
}

// Extrai valores do payload de view_submission (estado dos inputs)
function extrairValores(view) {
  const values = view.state?.values || {};
  const get = (bloco, action) => {
    const v = values[bloco]?.[action];
    if (!v) return null;
    if (v.type === 'plain_text_input' || v.type === 'number_input') return v.value;
    if (v.type === 'static_select')       return v.selected_option?.value || null;
    if (v.type === 'multi_static_select') return (v.selected_options || []).map(o => o.value);
    return v.value || null;
  };
  return { get };
}

async function criarTicketNoFirebase(payload) {
  const { categoria, titulo, descricao, prioridade, slackUser, dadosExtras } = payload;
  // Gera ID humanamente legível: LOG-XXXX para logistica, F-XXXX para outros
  const prefix = categoria === 'logistica' ? 'LOG' : 'F';
  const ts = Date.now().toString().slice(-6);
  const id = `${prefix}-${ts}`;

  const docData = {
    id,
    titulo,
    descricao: descricao || '',
    categoria,
    subcategoria: dadosExtras?.subcategoria || (categoria === 'logistica' ? (dadosExtras?.transportadora || null) : null),
    prioridade: prioridade || 'media',
    status: 'Aberto',
    data_abertura: new Date(),
    updatedAt: new Date(),
    origem: 'slack',
    userEmail: slackUser?.email || null,
    nome: slackUser?.nome || null,
    email: slackUser?.email || null,
    centroCusto: slackUser?.centroCusto || null,
    cargo: slackUser?.cargo || null,
    slack_user_id: slackUser?.slackId || null,
    dentroSLA: true,
    historico: [{
      acao: `Chamado aberto via Slack por ${slackUser?.nome || slackUser?.email || 'usuário'}`,
      data: new Date().toISOString(),
      usuario: slackUser?.email || slackUser?.slackId,
    }],
    ...dadosExtras,
  };

  const docRef = await db.collection('tickets').add(docData);
  return { docId: docRef.id, id, ...docData };
}

// ============================================================================
// DMs de notificação após criar
// ============================================================================

async function notificarAdmin(ticket) {
  // Reusa o endpoint existente novo_chamado_admin (sem mudanças)
  try {
    await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://facilities-api.vercel.app'}/api/notify-slack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'novo_chamado_admin',
        ticket: ticket.id,
        ticketId: ticket.id,
        titulo: ticket.titulo,
        categoria: ticket.categoria,
        solicitanteEmail: ticket.email,
        solicitanteNome: ticket.nome,
      })
    });
  } catch (e) { console.error('Erro ao notificar admin:', e.message); }
}

async function dmConfirmacao(slackUserId, ticket) {
  try {
    // Abre DM com o usuário
    const dmRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ users: slackUserId })
    });
    const dm = await dmRes.json();
    if (!dm.ok) return;

    const catLabel = CATEGORIAS.find(c => c.value === ticket.categoria)?.label || ticket.categoria;

    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: dm.channel.id,
        text: `✅ Chamado ${ticket.id} aberto!`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: '✅ Chamado registrado!', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: `Olá! Seu chamado foi registrado com sucesso e já está na fila de atendimento. 📥` } },
          { type: 'divider' },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Chamado:*\n${ticket.id}` },
              { type: 'mrkdwn', text: `*Status:*\n🔵 Aberto` },
              { type: 'mrkdwn', text: `*Categoria:*\n${catLabel}` },
              { type: 'mrkdwn', text: `*Solicitação:*\n${ticket.titulo}` },
            ]
          },
          { type: 'divider' },
          {
            type: 'actions',
            elements: [{
              type: 'button',
              text: { type: 'plain_text', text: '📋 Acompanhar no painel', emoji: true },
              url: 'https://facilities-api.vercel.app/index.html',
              style: 'primary'
            }]
          },
          { type: 'context', elements: [{ type: 'mrkdwn', text: '🏢 *Facilities LogComex* • Você receberá atualizações nesta DM.' }] }
        ]
      })
    });
  } catch (e) { console.error('Erro DM confirmação:', e.message); }
}

// ============================================================================
// HANDLER PRINCIPAL
// ============================================================================

async function publishHome(userId) {
  let chamadosAbertos = [];
  try {
    const snap = await db.collection('tickets')
      .where('slack_user_id', '==', userId)
      .where('status', 'in', ['Aberto', 'Em andamento', 'Aguardando aprovação'])
      .limit(3).get();
    chamadosAbertos = snap.docs.map(d => ({id: d.id, ...d.data()}));
  } catch(e) {}
  const STATUS_EMOJI = {'Aberto':'🔵','Em andamento':'🟠','Aguardando aprovação':'🟣'};
  const chamadosBlocks = chamadosAbertos.length > 0 ? [
    {type:'section', text:{type:'mrkdwn', text:'*Seus chamados em aberto:*'}},
    ...chamadosAbertos.map(c => ({type:'section', text:{type:'mrkdwn', text:`${STATUS_EMOJI[c.status]||'⚪'} *${c.titulo||'Chamado'}*\n_${c.status}_ · ${c.categoria||''}`}})),
    {type:'divider'}
  ] : [];
  const view = {
    type: 'home',
    blocks: [
      {type:'section', text:{type:'mrkdwn', text:'*🏢 Facilities LogComex*\nOlá! Sou seu assistente de facilities. Pode falar comigo naturalmente — me diga o que precisa e eu cuido do resto.'}},
      {type:'divider'},
      ...chamadosBlocks,
      {type:'section', text:{type:'mrkdwn', text:'*⚡ Atalhos rápidos*\nClique para iniciar uma conversa:'}},
      {type:'actions', elements:[
        {type:'button', text:{type:'plain_text', text:'🎁 Pedir brinde', emoji:true}, style:'primary', action_id:'home_brinde', value:'brindes'},
        {type:'button', text:{type:'plain_text', text:'📦 Logística', emoji:true}, action_id:'home_logistica', value:'logistica'},
        {type:'button', text:{type:'plain_text', text:'🔧 Manutenção', emoji:true}, action_id:'home_manutencao', value:'manutencao'},
      ]},
      {type:'actions', elements:[
        {type:'button', text:{type:'plain_text', text:'📎 Suprimentos', emoji:true}, action_id:'home_suprimentos', value:'suprimentos'},
        {type:'button', text:{type:'plain_text', text:'🔑 Acessos', emoji:true}, action_id:'home_acessos', value:'acessos'},
        {type:'button', text:{type:'plain_text', text:'📝 Outro assunto', emoji:true}, action_id:'home_outros', value:'outros'},
      ]},
      {type:'divider'},
      {type:'context', elements:[{type:'mrkdwn', text:'💬 Ou simplesmente me mande uma mensagem direta — eu entendo linguagem natural!'}]}
    ]
  };
  const resp = await fetch('https://slack.com/api/views.publish', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':`Bearer ${SLACK_BOT_TOKEN}`},
    body: JSON.stringify({user_id: userId, view})
  });
  const data = await resp.json();
  if (!data.ok) console.error('views.publish error:', data.error);
  return data.ok;
}

module.exports = async function handler(req, res) {
  // Enviar boas-vindas manualmente (admin only)
  if (req.query?.send_welcome === 'sim_joao') {
    try {
      const userId = 'U09MEN4BS0N'; // Slack ID do Joao
      await db.collection('slack_home_welcomed').doc(userId).delete();
      const dmResp = await fetch('https://slack.com/api/conversations.open', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
        body: JSON.stringify({ users: userId })
      });
      const dmData = await dmResp.json();
      if (!dmData.ok) return res.status(200).json({ erro: 'conversations.open falhou', detalhe: dmData });
      const channel = dmData.channel?.id;
      const msgResp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
        body: JSON.stringify({
          channel,
          text: 'Olá! Sou o assistente de Facilities da LogComex 👋',
          blocks: [
            { type: 'section', text: { type: 'mrkdwn', text: "*Olá! Sou o assistente de Facilities da LogComex* 👋\n\nPode falar comigo naturalmente — me diz o que você precisa e eu cuido do resto!\n\nOu escolha uma categoria pra começar:" } },
            { type: 'actions', elements: [
              { type: 'button', text: { type: 'plain_text', text: '🎁 Pedir brinde', emoji: true }, style: 'primary', action_id: 'bv_brinde', value: 'brindes' },
              { type: 'button', text: { type: 'plain_text', text: '📦 Logística', emoji: true }, action_id: 'bv_logistica', value: 'logistica' },
              { type: 'button', text: { type: 'plain_text', text: '🔧 Manutenção', emoji: true }, action_id: 'bv_manutencao', value: 'manutencao' },
            ]},
            { type: 'actions', elements: [
              { type: 'button', text: { type: 'plain_text', text: '📎 Suprimentos', emoji: true }, action_id: 'bv_suprimentos', value: 'suprimentos' },
              { type: 'button', text: { type: 'plain_text', text: '🔑 Acessos', emoji: true }, action_id: 'bv_acessos', value: 'acessos' },
              { type: 'button', text: { type: 'plain_text', text: '📝 Outro assunto', emoji: true }, action_id: 'bv_outros', value: 'outros' },
            ]}
          ]
        })
      });
      const msgData = await msgResp.json();
      await db.collection('slack_home_welcomed').doc(userId).set({ at: new Date() });
      return res.status(200).json({ ok: msgData.ok, channel, erro: msgData.error || null });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  // Reset flag boas-vindas (admin only)
  if (req.query?.reset_welcome === 'sim_joao') {
    try {
      const snap = await db.collection('slack_home_welcomed').get();
      const batch = db.batch();
      snap.docs.forEach(d => batch.delete(d.ref));
      await batch.commit();
      return res.status(200).json({ ok: true, deleted: snap.size });
    } catch(e) { return res.status(500).json({ error: e.message }); }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  // Captura o corpo bruto pra verificação de assinatura
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const rawBody = Buffer.concat(chunks).toString('utf8');

  // Verificar assinatura do Slack (opcional — se SLACK_SIGNING_SECRET configurado)
  if (process.env.SLACK_SIGNING_SECRET && !verificarAssinatura(req, rawBody)) {
    console.warn('⚠️ Assinatura inválida do Slack');
    return res.status(401).send('Invalid signature');
  }

  // Parser do body — pode ser JSON puro (Events API) ou x-www-form-urlencoded (interactivity/commands)
  let body = {};
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  try {
    if (contentType.includes('application/json')) {
      // Events API manda JSON puro
      body = JSON.parse(rawBody);
    } else {
      // Slash commands e interactivity vêm como form-urlencoded
      const params = {};
      rawBody.split('&').forEach(pair => {
        const [k, v] = pair.split('=');
        if (k) params[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent((v || '').replace(/\+/g, ' '));
      });
      if (params.payload) {
        try { body = JSON.parse(params.payload); } catch { body = params; }
      } else {
        body = params;
      }
    }
  } catch (e) {
    // Fallback: tenta JSON
    try { body = JSON.parse(rawBody); } catch { body = {}; }
  }

  // ⚡ url_verification deve ser respondido IMEDIATAMENTE, antes de qualquer outra lógica
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // ============================================================
  // ROTA 1: Slash command /facilities
  // ============================================================
  if (body.command === '/facilities') {
    const triggerId = body.trigger_id;
    const userId = body.user_id;
    try {
      const r = await fetch('https://slack.com/api/views.open', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger_id: triggerId,
          view: modalEscolherCategoria(JSON.stringify({ user_id: userId })),
        })
      });
      const d = await r.json();
      if (!d.ok) console.error('Erro abrir modal:', d.error);
      return res.status(200).send(''); // ack vazio (Slack já mostrou o modal)
    } catch (e) {
      console.error(e);
      return res.status(200).send('Erro ao abrir formulário.');
    }
  }

  // ============================================================
  // ROTA 2: Shortcut (atalho do Slack — ⚡)
  // ============================================================
  if (body.type === 'shortcut' && body.callback_id === 'abrir_chamado_facilities') {
    const triggerId = body.trigger_id;
    const userId = body.user?.id;
    try {
      await fetch('https://slack.com/api/views.open', {
        method: 'POST',
        headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger_id: triggerId,
          view: modalEscolherCategoria(JSON.stringify({ user_id: userId })),
        })
      });
      return res.status(200).send('');
    } catch (e) {
      console.error(e);
      return res.status(200).send('');
    }
  }

  // ============================================================
  // ROTA 3: view_submission do modal #1 (escolher categoria)
  //         → atualiza para modal #2 com campos da categoria
  // ============================================================
  if (body.type === 'view_submission' && body.view?.callback_id === 'modal_escolher_categoria') {
    const meta = JSON.parse(body.view.private_metadata || '{}');
    const categoria = body.view.state?.values?.b_categoria?.i_categoria?.selected_option?.value;
    if (!categoria) {
      return res.status(200).json({
        response_action: 'errors',
        errors: { b_categoria: 'Escolha uma categoria.' }
      });
    }
    return res.status(200).json({
      response_action: 'update',
      view: modalCamposPorCategoria(categoria, meta),
    });
  }

  // ============================================================
  // ROTA 4: view_submission do modal #2 (criar ticket)
  // ============================================================
  if (body.type === 'view_submission' && body.view?.callback_id === 'modal_criar_ticket') {
    const meta = JSON.parse(body.view.private_metadata || '{}');
    const { categoria } = meta;
    const userId = body.user?.id || meta.user_id;
    const { get } = extrairValores(body.view);

    // Validação mínima
    const titulo = get('b_titulo', 'i_titulo');
    if (!titulo || titulo.trim().length < 3) {
      return res.status(200).json({
        response_action: 'errors',
        errors: { b_titulo: 'Descreva sua solicitação com pelo menos 3 caracteres.' }
      });
    }

    // Ack imediato (Slack exige <3s) — processa o resto em background
    res.status(200).send('');

    // ── Em background: criar ticket + notificar ──
    try {
      const slackUser = await getUserInfo(userId);
      const descricao  = get('b_descricao', 'i_descricao') || '';
      const prioridade = get('b_prioridade', 'i_prioridade') || 'media';

      const dadosExtras = {};

      if (categoria === 'brindes') {
        const itens     = get('b_itens', 'i_itens') || [];
        const quantidade = parseInt(get('b_quantidade', 'i_quantidade') || '1', 10);
        const entrega   = get('b_entrega', 'i_entrega');
        dadosExtras.itens_brinde = itens.join(', ');
        dadosExtras.quantidade   = quantidade;
        dadosExtras.tipo_entrega = entrega === 'envio' ? 'Envio para endereço' : 'Retirar na sede';
        // Brinde precisa aprovação do gestor
        dadosExtras.status = 'Aguardando aprovação';
      }
      if (categoria === 'logistica') {
        dadosExtras.transportadora = get('b_transportadora', 'i_transportadora');
        dadosExtras.destinatario   = get('b_destinatario', 'i_destinatario');
        dadosExtras.endereco_envio = get('b_endereco', 'i_endereco');
      }
      if (categoria === 'acessos') {
        dadosExtras.plataformas = get('b_plataformas', 'i_plataformas');
        dadosExtras.tipo_acesso = get('b_tipoacesso', 'i_tipoacesso');
      }
      if (categoria === 'manutencao' || categoria === 'reforma') {
        dadosExtras.localizacao = get('b_localizacao', 'i_localizacao');
      }

      const ticket = await criarTicketNoFirebase({
        categoria, titulo, descricao, prioridade,
        slackUser: slackUser || { slackId: userId },
        dadosExtras,
      });

      // Notificar admin (DM)
      await notificarAdmin(ticket);

      // DM de confirmação para quem abriu
      await dmConfirmacao(userId, ticket);

      // Se for brindes E o solicitante for de CS, dispara fluxo Leandro (aprovação)
      // Brindes de Comercial/outros vão direto pra Facilities sem passar pelo Leandro
      if (categoria === 'brindes') {
        const ehCS = isCentroCustoCS(ticket.centroCusto || slackUser?.centroCusto);
        if (ehCS) {
          try {
            await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://facilities-api.vercel.app'}/api/notify-slack`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                tipo: 'novo_brinde_gestor',
                ticket: ticket.id,
                titulo: ticket.titulo,
                docId: ticket.docId,
                emailColaborador: ticket.email,
                nomeColaborador: ticket.nome,
                itensBrinde: ticket.itens_brinde,
                email: ticket.email,
                nome: ticket.nome,
              })
            });
          } catch (e) { console.error('Erro notificar Leandro:', e.message); }
        } else {
          console.log(`Brinde de não-CS (${ticket.centroCusto}) — pulando aprovação do Leandro`);
        }
      }

      console.log(`✅ Ticket Slack criado: ${ticket.id} (${categoria}) por ${slackUser?.email || userId}`);
    } catch (err) {
      console.error('Erro ao criar ticket via Slack:', err);
    }
    return; // res.send já foi feito
  }

  // ============================================================
  // ROTA 5: block_actions (cliques em botões)
  //         - Aprovação/recusa de brinde → repassa pra /api/brinde-aprovacao
  //         - Botões do fluxo conversacional → trata aqui
  // ============================================================
  if (body.type === 'block_actions') {
    const action = body.actions?.[0] || {};
    const actionId = action.action_id || '';

    // Aprovação/recusa de brinde — repassa pro endpoint legacy
    if (actionId === 'aprovar_brinde' || actionId === 'recusar_brinde' || actionId.startsWith('aprovar_') || actionId.startsWith('recusar_')) {
      try {
        const baseUrl = 'https://facilities-api.vercel.app';
        await fetch(`${baseUrl}/api/brinde-aprovacao`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: rawBody,
        });
      } catch (e) {
        console.error('Erro repassando p/ brinde-aprovacao:', e.message);
      }
      return res.status(200).send('');
    }

    // ── Botões do fluxo conversacional (Slack DM via IA) ──
    if (actionId === 'fac_confirmar' || actionId === 'fac_editar' || actionId === 'fac_cancelar' ||
        actionId === 'fac_categoria' || actionId.startsWith('fac_')) {
      // Processa SÍNCRONO (Vercel mata função após res.send)
      try {
        await tratarBotaoFluxoConversacional(body, action);
      } catch (err) {
        console.error('Erro botão fluxo:', err);
      }
      return res.status(200).send('');
    }

    return res.status(200).send('');
  }

  // ============================================================
  // ROTA 6: URL verification (Slack pede challenge ao configurar Events API)
  // ============================================================
  if (body.type === 'url_verification') {
    return res.status(200).json({ challenge: body.challenge });
  }

  // ============================================================
  // ROTA 7b: app_home_opened → publicar Home Tab + boas-vindas no chat
  if (body.type === 'event_callback' && body.event?.type === 'app_home_opened') {
    const userId = body.event.user;
    res.status(200).send('');
    try {
      await publishHome(userId);
      // Boas-vindas no chat apenas na primeira vez
      const flagRef = db.collection('slack_home_welcomed').doc(userId);
      const flag = await flagRef.get();
      if (!flag.exists) {
        await flagRef.set({ at: new Date() });
        // Abrir DM
        const dmResp = await fetch('https://slack.com/api/conversations.open', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
          body: JSON.stringify({ users: userId })
        });
        const channel = (await dmResp.json()).channel?.id;
        if (channel) {
          await fetch('https://slack.com/api/chat.postMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SLACK_BOT_TOKEN}` },
            body: JSON.stringify({
              channel,
              text: 'Olá! Sou o assistente de Facilities da LogComex 👋',
              blocks: [
                {
                  type: 'section',
                  text: { type: "mrkdwn", text: "*Olá! Sou o assistente de Facilities da LogComex* 👋\n\nPode falar comigo naturalmente — me diz o que você precisa e eu cuido do resto!\n\nOu escolha uma categoria pra começar:" }
                },
                {
                  type: 'actions',
                  elements: [
                    { type: 'button', text: { type: 'plain_text', text: '🎁 Pedir brinde', emoji: true }, style: 'primary', action_id: 'bv_brinde', value: 'brindes' },
                    { type: 'button', text: { type: 'plain_text', text: '📦 Logística', emoji: true }, action_id: 'bv_logistica', value: 'logistica' },
                    { type: 'button', text: { type: 'plain_text', text: '🔧 Manutenção', emoji: true }, action_id: 'bv_manutencao', value: 'manutencao' },
                  ]
                },
                {
                  type: 'actions',
                  elements: [
                    { type: 'button', text: { type: 'plain_text', text: '📎 Suprimentos', emoji: true }, action_id: 'bv_suprimentos', value: 'suprimentos' },
                    { type: 'button', text: { type: 'plain_text', text: '🔑 Acessos', emoji: true }, action_id: 'bv_acessos', value: 'acessos' },
                    { type: 'button', text: { type: 'plain_text', text: '📝 Outro assunto', emoji: true }, action_id: 'bv_outros', value: 'outros' },
                  ]
                }
              ]
            })
          });
        }
      }
    } catch(e) { console.error('home tab:', e.message); }
    return;
  }

  // ROTA 7b1: confirmação de chamado
  if (body.type === 'block_actions') {
    const actionId = body.actions?.[0]?.action_id;
    const userId2 = body.user?.id || body.message?.bot_id;
    const channel2 = body.channel?.id;

    if (actionId === 'confirmar_chamado') {
      res.status(200).send('');
      try {
        const estado2 = await getEstado(userId2);
        if (!estado2 || estado2.etapa !== 'aguardando_confirmacao') {
          await enviarMensagem(channel2, 'Não encontrei o chamado pendente. Tente novamente.');
          return;
        }
        await limparEstado(userId2);
        // Buscar dados do colaborador
        const colabSnap = await db.collection('colaboradores').where('email', '==', body.user?.name ? body.user.name + '@logcomex.com' : '').limit(1).get();
        const colab = colabSnap.docs[0]?.data() || {};
        const ticket = await criarTicketNoFirebase({
          categoria: estado2.categoria,
          titulo: estado2.titulo || estado2.texto_original,
          descricao: estado2.descricao || estado2.texto_original,
          prioridade: estado2.prioridade || 'media',
          nome: colab.nome || body.user?.name || 'Colaborador',
          email: colab.email || '',
          centroCusto: colab.centroCusto || '',
          slack_user_id: userId2,
          origem: 'slack',
        });
        await enviarMensagem(channel2, `✅ Chamado aberto!`, [
          { type: 'section', text: { type: 'mrkdwn', text: `✅ *Chamado aberto com sucesso!*

*Protocolo:* #${ticket.id}
*Título:* ${estado2.titulo || estado2.texto_original}

Você receberá atualizações por aqui. Qualquer dúvida é só chamar! 👍` } }
        ]);
      } catch(e) { console.error('confirmar_chamado:', e.message); await enviarMensagem(channel2, 'Erro ao abrir chamado: ' + e.message); }
      return;
    }

    if (actionId === 'editar_chamado') {
      res.status(200).send('');
      await limparEstado(body.user?.id);
      await enviarMensagem(channel2, 'Tudo bem! Me conta de novo o que você precisa e eu refaço o chamado. 😊');
      return;
    }

    if (actionId === 'cancelar_chamado') {
      res.status(200).send('');
      await limparEstado(body.user?.id);
      await enviarMensagem(channel2, 'Cancelado! Se precisar de algo é só falar. 👋');
      return;
    }
  }

  // ROTA 7b2: block_actions — botões de atalho (Home Tab + boas-vindas)
  if (body.type === 'block_actions' && (body.view?.type === 'home' || ['bv_brinde','bv_logistica','bv_manutencao','bv_suprimentos','bv_acessos','bv_outros','home_brinde','home_logistica','home_manutencao','home_suprimentos','home_acessos','home_outros'].includes(body.actions?.[0]?.action_id))) {
    const userId = body.user?.id;
    const categoria = body.actions?.[0]?.value;
    res.status(200).send('');
    if (!userId || !categoria) return;
    const LABELS = {brindes:'🎁 Brindes',logistica:'📦 Logística',manutencao:'🔧 Manutenção',suprimentos:'📎 Suprimentos',acessos:'🔑 Acessos',outros:'📝 Outros'};
    try {
      const dmResp = await fetch('https://slack.com/api/conversations.open', {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${SLACK_BOT_TOKEN}`},
        body: JSON.stringify({users: userId})
      });
      const channel = (await dmResp.json()).channel?.id;
      if (!channel) return;
      await db.collection('slack_conversas').doc(userId).set({etapa:'aguardando_descricao',categoria,updatedAt:new Date()});
      await fetch('https://slack.com/api/chat.postMessage', {
        method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${SLACK_BOT_TOKEN}`},
        body: JSON.stringify({channel, text:`Ótimo! Você escolheu *${LABELS[categoria]||categoria}*. Me conta com mais detalhes o que você precisa — pode falar à vontade! 😊`})
      });
    } catch(e) { console.error('home action:', e.message); }
    return;
  }

  // ROTA 7: event_callback → mensagens recebidas em DM
  // ============================================================
  if (body.type === 'event_callback' && body.event) {
    const evt = body.event;
    const eventId = body.event_id;

    // Filtros básicos
    if (evt.type !== 'message') return res.status(200).send('');
    if (evt.bot_id || evt.subtype === 'bot_message' || evt.subtype === 'message_changed' || evt.subtype === 'message_deleted') {
      return res.status(200).send('');
    }
    if (evt.channel_type !== 'im') return res.status(200).send('');
    if (!evt.text || !evt.user || !evt.channel) return res.status(200).send('');

    // Dedup (Slack pode retentar se demorar >3s)
    if (eventId) {
      try {
        const dedupeDoc = db.collection('slack_eventos_processados').doc(eventId);
        const exists = await dedupeDoc.get();
        if (exists.exists) return res.status(200).send('');
        await dedupeDoc.set({ at: new Date(), user: evt.user });
      } catch (e) { console.warn('dedup:', e.message); }
    }

    // Processa SÍNCRONO (Vercel mata a função após res.send, então precisa ser antes)
    // Slack pode dar timeout >3s mas o dedup impede reprocessamento
    try {
      await processarMensagemDM(evt);
    } catch (err) {
      console.error('Erro processando DM:', err.message);
    }
    return res.status(200).send('');
  }

  // ============================================================
  // ROTA 8: block_actions de botões do fluxo conversacional (não-brinde)
  // (a ROTA 5 acima já trata aprovação de brinde — esta trata outros botões)
  // ============================================================
  // Tratada acima na ROTA 5 (block_actions). Outros action_ids são processados lá.

  // ============================================================
  // Fallback: nada reconhecido
  // ============================================================
  console.warn('Payload Slack não reconhecido:', body.type || body.command || 'unknown');
  return res.status(200).send('');
};

// Importante: desabilitar body parser do Vercel pra termos acesso ao raw
module.exports.config = {
  api: { bodyParser: false }
};

// ============================================================================
// FLUXO CONVERSACIONAL VIA DM
// ============================================================================

// Estado da conversação armazenado no Firestore (uma doc por usuário Slack)
async function getEstado(slackUserId) {
  const doc = await db.collection('slack_conversas').doc(slackUserId).get();
  return doc.exists ? doc.data() : null;
}
async function setEstado(slackUserId, dados) {
  await db.collection('slack_conversas').doc(slackUserId).set({
    ...dados,
    updatedAt: new Date(),
  }, { merge: true });
}
async function limparEstado(slackUserId) {
  await db.collection('slack_conversas').doc(slackUserId).delete().catch(() => {});
}

// Análise da mensagem via Claude Haiku
async function analisarMensagem(texto, estadoAnterior = null) {
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_KEY) {
    // Fallback sem IA: detecta por palavras-chave simples
    return analisarPorPalavrasChave(texto);
  }

  const systemPrompt = `Você é o assistente de Facilities da LogComex. Converse de forma natural e amigável — como um colega prestativo, não um sistema robótico.

PERSONALIDADE: Respostas curtas (1-3 frases), use emojis com moderação, seja direto e adapte o tom da pessoa. NUNCA liste exemplos ou instruções.

SEU OBJETIVO: Ajudar a pessoa a abrir um chamado de facilities de forma conversacional.

FLUXO:
1. Saudação simples ("oi", "olá") → responda amigável e pergunte como pode ajudar
2. Problema/necessidade clara → entenda, confirme em uma frase, pergunte se quer abrir o chamado
3. Dúvida sobre o que precisa → faça UMA pergunta objetiva
4. Confirmação → pronto_para_abrir: true

CATEGORIAS (use internamente, não mencione):
suprimentos, manutencao, reforma, acessos, brindes, logistica, outros

RESPONDA SEMPRE COM JSON:
{
  "resposta_usuario": "mensagem natural e curta pra pessoa",
  "pronto_para_abrir": true ou false,
  "categoria": "categoria ou null",
  "titulo": "titulo curto se pronto_para_abrir=true, senao null",
  "descricao": "descricao se pronto_para_abrir=true, senao null",
  "prioridade": "baixa/media/alta",
  "saudacao_apenas": true ou false
}`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemPrompt,
        messages: (() => {
          const msgs = [];
          // Adicionar histórico de conversa se existir
          if (estadoAnterior?.historico_chat) {
            estadoAnterior.historico_chat.slice(-6).forEach(h => {
              msgs.push({ role: h.role, content: h.content });
            });
          } else if (estadoAnterior) {
            msgs.push({ role: 'user', content: `Contexto anterior: categoria=${estadoAnterior.categoria || ''}, titulo=${estadoAnterior.titulo || ''}, descricao=${estadoAnterior.descricao || ''}` });
            msgs.push({ role: 'assistant', content: '{"resposta_usuario":"Entendido, pode continuar.","pronto_para_abrir":false,"saudacao_apenas":false}' });
          }
          msgs.push({ role: 'user', content: `Mensagem do colaborador: "${texto}"` });
          return msgs;
        })()
      })
    });
    const data = await r.json();
    const content = data?.content?.[0]?.text || '{}';
    // Extrai JSON do meio do texto (caso a IA decore com markdown)
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]);
    }
    return analisarPorPalavrasChave(texto);
  } catch (e) {
    console.error('Erro chamando Claude Haiku:', e.message);
    return analisarPorPalavrasChave(texto);
  }
}

// Fallback simples sem IA
function analisarPorPalavrasChave(texto) {
  const t = texto.toLowerCase();
  const isSaudacao = /^(oi+|oii+|ola+|ol[áa]+|bom dia|boa tarde|boa noite|e a[ií]+|eai+|hey|hi|hello|alo|al[ôo]+|menu|ajuda|help|começar|comecar|start|teste)\s*[!.?,]*\s*$/i.test(t.trim());
  if (isSaudacao) return { saudacao_apenas: true, tem_info_suficiente: false };

  let categoria = 'outros';
  if (/mouse|teclado|caneta(?!.*brinde)|papel|grampeador|clipe|post.?it|cartucho|toner|impressora|fone|headset|suporte|monitor/i.test(t)) categoria = 'suprimentos';
  else if (/ar.?condicionado|lampada|lâmpada|vazamento|conserto|quebr|reparo|manuten|porta|fechadura|mesa|cadeira|infiltra/i.test(t)) categoria = 'manutencao';
  else if (/reforma|pintura|layout|estrutura/i.test(t)) categoria = 'reforma';
  else if (/acesso|permiss|liberar|google|slack|pipefy|workspace|vpn|email|senha|conta/i.test(t)) categoria = 'acessos';
  else if (/moleskine|garrafa|brinde|container|sacola|copo egg|tapa câmera|tapa camera|caneta brinde/i.test(t)) categoria = 'brindes';
  else if (/dhl|correio|envio|enviar|pacote|encomenda|uber flash|motoboy/i.test(t)) categoria = 'logistica';

  let prioridade = 'media';
  if (/urgent|hoje|agora|imediat|emergen|parou|quebrou|nao consigo|não consigo/i.test(t)) prioridade = 'alta';
  if (/quando puder|sem pressa|tranquil/i.test(t)) prioridade = 'baixa';

  return {
    categoria,
    titulo: texto.length > 80 ? texto.substring(0, 77) + '...' : texto,
    descricao: texto,
    prioridade,
    tem_info_suficiente: true,
    pergunta_adicional: null,
    saudacao_apenas: false,
  };
}

// Processa mensagem em DM recebida
async function processarMensagemDM(evt) {
  const userId = evt.user;
  const channel = evt.channel;
  const texto = (evt.text || '').trim();
  const textoLower = texto.toLowerCase();

  const log = async (etapa, extra = {}) => {
    try {
      await db.collection('slack_debug_logs').add({
        at: new Date(), user: userId, texto: texto.substring(0, 80), etapa, ...extra,
      });
    } catch {}
  };

  await log('inicio');
  console.log('[processarMensagemDM] início | user:', userId, '| channel:', channel, '| texto:', texto.substring(0, 50));

  try {
    // Comandos especiais
    if (/^(cancelar|cancel|sair|reset)$/i.test(texto)) {
      await log('cancelar');
      await limparEstado(userId);
      await enviarMensagem(channel, '✅ Conversa reiniciada. Pode mandar uma nova solicitação quando quiser! 👋');
      return;
    }

    // ⚡ DETECÇÃO RÁPIDA DE SAUDAÇÃO (sem IA, sem Firebase)
    // Responde imediato — não depende de quota nem de timeout
    const padraoSaudacao = /^(oi+|oii+|ola+|ol[áa]+|hey|hi|hello|alo|al[ôo]+|bom dia|boa tarde|boa noite|e a[ií]+|eai+|menu|ajuda|help|começar|comecar|start|teste)[\s!.?,]*$/i;
    if (padraoSaudacao.test(texto)) {
      await log('saudacao_direta');
      console.log('[processarMensagemDM] detectada saudação direta');
      await enviarMensagem(channel, '👋 Olá! Sou o assistente do time de Facilities.', [
        { type: 'header', text: { type: 'plain_text', text: '👋 Olá!', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `Sou o assistente do time de *Facilities da LogComex*. Posso te ajudar a abrir um chamado rapidinho! 🎯` } },
        { type: 'section', text: { type: 'mrkdwn', text: `*Como funciona:*\nMe conta o que você precisa em uma mensagem normal. Vou entender, organizar e abrir o chamado pra você.\n\n*Exemplos:*\n• _"Preciso de um mouse novo"_\n• _"Ar condicionado da sala 3 com problema"_\n• _"Quero pedir alguns moleskines pra equipe"_\n• _"Envio via DHL para São Paulo"_` } },
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '💡 Você também pode usar o formulário: <https://facilities-api.vercel.app|facilities-api.vercel.app>' }] }
      ]);
      await log('saudacao_enviada');
      console.log('[processarMensagemDM] saudação enviada ✅');
      return;
    }

    // Pega estado anterior (conversa em andamento)
    let estado = null;
    try {
      estado = await getEstado(userId);
      await log('estado_lido', { tem_estado: !!estado, etapa: estado?.etapa });
    } catch (e) {
      await log('estado_erro', { err: e.message });
    }

    // Analisar a mensagem com IA (com timeout de 5s)
    console.log('[processarMensagemDM] chamando IA...');
    await log('antes_IA');
    const analise = await Promise.race([
      analisarMensagem(texto, estado),
      new Promise((resolve) => setTimeout(() => {
        console.warn('[processarMensagemDM] IA timeout — usando fallback');
        resolve(analisarPorPalavrasChave(texto));
      }, 5000))
    ]);
    await log('depois_IA', { categoria: analise?.categoria, titulo: (analise?.titulo || '').substring(0, 40), suficiente: analise?.tem_info_suficiente });
    console.log('[processarMensagemDM] análise:', JSON.stringify(analise).substring(0, 200));

    // Caso 1: IA tem resposta conversacional e ainda não está pronto pra abrir
    if (analise.resposta_usuario && !analise.pronto_para_abrir) {
      await log('conversa_natural');
      try {
        const historicoAtual = estado?.historico_chat || [];
      const novoHistorico = [
        ...historicoAtual.slice(-8),
        { role: 'user', content: `Mensagem do colaborador: "${texto}"` },
        { role: 'assistant', content: JSON.stringify({ resposta_usuario: analise.resposta_usuario, pronto_para_abrir: false }) }
      ];
      await setEstado(userId, {
          etapa: 'aguardando_resposta',
          categoria: analise.categoria,
          titulo: analise.titulo,
          descricao: analise.descricao,
          prioridade: analise.prioridade,
          texto_original: texto,
          saudacao: analise.saudacao_apenas,
          historico_chat: novoHistorico,
        });
      } catch (e) { console.warn('setEstado fail:', e.message); }
      await enviarMensagem(channel, analise.resposta_usuario);
      return;
    }

    // Marcar como pronto pra abrir se IA sinalizou
    if (analise.pronto_para_abrir) {
      analise.tem_info_suficiente = true;
      analise.pergunta_adicional = null;
    }

    // Caso 2: Saudação sem resposta_usuario (fallback)
    if (analise.saudacao_apenas && !analise.resposta_usuario) {
      await enviarMensagem(channel, 'Oi! 👋 Como posso te ajudar hoje?');
      return;
    }

    // Caso 3: pronto_para_abrir → mostrar confirmação antes de criar
    if (analise.pronto_para_abrir) {
      await log('aguardando_confirmacao');
      const CATLABELS_BOT = {suprimentos:'📎 Suprimentos',manutencao:'🔧 Manutenção',reforma:'🏗️ Reforma',acessos:'🔑 Acessos',brindes:'🎁 Brindes',logistica:'📦 Logística',outros:'📝 Outros'};
      const PRIOLABELS = {baixa:'🟢 Baixa',media:'🟡 Média',alta:'🔴 Alta'};
      await setEstado(userId, {
        etapa: 'aguardando_confirmacao',
        categoria: analise.categoria,
        titulo: analise.titulo,
        descricao: analise.descricao,
        prioridade: analise.prioridade,
        texto_original: texto,
      });
      await enviarMensagem(channel, analise.resposta_usuario || 'Vou abrir o chamado:', [
        { type: 'section', text: { type: 'mrkdwn', text: `${analise.resposta_usuario || 'Resumo do chamado:'}

*Categoria:* ${CATLABELS_BOT[analise.categoria] || analise.categoria}
*Título:* ${analise.titulo || texto}
*Prioridade:* ${PRIOLABELS[analise.prioridade] || analise.prioridade}` } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: '✅ Confirmar', emoji: true }, style: 'primary', action_id: 'confirmar_chamado', value: 'confirmar' },
          { type: 'button', text: { type: 'plain_text', text: '✏️ Editar', emoji: true }, action_id: 'editar_chamado', value: 'editar' },
          { type: 'button', text: { type: 'plain_text', text: '❌ Cancelar', emoji: true }, style: 'danger', action_id: 'cancelar_chamado', value: 'cancelar' },
        ]}
      ]);
      return;
    }

    // Caso 3: Tem info suficiente → segue pro sub-fluxo da categoria
    await log('subfluxo_inicio', { cat: analise.categoria });
    const dados = {
      categoria: analise.categoria,
      titulo: analise.titulo,
      descricao: analise.descricao,
      prioridade: analise.prioridade,
      texto_original: estado?.texto_original ? `${estado.texto_original}\n\n${texto}` : texto,
    };

    // ════════════════════════════════════════════════════
    //  SUB-FLUXOS POR CATEGORIA — coletam detalhes extras
    // ════════════════════════════════════════════════════
    // Para cada categoria, fazemos perguntas específicas que coletam
    // todas as informações que o time precisa pra resolver o chamado.
    // Tudo é preservado no estado entre mensagens.

    const cat = analise.categoria;

    // Preservar dados já coletados em interações anteriores
    if (estado?.item_brinde) dados.item_brinde = estado.item_brinde;
    if (estado?.quantidade) dados.quantidade = estado.quantidade;
    if (estado?.brindes_solicitados) dados.brindes_solicitados = estado.brindes_solicitados;
    if (estado?.transportadora) dados.transportadora = estado.transportadora;
    if (estado?.destinatario_envio) dados.destinatario_envio = estado.destinatario_envio;
    if (estado?.detalhes_extras) dados.detalhes_extras = estado.detalhes_extras;

    // Helper: pergunta livre por detalhes específicos da categoria
    // Valida se o texto tem informação suficiente pra ser útil
    // Retorna { valido: bool, motivo: string }
    function validarQualidadeDetalhes(txt, categoria) {
      const t = (txt || '').trim();
      const tLow = t.toLowerCase();

      // Muito curto?
      if (t.length < 25) {
        return { valido: false, motivo: 'curto' };
      }

      // Palavras muito vagas que indicam pedido ruim
      const padroesVagos = [
        /^(uma|um) coisa\b/i,
        /^(uma|um) negocio\b/i,
        /^(uma|um) negócio\b/i,
        /^t[áa] quebrad[oa]\b/i,
        /^n[aã]o (est[aá]|ta) funcionando\b/i,
        /^problema\b/i,
        /^d[aá] um jeito\b/i,
        /^preciso de (uma|um|algo)\b/i,
        /^queria (uma|um|algo)\b/i,
      ];
      const muitoVago = padroesVagos.some(rx => rx.test(t)) && t.length < 60;
      if (muitoVago) {
        return { valido: false, motivo: 'vago' };
      }

      // Validações específicas por categoria
      if (categoria === 'manutencao') {
        // Precisa mencionar algum local OU objeto
        const temLocal = /\b(sala|andar|sede|piso|cozinha|banheiro|escrit[oó]rio|mesa|baia|recep[cç][aã]o|coworking|copa)\b/i.test(tLow);
        const temObjeto = /\b(ar[\s-]?condicionado|l[aâ]mpada|porta|fechadura|tomada|janela|mesa|cadeira|bebedouro|telefone|computador|teto|piso|parede|torneira|pia|vazamento|chuveiro|geladeira|micro-?ondas|cafeteira|caixa|som|proj?etor)\b/i.test(tLow);
        if (!temLocal && !temObjeto) {
          return { valido: false, motivo: 'sem_local_ou_objeto' };
        }
      }

      if (categoria === 'suprimentos') {
        // Precisa mencionar algum item específico (não só "preciso de material")
        const itensComuns = /\b(mouse|teclado|fone|headset|microfone|webcam|cabo|adaptador|caneta|papel|caderno|folha|grampeador|clipe|cl[ií]pe|cart[uú]lina|envelope|grampe|hub|usb|hdmi|monitor|carregador|bateria|pilha|tinta|cartucho|toner|pasta|fichario|capa|mochila|copo|x[íi]cara|caf[ée]|a[cç][uú]car|filtro)\b/i;
        if (!itensComuns.test(tLow)) {
          return { valido: false, motivo: 'sem_item_especifico' };
        }
      }

      return { valido: true };
    }

    // Texto da mensagem quando o pedido é vago (por categoria)
    function mensagemPedidoVago(categoria, motivo) {
      const bases = {
        manutencao: {
          header: '⚠️ Preciso de mais detalhes',
          intro: 'Pra a equipe resolver mais rápido, me passa:\n\n• *Local exato* (sede, andar, sala, posição)\n• *O que está com problema* (ex: ar-condicionado, lâmpada, porta, mesa)\n• *Descrição do problema* (não liga, vazando, com barulho, quebrado)',
          exemplos: 'Exemplos do que eu aceito:\n• _"O ar-condicionado da sala 3 do 2º andar não está gelando"_\n• _"Lâmpada da copa queimada, está escuro"_\n• _"Tomada da minha mesa (baia 12) faiscou, não funciona"_'
        },
        suprimentos: {
          header: '⚠️ Preciso de mais detalhes',
          intro: 'Pra agilizar a compra, me passa:\n\n• *Item específico* (ex: mouse sem fio, fone com microfone)\n• *Modelo/marca* preferida (se tiver)\n• *Quantidade* que precisa\n• *Link* do produto (opcional)',
          exemplos: 'Exemplos do que eu aceito:\n• _"Preciso de 1 mouse sem fio Logitech M170"_\n• _"2 fones de ouvido com microfone para call center"_\n• _"Carregador USB-C 65W, link: amzn.to/xxx"_'
        }
      };
      const m = bases[categoria];
      if (!m) return null;
      return [
        { type: 'header', text: { type: 'plain_text', text: m.header, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: m.intro } },
        { type: 'section', text: { type: 'mrkdwn', text: m.exemplos } },
        { type: 'section', text: { type: 'mrkdwn', text: '_Me manda de novo com essas informações, por favor._ 🙏' } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Digite "cancelar" para reiniciar.' }] }
      ];
    }

    async function pedirDetalhes(etapaName, header, instrucao) {
      // Se já está aguardando esses detalhes, valida a resposta
      if (estado?.etapa === etapaName) {
        const validacao = validarQualidadeDetalhes(texto, cat);
        if (!validacao.valido) {
          // Resposta vaga — re-pergunta com aviso mais claro
          await log(`${cat}_resposta_vaga`, { motivo: validacao.motivo });
          await setEstado(userId, { etapa: etapaName, ...dados });
          const blocosErro = mensagemPedidoVago(cat, validacao.motivo);
          if (blocosErro) {
            await enviarMensagem(channel, '⚠️ Preciso de mais detalhes', blocosErro);
          } else {
            // Fallback: re-pergunta original
            await enviarMensagem(channel, header, [
              { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
              { type: 'section', text: { type: 'mrkdwn', text: '⚠️ Sua resposta ficou muito curta ou vaga. ' + instrucao } },
              { type: 'context', elements: [{ type: 'mrkdwn', text: 'Digite "cancelar" para reiniciar.' }] }
            ]);
          }
          return true; // bloqueia, espera nova resposta
        }
        dados.detalhes_extras = texto;
        return false; // segue para próximo passo / resumo
      }
      // Primeira pergunta: faz a pergunta normalmente
      await log(`${cat}_pergunta_detalhes`);
      await setEstado(userId, { etapa: etapaName, ...dados });
      await enviarMensagem(channel, header, [
        { type: 'header', text: { type: 'plain_text', text: header, emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: instrucao } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Digite "cancelar" para reiniciar.' }] }
      ]);
      return true; // bloqueia, espera resposta
    }

    // ═══ 🎁 BRINDES ═══════════════════════════════════════
    // Regras de aprovação:
    // - CS (centro de custo CS) → todos os brindes + aprovação Leandro
    // - Comercial e outros → só Mini Agenda, Caneta, Garrafa Preta, Sacola Preta + SEM aprovação
    if (cat === 'brindes' && !dados.brindes_solicitados) {
      // Determina se é CS ou não (define o que pode pedir)
      const ehCS = isCentroCustoCS(slackUser?.centroCusto);
      dados.ehCS = ehCS;

      // Função: detecta se o texto é uma lista válida COM NÚMEROS
      // (não aceita "uns moleskines" ou "alguns brindes")
      function pareceListaComQuantidades(txt) {
        const t = txt.toLowerCase();
        // Tem números explícitos?
        const temNumero = /\b\d+\b/.test(t);
        // Menciona algum brinde específico?
        const brindes = ['moleskine', 'moleskini', 'agenda', 'caneta', 'container', 'contêiner', 'garrafa', 'copo', 'egg', 'sacola', 'tapa', 'câmera', 'camera'];
        const mencionaBrinde = brindes.some(b => t.includes(b));
        // SÓ aceita se TEM número E menciona brinde
        return temNumero && mencionaBrinde;
      }

      // Captura DIRETO se tem número + brinde claramente
      // OU se está aguardando resposta
      if (pareceListaComQuantidades(texto)) {
        dados.brindes_solicitados = texto;
      } else if (estado?.etapa === 'aguardando_brindes_texto') {
        // Está aguardando mas o texto não tem números — re-pergunta pedindo números
        await log('brindes_pedir_quantidade');
        await setEstado(userId, { etapa: 'aguardando_brindes_texto', ...dados });
        await enviarMensagem(channel, '⚠️ Preciso de quantidades exatas', [
          { type: 'header', text: { type: 'plain_text', text: '⚠️ Quantos de cada?', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: 'Pra fazer o pedido certinho, preciso que você me diga *quantos de cada item* você precisa.\n\nPor exemplo:\n• _"5 canetas e 2 sacolas pretas"_\n• _"10 mini agendas"_\n\nMe manda de novo informando os números, por favor 🙏' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Digite "cancelar" para reiniciar.' }] }
        ]);
        return;
      } else {
        // Primeiro contato: mostra lista (filtrada por CS/Comercial) + sempre pede números
        await log('brindes_pergunta_lista', { ehCS, cc: slackUser?.centroCusto });
        await setEstado(userId, { etapa: 'aguardando_brindes_texto', ...dados });

        let fields, contexto;
        if (ehCS) {
          // CS: vê todos os brindes
          fields = [
            { type: 'mrkdwn', text: '📓 *Moleskine*' },
            { type: 'mrkdwn', text: '📔 *Mini Agenda*' },
            { type: 'mrkdwn', text: '🖊️ *Caneta*' },
            { type: 'mrkdwn', text: '🖤 *Container Preto*' },
            { type: 'mrkdwn', text: '🧡 *Container Laranja*' },
            { type: 'mrkdwn', text: '🤍 *Container Branco*' },
            { type: 'mrkdwn', text: '💜 *Container Roxo*' },
            { type: 'mrkdwn', text: '🤍 *Garrafa Branca*' },
            { type: 'mrkdwn', text: '🖤 *Garrafa Preta*' },
            { type: 'mrkdwn', text: '🥚 *Copo Egg Branco*' },
            { type: 'mrkdwn', text: '🥚 *Copo Egg Preto*' },
            { type: 'mrkdwn', text: '🛍️ *Sacola Preta*' },
            { type: 'mrkdwn', text: '📷 *Tapa Câmera*' },
          ];
          contexto = '🔔 _Seu pedido vai passar pela aprovação do Leandro (CS)._';
        } else {
          // Comercial/Outros: só os 4 itens liberados
          fields = [
            { type: 'mrkdwn', text: '📔 *Mini Agenda*' },
            { type: 'mrkdwn', text: '🖊️ *Caneta*' },
            { type: 'mrkdwn', text: '🖤 *Garrafa Preta*' },
            { type: 'mrkdwn', text: '🛍️ *Sacola Preta*' },
          ];
          contexto = '✅ _Seu pedido será encaminhado direto pra Facilities (não precisa de aprovação)._';
        }

        await enviarMensagem(channel, '🎁 Quais brindes você precisa?', [
          { type: 'header', text: { type: 'plain_text', text: '🎁 Brindes disponíveis', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: ehCS ? '*Você pode pedir qualquer um da lista:*' : '*Sua área pode pedir os seguintes brindes:*' } },
          { type: 'section', fields },
          { type: 'divider' },
          { type: 'section', text: { type: 'mrkdwn', text: '✏️ *Me diga quais brindes e QUANTOS de cada você quer.*\n\n_⚠️ Preciso de números exatos. Não aceito pedidos vagos como "uns moleskines"._\n\nExemplos do que eu aceito:\n• _"Quero 2 moleskines e 3 garrafas pretas"_\n• _"5 canetas e 1 sacola preta"_\n• _"10 mini agendas para um evento dia 20"_' } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: contexto + '\n\nDigite "cancelar" para reiniciar.' }] }
        ]);
        return;
      }
    }

    // ═══ 📦 LOGÍSTICA ═════════════════════════════════════
    // Etapas: (1) transportadora via botão → (2) dados destinatário
    if (cat === 'logistica' && !dados.transportadora) {
      await log('logistica_pergunta_transp');
      await setEstado(userId, { etapa: 'aguardando_transportadora', ...dados });
      await enviarMensagem(channel, '📦 Qual transportadora?', [
        { type: 'header', text: { type: 'plain_text', text: '📦 Qual transportadora?', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: 'Por onde você quer fazer o envio?' } },
        {
          type: 'actions',
          elements: [
            { type: 'button', text: { type: 'plain_text', text: '📦 DHL', emoji: true }, action_id: 'fac_transp_dhl', value: 'DHL', style: 'primary' },
            { type: 'button', text: { type: 'plain_text', text: '📮 Correios', emoji: true }, action_id: 'fac_transp_correios', value: 'Correios' },
            { type: 'button', text: { type: 'plain_text', text: '🚗 Uber Flash', emoji: true }, action_id: 'fac_transp_uber', value: 'Uber Flash' },
          ]
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: 'Digite "cancelar" para reiniciar.' }] }
      ]);
      return;
    }

    // Preserva também o "o que enviar" entre interações
    if (estado?.item_envio) dados.item_envio = estado.item_envio;

    if (cat === 'logistica' && dados.transportadora && !dados.item_envio) {
      // PRIMEIRA pergunta após escolher transportadora: o que será enviado
      if (estado?.etapa === 'aguardando_item_envio') {
        dados.item_envio = texto;
      } else {
        await log('logistica_pergunta_item');
        await setEstado(userId, { etapa: 'aguardando_item_envio', ...dados });
        await enviarMensagem(channel, '📦 O que será enviado?', [
          { type: 'header', text: { type: 'plain_text', text: '📦 O que será enviado?', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: `Via *${dados.transportadora}*.\n\nMe descreve o que precisa ser enviado:\n\n• *Item ou itens* (ex: notebook Dell, kit de brindes, documento, headset)\n• *Quantidade* (se mais de 1)\n• *Observações* sobre o conteúdo (ex: frágil, valor declarado, equipamento)` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Digite "cancelar" para reiniciar.' }] }
        ]);
        return;
      }
    }

    if (cat === 'logistica' && dados.transportadora && dados.item_envio && !dados.destinatario_envio) {
      // SEGUNDA pergunta: pra quem e pra onde
      if (estado?.etapa === 'aguardando_destinatario') {
        dados.destinatario_envio = texto;
      } else {
        await log('logistica_pergunta_destinatario');
        await setEstado(userId, { etapa: 'aguardando_destinatario', ...dados });
        await enviarMensagem(channel, '📍 Dados do destinatário', [
          { type: 'header', text: { type: 'plain_text', text: '📍 Pra quem e pra onde?', emoji: true } },
          { type: 'section', text: { type: 'mrkdwn', text: `Agora me passa os dados completos do destinatário em uma única mensagem:\n\n• *Nome completo*\n• *Endereço* (rua, número, complemento)\n• *Bairro, cidade, estado, CEP*\n• *Telefone* com DDD\n• *CPF* ${dados.transportadora === 'DHL' ? '*(obrigatório para DHL)*' : '(opcional)'}` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: 'Digite "cancelar" para reiniciar.' }] }
        ]);
        return;
      }
    }

    // ═══ 🔑 ACESSOS ═══════════════════════════════════════
    if (cat === 'acessos') {
      const bloqueia = await pedirDetalhes(
        'aguardando_detalhes_acessos',
        '🔑 Qual acesso você precisa?',
        'Pra te ajudar, me passa em uma mensagem:\n\n• *Plataforma/sistema* (ex: Google, Slack, Pipefy, Sankhya, VPN, Datalens)\n• *Ação desejada* (criar acesso, remover, alterar permissão, recuperar senha)\n• *Para quem* (você mesmo ou outra pessoa — nesse caso, nome completo e email)\n• *Nível de permissão* necessário, se souber'
      );
      if (bloqueia) return;
    }

    // ═══ 📎 SUPRIMENTOS ═══════════════════════════════════
    if (cat === 'suprimentos') {
      const bloqueia = await pedirDetalhes(
        'aguardando_detalhes_supr',
        '📎 Detalhes do item',
        'Pra agilizar a compra, me passa em uma mensagem:\n\n• *Item específico* (ex: mouse sem fio Logitech, fone com microfone, caneta azul)\n• *Modelo/marca* preferida (se tiver)\n• *Quantidade* que precisa\n• *Link* do produto (opcional, mas ajuda muito)\n• *Justificativa breve* (substituir item quebrado, novo colaborador, etc.)'
      );
      if (bloqueia) return;
    }

    // ═══ 🔧 MANUTENÇÃO ════════════════════════════════════
    if (cat === 'manutencao') {
      const bloqueia = await pedirDetalhes(
        'aguardando_detalhes_manut',
        '🔧 Detalhes da manutenção',
        'Pra a equipe resolver mais rápido, me passa:\n\n• *Local exato* (sede, andar, sala, posição)\n• *O que está com problema* (ex: ar-condicionado, lâmpada, porta, fechadura, mesa)\n• *Descrição do problema* (não liga, vazando, com barulho, quebrado)\n• *Desde quando* está com defeito (opcional)'
      );
      if (bloqueia) return;
    }

    // ═══ 🔨 REFORMA & MELHORIA ════════════════════════════
    if (cat === 'reforma') {
      const bloqueia = await pedirDetalhes(
        'aguardando_detalhes_reforma',
        '🔨 Detalhes da reforma',
        'Me passa em uma mensagem:\n\n• *Local* da reforma/melhoria\n• *O que precisa ser feito* (pintura, troca de piso, novo layout, móvel novo)\n• *Justificativa* da reforma\n• *Prazo desejado*, se houver\n• *Orçamento aproximado*, se souber'
      );
      if (bloqueia) return;
    }

    // ═══ ❓ OUTROS ════════════════════════════════════════
    // Para categoria "outros", se a primeira mensagem foi curta, pede um pouco mais
    if (cat === 'outros' && !dados.detalhes_extras && (dados.texto_original || '').length < 30) {
      const bloqueia = await pedirDetalhes(
        'aguardando_detalhes_outros',
        '❓ Me conta mais',
        'Pra eu encaminhar pro time certo, me explica melhor:\n\n• *O que você precisa* exatamente\n• *Contexto* (pra quê, quando, onde)\n• Qualquer detalhe que ajude a entender'
      );
      if (bloqueia) return;
    }

    // ═══ Tudo coletado → resumo final ════════════════════
    try {
      await setEstado(userId, { etapa: 'confirmar', ...dados });
    } catch (e) { console.warn('setEstado fail:', e.message); }
    await log('enviando_resumo');
    await enviarResumoParaConfirmacao(channel, userId, dados);
    await log('resumo_enviado');

  } catch (err) {
    await log('ERRO', { err: err.message, stack: err.stack?.substring(0, 400) });
    console.error('[processarMensagemDM] ERRO:', err.message, err.stack);
    // Tenta avisar o usuário mesmo em erro
    try {
      await enviarMensagem(channel, '😕 Ops! Tive um probleminha. Tenta de novo ou usa o formulário: facilities-api.vercel.app');
    } catch (e2) { console.error('  falha mensagem fallback:', e2.message); }
  }
}

async function enviarResumoParaConfirmacao(channel, userId, dados) {
  const catLabel = CATEGORIAS.find(c => c.value === dados.categoria)?.label || dados.categoria || '—';
  const prioEmoji = { baixa: '🟢 Baixa', media: '🟡 Média', alta: '🔴 Alta' }[dados.prioridade] || '🟡 Média';

  const fields = [
    { type: 'mrkdwn', text: `*Categoria:*\n${catLabel}` },
    { type: 'mrkdwn', text: `*Prioridade:*\n${prioEmoji}` },
  ];
  // Sub-campos por categoria
  if (dados.item_brinde) {
    fields.push({ type: 'mrkdwn', text: `*Brinde:*\n🎁 ${dados.item_brinde}` });
  }
  if (dados.quantidade) {
    fields.push({ type: 'mrkdwn', text: `*Quantidade:*\n${dados.quantidade}` });
  }
  if (dados.transportadora) {
    fields.push({ type: 'mrkdwn', text: `*Transportadora:*\n📦 ${dados.transportadora}` });
  }

  fields.push({ type: 'mrkdwn', text: `*Solicitação:*\n${dados.titulo || '—'}` });

  // Blocks adicionais pros campos longos (fora do "fields" que limita)
  const extraBlocks = [];
  if (dados.brindes_solicitados) {
    extraBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*🎁 Brindes solicitados:*\n${dados.brindes_solicitados}` }
    });
  }
  if (dados.item_envio) {
    extraBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📦 O que será enviado:*\n${dados.item_envio}` }
    });
  }
  if (dados.destinatario_envio) {
    extraBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📍 Destinatário:*\n${dados.destinatario_envio}` }
    });
  }
  if (dados.detalhes_extras) {
    extraBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📝 Detalhes:*\n${dados.detalhes_extras}` }
    });
  }
  if (dados.descricao && !dados.detalhes_extras && !dados.destinatario_envio && !dados.item_envio && !dados.brindes_solicitados) {
    extraBlocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*📝 Detalhes:*\n${dados.descricao}` }
    });
  }

  await enviarMensagem(channel, '📋 Quase lá! Confira o resumo do seu chamado:', [
    { type: 'header', text: { type: 'plain_text', text: '📋 Resumo do chamado', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `Confira se está tudo certo antes de eu abrir:` } },
    { type: 'section', fields },
    ...extraBlocks,
    { type: 'divider' },
    {
      type: 'actions',
      elements: [
        { type: 'button', text: { type: 'plain_text', text: '✅ Confirmar e abrir', emoji: true }, style: 'primary', action_id: 'fac_confirmar', value: JSON.stringify(dados) },
        { type: 'button', text: { type: 'plain_text', text: '✏️ Mudar categoria', emoji: true }, action_id: 'fac_editar', value: JSON.stringify(dados) },
        { type: 'button', text: { type: 'plain_text', text: '❌ Cancelar', emoji: true }, style: 'danger', action_id: 'fac_cancelar' },
      ]
    }
  ]);
}

// Tratamento dos botões do fluxo conversacional
async function tratarBotaoFluxoConversacional(body, action) {
  const userId = body.user?.id;
  const channel = body.channel?.id || body.container?.channel_id;
  const actionId = action.action_id;

  const log = async (etapa, extra = {}) => {
    try {
      await db.collection('slack_debug_logs').add({
        at: new Date(), user: userId, etapa: `btn_${etapa}`, action_id: actionId, ...extra,
      });
    } catch {}
  };

  await log('inicio');

  if (actionId === 'fac_cancelar') {
    await log('cancelar');
    await limparEstado(userId);
    await atualizarMensagem(channel, body.message?.ts, '❌ Chamado cancelado.', [
      { type: 'section', text: { type: 'mrkdwn', text: `❌ *Chamado cancelado.*\nSe precisar abrir outro, é só me mandar mensagem.` } }
    ]);
    return;
  }

  if (actionId === 'fac_editar') {
    await enviarMensagem(channel, null, [
      { type: 'section', text: { type: 'mrkdwn', text: `🔄 *Qual a categoria correta?*` } },
      {
        type: 'actions',
        elements: CATEGORIAS.map(c => ({
          type: 'button',
          text: { type: 'plain_text', text: c.label, emoji: true },
          action_id: `fac_cat_${c.value}`,
          value: c.value,
        })).slice(0, 5),
      },
      {
        type: 'actions',
        elements: CATEGORIAS.slice(5).map(c => ({
          type: 'button',
          text: { type: 'plain_text', text: c.label, emoji: true },
          action_id: `fac_cat_${c.value}`,
          value: c.value,
        })),
      }
    ]);
    return;
  }

  // Botões de categoria (fac_cat_<categoria>)
  if (actionId.startsWith('fac_cat_')) {
    const novaCategoria = actionId.replace('fac_cat_', '');
    const estado = await getEstado(userId);
    if (!estado) return;
    const dadosAtualizados = { ...estado, categoria: novaCategoria, etapa: 'confirmar' };
    await setEstado(userId, dadosAtualizados);
    await enviarResumoParaConfirmacao(channel, userId, dadosAtualizados);
    return;
  }

  // Botões de transportadora (fac_transp_<transp>) — sub-fluxo logística
  if (actionId.startsWith('fac_transp_')) {
    await log('transportadora_clicada');
    const transportadora = action.value || actionId.replace('fac_transp_', '');
    const estado = await getEstado(userId);
    if (!estado) {
      await enviarMensagem(channel, '😕 Não consegui encontrar sua solicitação. Manda nova mensagem?');
      return;
    }
    const dadosAtualizados = { ...estado, transportadora, etapa: 'aguardando_item_envio' };
    await setEstado(userId, dadosAtualizados);
    // Atualiza a mensagem dos botões pra mostrar escolha feita
    await atualizarMensagem(channel, body.message?.ts, `📦 ${transportadora} selecionada`, [
      { type: 'section', text: { type: 'mrkdwn', text: `✅ *Transportadora:* ${transportadora}` } }
    ]);
    // Pergunta PRIMEIRO o que será enviado
    await enviarMensagem(channel, '📦 O que será enviado?', [
      { type: 'header', text: { type: 'plain_text', text: '📦 O que será enviado?', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `Via *${transportadora}*.\n\nMe descreve o que precisa ser enviado:\n\n• *Item ou itens* (ex: notebook Dell, kit de brindes, documento, headset)\n• *Quantidade* (se mais de 1)\n• *Observações* sobre o conteúdo (ex: frágil, valor declarado, equipamento)` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Digite "cancelar" para reiniciar.' }] }
    ]);
    return;
  }

  if (actionId === 'fac_confirmar') {
    await log('confirmar_inicio');
    let dados;
    try { dados = JSON.parse(action.value || '{}'); } catch { dados = await getEstado(userId) || {}; }
    await log('confirmar_dados', { cat: dados.categoria, titulo: (dados.titulo || '').substring(0, 40) });

    // Buscar info do usuário
    const slackUser = await getUserInfo(userId);
    await log('confirmar_user', { email: slackUser?.email, nome: slackUser?.nome });

    try {
      const dadosExtras = {};
      if (dados.transportadora) dadosExtras.transportadora = dados.transportadora;
      if (dados.brindes_solicitados) {
        dadosExtras.brindes_solicitados = dados.brindes_solicitados;
        dadosExtras.subcategoria = 'Brindes diversos'; // pra aparecer no admin
      }
      if (dados.item_brinde) {
        dadosExtras.item_brinde = dados.item_brinde;
        dadosExtras.subcategoria = dados.item_brinde;
      }
      if (dados.quantidade) dadosExtras.quantidade = dados.quantidade;
      if (dados.item_envio) dadosExtras.item_envio = dados.item_envio;
      if (dados.destinatario_envio) dadosExtras.destinatario_envio = dados.destinatario_envio;
      if (dados.detalhes_extras) dadosExtras.detalhes_extras = dados.detalhes_extras;

      // Monta a descrição final limpa (SEM DUPLICAR informação)
      let descricaoFinal = '';

      if (dados.categoria === 'brindes' && dados.brindes_solicitados) {
        // BRINDES (novo formato): lista em texto livre
        descricaoFinal = `Brindes solicitados:\n${dados.brindes_solicitados}`;
      } else if (dados.categoria === 'brindes' && dados.item_brinde) {
        // BRINDES (formato antigo): item + quantidade
        descricaoFinal = `Item: ${dados.item_brinde}\nQuantidade: ${dados.quantidade || 'não informada'}`;
        if (dados.detalhes_extras) {
          descricaoFinal += `\n\nObservações: ${dados.detalhes_extras}`;
        }
      } else if (dados.categoria === 'logistica' && dados.transportadora) {
        // LOGÍSTICA: transportadora + o que enviar + pra quem (tudo separado)
        descricaoFinal = `Transportadora: ${dados.transportadora}\n\nO que será enviado:\n${dados.item_envio || '(não informado)'}\n\nDados do destinatário:\n${dados.destinatario_envio || '(não informado)'}`;
      } else if (dados.detalhes_extras) {
        // ACESSOS, SUPRIMENTOS, MANUTENÇÃO, REFORMA, OUTROS: detalhes coletados
        descricaoFinal = dados.detalhes_extras;
      } else {
        // Fallback: texto original que a pessoa mandou
        descricaoFinal = dados.descricao || dados.texto_original || '';
      }

      const ticket = await criarTicketNoFirebase({
        categoria: dados.categoria,
        titulo: dados.titulo,
        descricao: descricaoFinal,
        prioridade: dados.prioridade || 'media',
        slackUser: slackUser || { slackId: userId },
        dadosExtras,
      });
      await log('confirmar_ticket_criado', { id: ticket.id });

      // ── BAIXA AUTOMÁTICA DE ESTOQUE (brindes pelo bot) ──
      if (dados.categoria === 'brindes' && dados.brindes_solicitados) {
        try {
          const baseUrl = process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://facilities-api.vercel.app';
          const r = await fetch(`${baseUrl}/api/baixar-estoque-brinde`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ texto: dados.brindes_solicitados }),
          });
          const resBaixa = await r.json();
          await log('baixa_estoque', { baixas: resBaixa.baixas?.length || 0, alertas: resBaixa.alertas?.length || 0 });
        } catch (e) {
          console.error('Erro ao baixar estoque:', e.message);
          await log('baixa_estoque_erro', { error: e.message });
        }
      }

      await limparEstado(userId);
      await notificarAdmin(ticket);
      await log('confirmar_admin_notif');

      // Determina texto extra baseado em CS/Comercial pra brindes
      let avisoFluxo = '';
      if (ticket.categoria === 'brindes') {
        const ehCS = dados.ehCS === true;
        if (ehCS) {
          avisoFluxo = '\n\n🔔 *Próximo passo:* Seu pedido foi enviado pra aprovação do Leandro. Assim que ele aprovar, você recebe a confirmação aqui.';
        } else {
          avisoFluxo = '\n\n✅ *Próximo passo:* Seu pedido foi encaminhado direto pra equipe de Facilities. Sem necessidade de aprovação.';
        }
      }

      // Atualiza a mensagem com confirmação final
      const catLabel = CATEGORIAS.find(c => c.value === ticket.categoria)?.label || ticket.categoria;
      await atualizarMensagem(channel, body.message?.ts, `✅ Chamado ${ticket.id} aberto!`, [
        { type: 'header', text: { type: 'plain_text', text: '✅ Chamado registrado!', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `Tudo certo! Seu chamado foi registrado e já está na fila do time. 📥${avisoFluxo}` } },
        { type: 'divider' },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Chamado:*\n${ticket.id}` },
            { type: 'mrkdwn', text: `*Status:*\n🔵 Aberto` },
            { type: 'mrkdwn', text: `*Categoria:*\n${catLabel}` },
            { type: 'mrkdwn', text: `*Solicitação:*\n${ticket.titulo}` },
          ]
        },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '🏢 *Facilities LogComex* • Você receberá atualizações de cada fase aqui mesmo.' }] }
      ]);
      await log('confirmar_msg_atualizada');
    } catch (err) {
      await log('confirmar_ERRO', { err: err.message, stack: err.stack?.substring(0, 300) });
      console.error('Erro ao confirmar chamado:', err);
      await enviarMensagem(channel, '⚠️ Ops, tive um problema pra registrar seu chamado. Tente de novo ou use o formulário web.');
    }
    return;
  }
}

// Helpers de envio
async function enviarMensagem(channel, text, blocks = null) {
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, text: text || ' ', ...(blocks ? { blocks } : {}) })
    });
  } catch (e) { console.error('enviarMensagem:', e.message); }
}

async function atualizarMensagem(channel, ts, text, blocks = null) {
  if (!ts) return enviarMensagem(channel, text, blocks);
  try {
    await fetch('https://slack.com/api/chat.update', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel, ts, text: text || ' ', ...(blocks ? { blocks } : {}) })
    });
  } catch (e) { console.error('atualizarMensagem:', e.message); }
}

