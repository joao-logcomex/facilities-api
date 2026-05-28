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
        const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://facilities-api.vercel.app';
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
      res.status(200).send(''); // ack imediato
      tratarBotaoFluxoConversacional(body, action).catch(err => {
        console.error('Erro botão fluxo:', err);
      });
      return;
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
  // ROTA 7: event_callback → mensagens recebidas em DM
  // ============================================================
  if (body.type === 'event_callback' && body.event) {
    const evt = body.event;
    const eventId = body.event_id;
    console.log('📩 Event:', evt.type, 'ch_type:', evt.channel_type, 'user:', evt.user, 'event_id:', eventId, 'text:', (evt.text || '').substring(0, 50));

    // Ignora eventos não-relevantes
    if (evt.type !== 'message') return res.status(200).send('');
    if (evt.bot_id || evt.subtype === 'bot_message' || evt.subtype === 'message_changed' || evt.subtype === 'message_deleted') {
      console.log('  ↳ ignorado (bot ou subtype)');
      return res.status(200).send('');
    }
    if (evt.channel_type !== 'im') {
      console.log('  ↳ ignorado (não DM):', evt.channel_type);
      return res.status(200).send('');
    }
    if (!evt.text || !evt.user) {
      console.log('  ↳ ignorado (sem text/user)');
      return res.status(200).send('');
    }

    // Deduplicação: Slack pode reenviar o mesmo evento se demorou >3s
    if (eventId) {
      try {
        const dedupeDoc = db.collection('slack_eventos_processados').doc(eventId);
        const exists = await dedupeDoc.get();
        if (exists.exists) {
          console.log('  ↳ evento duplicado ignorado:', eventId);
          return res.status(200).send('');
        }
        await dedupeDoc.set({ at: new Date(), user: evt.user, channel: evt.channel });
      } catch (e) {
        console.warn('  ↳ falha dedup (segue):', e.message);
      }
    }

    // Processa SINCRONAMENTE
    try {
      console.log('  ↳ processando...');
      await processarMensagemDM(evt);
      console.log('  ↳ ✅ ok');
    } catch (err) {
      console.error('  ↳ ❌ erro:', err.message);
      console.error(err.stack);
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

  const systemPrompt = `Você é um assistente do time de Facilities da LogComex. Sua tarefa é interpretar mensagens de colaboradores que querem abrir um chamado e extrair informações estruturadas.

Categorias disponíveis (responda EXATAMENTE com um destes valores):
- suprimentos: papelaria, material de escritório (mouse, teclado, caneta, papel, grampeador)
- manutencao: consertos, problemas físicos (ar condicionado, lâmpada, vazamento, móvel quebrado)
- reforma: melhorias estruturais maiores
- acessos: criar/remover/alterar acesso a plataformas (Google, Slack, sistemas)
- brindes: solicitar brindes da empresa (moleskine, containers, garrafas, copos, sacolas, canetas)
- logistica: envio/recebimento de pacotes (DHL, Correios, Uber Flash)
- outros: quando não se encaixar nas demais

Prioridade (inferir do tom/urgência):
- baixa: rotina, sem pressa
- media: padrão (default)
- alta: urgente, palavras como "urgente", "preciso hoje", "parou", "quebrou", "não consigo trabalhar"

RESPONDA APENAS COM UM JSON VÁLIDO no formato:
{
  "categoria": "suprimentos" | "manutencao" | "reforma" | "acessos" | "brindes" | "logistica" | "outros" | null,
  "titulo": "Frase curta resumindo (máx 80 chars)" | null,
  "descricao": "Detalhes adicionais se houver, senão null",
  "prioridade": "baixa" | "media" | "alta",
  "tem_info_suficiente": true | false,
  "pergunta_adicional": "Se faltar info essencial, qual pergunta fazer? Senão null",
  "saudacao_apenas": true | false
}

Se a pessoa só mandou "oi", "olá", "bom dia" etc → saudacao_apenas: true.
Se a categoria for "brindes" e não souber qual item → pergunta_adicional: "Qual item você precisa? (Moleskine, Garrafa, Container, etc)"
Se a categoria for "logistica" e não souber destinatário/endereço → pergunta_adicional: "Pra quem e qual endereço?"`;

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
        messages: [{
          role: 'user',
          content: estadoAnterior
            ? `Contexto da conversa anterior: ${JSON.stringify(estadoAnterior)}\n\nNova mensagem: "${texto}"`
            : `Mensagem do colaborador: "${texto}"`
        }]
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
  const isSaudacao = /^(oi|ola|olá|bom dia|boa tarde|boa noite|e aí|eai|hey|hi|hello)\s*[!.?]*\s*$/i.test(t.trim());
  if (isSaudacao) return { saudacao_apenas: true, tem_info_suficiente: false };

  let categoria = null;
  if (/mouse|teclado|caneta|papel|grampeador|clipe|post.?it|cartucho|toner|impressora/i.test(t)) categoria = 'suprimentos';
  else if (/ar.?condicionado|lampada|lâmpada|vazamento|conserto|quebr|reparo|manuten/i.test(t)) categoria = 'manutencao';
  else if (/acesso|permiss|liberar|google|slack|pipefy|workspace/i.test(t)) categoria = 'acessos';
  else if (/moleskine|garrafa|brinde|container|sacola|copo egg|tapa câmera|tapa camera/i.test(t)) categoria = 'brindes';
  else if (/dhl|correio|envio|enviar|pacote|encomenda|uber flash/i.test(t)) categoria = 'logistica';

  let prioridade = 'media';
  if (/urgent|hoje|agora|imediat|emergen|parou|quebrou|nao consigo|não consigo/i.test(t)) prioridade = 'alta';

  return {
    categoria,
    titulo: texto.length > 80 ? texto.substring(0, 77) + '...' : texto,
    descricao: null,
    prioridade,
    tem_info_suficiente: categoria !== null,
    pergunta_adicional: categoria === null ? 'Qual o tipo de chamado? (suprimentos, manutenção, brindes, acessos, logística, etc.)' : null,
    saudacao_apenas: false,
  };
}

// Processa mensagem em DM recebida
async function processarMensagemDM(evt) {
  const userId = evt.user;
  const channel = evt.channel;
  const texto = (evt.text || '').trim();

  // Pega estado anterior (pode ser uma conversa em andamento)
  const estado = await getEstado(userId);

  // Comandos especiais
  if (/^(cancelar|cancel|sair|reset)$/i.test(texto)) {
    await limparEstado(userId);
    await enviarMensagem(channel, '✅ Conversa reiniciada. Pode mandar uma nova solicitação quando quiser! 👋');
    return;
  }

  // Analisar a mensagem
  const analise = await analisarMensagem(texto, estado);

  // Caso 1: Saudação simples
  if (analise.saudacao_apenas) {
    await enviarMensagem(channel, null, [
      { type: 'section', text: { type: 'mrkdwn', text: `👋 *Olá!* Sou o assistente do time de Facilities da LogComex.` } },
      { type: 'section', text: { type: 'mrkdwn', text: `Pode me contar o que você precisa que eu te ajudo a abrir um chamado.\n\n*Exemplos:*\n• _"Preciso de um mouse novo"_\n• _"Ar condicionado da sala 3 com problema"_\n• _"Quero pedir alguns moleskines"_\n• _"Envio via DHL para São Paulo"_` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: '💡 Você também pode usar o formulário web: facilities-api.vercel.app' }] }
    ]);
    return;
  }

  // Caso 2: Falta info → faz uma pergunta e guarda estado
  if (!analise.tem_info_suficiente && analise.pergunta_adicional) {
    await setEstado(userId, {
      etapa: 'aguardando_resposta',
      categoria: analise.categoria,
      titulo: analise.titulo,
      descricao: analise.descricao,
      prioridade: analise.prioridade,
      texto_original: texto,
    });
    await enviarMensagem(channel, null, [
      { type: 'section', text: { type: 'mrkdwn', text: `🤔 ${analise.pergunta_adicional}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: 'Digite "cancelar" para reiniciar.' }] }
    ]);
    return;
  }

  // Caso 3: Tem info suficiente → mostra resumo com botões de confirmação
  const dados = {
    categoria: analise.categoria,
    titulo: analise.titulo,
    descricao: analise.descricao,
    prioridade: analise.prioridade,
    texto_original: estado?.texto_original ? `${estado.texto_original}\n\n${texto}` : texto,
  };
  await setEstado(userId, { etapa: 'confirmar', ...dados });
  await enviarResumoParaConfirmacao(channel, userId, dados);
}

async function enviarResumoParaConfirmacao(channel, userId, dados) {
  const catLabel = CATEGORIAS.find(c => c.value === dados.categoria)?.label || dados.categoria || '—';
  const prioEmoji = { baixa: '🟢 Baixa', media: '🟡 Média', alta: '🔴 Alta' }[dados.prioridade] || '🟡 Média';

  await enviarMensagem(channel, '📋 Quase lá! Confira o resumo do seu chamado:', [
    { type: 'header', text: { type: 'plain_text', text: '📋 Resumo do chamado', emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: `Confira se está tudo certo antes de eu abrir:` } },
    {
      type: 'section',
      fields: [
        { type: 'mrkdwn', text: `*Categoria:*\n${catLabel}` },
        { type: 'mrkdwn', text: `*Prioridade:*\n${prioEmoji}` },
        { type: 'mrkdwn', text: `*Solicitação:*\n${dados.titulo || '—'}` },
        ...(dados.descricao ? [{ type: 'mrkdwn', text: `*Detalhes:*\n${dados.descricao}` }] : []),
      ]
    },
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

  if (actionId === 'fac_cancelar') {
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

  if (actionId === 'fac_confirmar') {
    let dados;
    try { dados = JSON.parse(action.value || '{}'); } catch { dados = await getEstado(userId) || {}; }

    // Buscar info do usuário
    const slackUser = await getUserInfo(userId);

    try {
      const ticket = await criarTicketNoFirebase({
        categoria: dados.categoria,
        titulo: dados.titulo,
        descricao: dados.descricao || dados.texto_original,
        prioridade: dados.prioridade || 'media',
        slackUser: slackUser || { slackId: userId },
        dadosExtras: {},
      });

      await limparEstado(userId);
      await notificarAdmin(ticket);

      // Atualiza a mensagem com confirmação final
      const catLabel = CATEGORIAS.find(c => c.value === ticket.categoria)?.label || ticket.categoria;
      await atualizarMensagem(channel, body.message?.ts, `✅ Chamado ${ticket.id} aberto!`, [
        { type: 'header', text: { type: 'plain_text', text: '✅ Chamado registrado!', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `Tudo certo! Seu chamado foi registrado e já está na fila do time. 📥` } },
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
    } catch (err) {
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
