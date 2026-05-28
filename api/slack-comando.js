// /api/slack-comando.js
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
    return {
      slackId: userId,
      email: p.email || null,
      nome:  p.real_name || p.display_name || d.user?.name || null,
    };
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
    prioridade: prioridade || 'media',
    status: 'Aberto',
    data_abertura: new Date(),
    updatedAt: new Date(),
    origem: 'slack',
    userEmail: slackUser?.email || null,
    nome: slackUser?.nome || null,
    email: slackUser?.email || null,
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

module.exports = async function handler(req, res) {
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

  // Parser manual (já temos o rawBody)
  let body = {};
  try {
    // Tenta parsear como x-www-form-urlencoded
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
  } catch (e) {
    console.error('Erro ao parsear body:', e);
    return res.status(400).send('Bad body');
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

      // Se for brindes, dispara também o fluxo do Leandro (aprovação)
      if (categoria === 'brindes') {
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
      }

      console.log(`✅ Ticket Slack criado: ${ticket.id} (${categoria}) por ${slackUser?.email || userId}`);
    } catch (err) {
      console.error('Erro ao criar ticket via Slack:', err);
    }
    return; // res.send já foi feito
  }

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
