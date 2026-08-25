// Relatório de IA do Imobiliário (patrimônio + contratos)
// Usa Claude Haiku 4.5 pra gerar análise textual + recomendações

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

function contar(arr, getter) {
  const m = new Map();
  for (const x of arr) {
    const k = getter(x) || '(sem)';
    m.set(k, (m.get(k) || 0) + 1);
  }
  return Object.fromEntries([...m.entries()].sort((a,b) => b[1] - a[1]));
}

// ── Mesmos prazos de SLA (em dias úteis, seg-qui) já usados no admin.html ──
const SLA_DIAS = { brindes:5, suprimentos:7, manutencao:60, reforma:60, seguranca:2, logistica:3, outros:7, infraestrutura:7, limpeza:7, plataformas:3, gestao:7 };

// Mesma lógica do admin.html: só conta segunda a quinta (João é o único que
// trabalha sexta), sem entrar em feriados aqui de propósito — é o mesmo
// critério simplificado já usado no cálculo de SLA do sistema hoje.
function diasUteisPassados(dataInicioStr) {
  const d = new Date(dataInicioStr); d.setHours(0, 0, 0, 0);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  let count = 0;
  let cur = new Date(d);
  while (cur < hoje) {
    const dow = cur.getDay();
    if (dow >= 1 && dow <= 4) count++;
    cur.setDate(cur.getDate() + 1);
  }
  return count;
}

// Notifica um colaborador por e-mail via DM no Slack (busca o Slack ID pelo
// e-mail). Usado tanto no cancelamento automático por SLA quanto na
// devolução automática de brinde não retirado.
async function notificarColaboradorPorEmail(email, texto) {
  if (!email) return false;
  try {
    const userRes = await fetch(`https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(email)}`,
      { headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` } });
    const userData = await userRes.json();
    if (!userData.ok) return false;
    const dmRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ users: userData.user.id }),
    });
    const dmData = await dmRes.json();
    if (!dmData.ok) return false;
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: dmData.channel.id, text: texto }),
    });
    return true;
  } catch (e) {
    console.warn('notificarColaboradorPorEmail falhou:', e.message);
    return false;
  }
}

// Acha o doc do Firestore pelo id de negócio (LC-XXXXX) — os cron jobs
// trabalham com dados do Supabase (mais barato de consultar em lote), mas
// qualquer escrita de verdade precisa achar e atualizar o Firestore, que
// continua sendo a fonte de verdade.
async function acharDocFirestorePorId(ticketId) {
  const snap = await db.collection('tickets').where('id', '==', ticketId).limit(1).get();
  return snap.empty ? null : snap.docs[0];
}

async function rodarAlertaSLA() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  // Busca direto no Firestore — só "Em andamento" entra na conta de SLA (as
  // outras fases não são atraso do time: Aberto ainda não foi triado,
  // Aguardando aprovação depende de terceiro, Pronto p/ retirada e Pedido de
  // compra têm suas próprias regras).
  const snap = await db.collection('tickets').where('status', '==', 'Em andamento').get();

  const vencidos = [];
  const quaseVencendo = [];
  for (const doc of snap.docs) {
    const dados = doc.data();
    const baseData = dados.data_em_andamento || dados.data_abertura;
    if (!baseData) continue;
    const baseDataISO = baseData.toDate ? baseData.toDate().toISOString() : baseData;
    const diasSLA = SLA_DIAS[dados.categoria] || 7;
    const diasPassados = diasUteisPassados(baseDataISO);
    const t = {
      id: dados.id, titulo: dados.titulo, categoria: dados.categoria,
      nome: dados.nome, user_email: dados.userEmail || dados.email,
      diasSLA, diasPassados, _docRef: doc.ref, _dados: dados,
    };
    if (diasPassados > diasSLA) {
      vencidos.push(t);
    } else if (diasPassados >= diasSLA - 1) {
      quaseVencendo.push(t);
    }
  }

  // ── Auto-cancela quem realmente vencer o SLA (todas as categorias) ──
  // Cai como "Cancelado" (não inventa status novo, pra não bagunçar os
  // gráficos existentes), mas com motivo bem marcado pra diferenciar de um
  // cancelamento manual. Avisa o João e o colaborador que abriu o chamado.
  const autoCancelados = [];
  for (const t of vencidos) {
    try {
      const dados = t._dados;
      const motivo = `Cancelado automaticamente por vencimento de SLA (${t.diasPassados}/${t.diasSLA} dias úteis em andamento)`;
      const hist = [...(dados.historico || []), { acao: `⏰ ${motivo}`, data: new Date().toISOString(), usuario: 'Sistema (automático)' }];
      await t._docRef.update({ status: 'Cancelado', motivo_cancelamento: motivo, historico: hist, updatedAt: new Date() });

      fetch(`${SUPABASE_URL}/rest/v1/tickets?on_conflict=id`, {
        method: 'POST',
        headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', Prefer: 'resolution=merge-duplicates' },
        body: JSON.stringify([{ id: t.id, status: 'Cancelado' }]),
      }).catch(() => {});

      if (t.user_email) {
        await notificarColaboradorPorEmail(t.user_email,
          `⏰ Seu chamado *#${t.id}* (${t.titulo || 'sem título'}) foi cancelado automaticamente por ter passado do prazo de atendimento (SLA) sem conclusão. Se ainda precisar disso, pode abrir um novo chamado.`);
      }
      autoCancelados.push(t);
    } catch (e) {
      console.warn(`Falha ao auto-cancelar ${t.id}:`, e.message);
    }
  }

  // ── Devolve ao estoque brinde "Pronto para retirada" há mais de 5 dias ──
  const autoConcluidosBrinde = await rodarAutoConcluirBrindes();

  const linha = (t) => `• *#${t.id}* — ${t.titulo || '(sem título)'} _(${t.categoria}, ${t.diasPassados}/${t.diasSLA} dias úteis em andamento, aberto por ${t.nome || t.user_email || '—'})_`;

  let texto;
  if (!vencidos.length && !quaseVencendo.length && !autoConcluidosBrinde.length) {
    texto = '✅ *Alerta de SLA* — nenhum chamado vencido ou perto do prazo hoje. Tudo em dia!';
  } else {
    const partes = ['📋 *Alerta diário de SLA*'];
    if (autoCancelados.length) {
      partes.push(`\n⏰ *Cancelados automaticamente por SLA vencido (${autoCancelados.length}):*`);
      partes.push(autoCancelados.map(linha).join('\n'));
    }
    if (quaseVencendo.length) {
      partes.push(`\n🟡 *Perto de vencer (${quaseVencendo.length}):*`);
      partes.push(quaseVencendo.map(linha).join('\n'));
    }
    if (autoConcluidosBrinde.length) {
      partes.push(`\n🎁 *Brindes devolvidos ao estoque (não retirados em 5 dias) (${autoConcluidosBrinde.length}):*`);
      partes.push(autoConcluidosBrinde.map(t => `• *#${t.id}* — ${t.itens_brinde || '(itens não especificados)'}`).join('\n'));
    }
    texto = partes.join('\n');
  }

  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'U09MEN4BS0N', text: texto }),
    });
  } catch (e) { console.warn('envio do alerta de SLA falhou:', e.message); }

  return {
    ok: true,
    vencidos: vencidos.length,
    quase_vencendo: quaseVencendo.length,
    auto_cancelados: autoCancelados.length,
    auto_concluidos_brinde: autoConcluidosBrinde.length,
    total_abertos: snap.size,
  };
}

// Normaliza texto pra comparar item do estoque com o texto livre do chamado
// (mesma lógica usada na baixa automática — precisa ser a mesma pra achar
// os itens certos na hora de devolver).
function normalizarNome(s) {
  return (s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/s\b/g, '').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function detectarQtdNoTexto(textoNorm, itemNomeNorm) {
  const palavras = itemNomeNorm.split(' ').filter(p => p.length >= 3);
  if (!palavras.length) return null;
  if (palavras.length === 1) {
    const p = palavras[0];
    const m1 = textoNorm.match(new RegExp(`(\\d+)\\s+\\w*${p}\\w*`, 'i'));
    if (m1) return parseInt(m1[1], 10);
    const m2 = textoNorm.match(new RegExp(`\\w*${p}\\w*\\s+(?:x\\s+)?(\\d+)`, 'i'));
    if (m2) return parseInt(m2[1], 10);
    return null;
  }
  const p1 = palavras[0], p2 = palavras[palavras.length - 1];
  const m = textoNorm.match(new RegExp(`(\\d+)\\s+\\w*${p1}\\w*(?:\\s+\\w+){0,3}\\s+\\w*${p2}\\w*`, 'i'));
  if (m) return parseInt(m[1], 10);
  const m2 = textoNorm.match(new RegExp(`\\w*${p1}\\w*(?:\\s+\\w+){0,3}\\s+\\w*${p2}\\w*\\s+(?:x\\s+)?(\\d+)`, 'i'));
  if (m2) return parseInt(m2[1], 10);
  return null;
}

// Brinde "Pronto para retirada" há mais de 2 dias corridos sem ninguém
// buscar → conclui automaticamente e devolve a quantidade pro estoque
// (sede), já que o item nunca saiu de fato das mãos da empresa.
async function rodarAutoConcluirBrindes() {
  const concluidos = [];
  try {
    const snap = await db.collection('tickets')
      .where('categoria', '==', 'brindes')
      .where('status', '==', 'Pronto para retirada')
      .get();

    const PRAZO_RETIRADA_MS = 5 * 24 * 60 * 60 * 1000;
    const agora = Date.now();

    for (const doc of snap.docs) {
      const dados = doc.data();
      const dataPronto = dados.data_pronto_retirada?.toDate ? dados.data_pronto_retirada.toDate() : (dados.data_pronto_retirada ? new Date(dados.data_pronto_retirada) : null);
      if (!dataPronto || (agora - dataPronto.getTime()) < PRAZO_RETIRADA_MS) continue;

      const motivo = 'Concluído automaticamente — brinde pronto há mais de 5 dias sem retirada, devolvido ao estoque';
      const hist = [...(dados.historico || []), { acao: `📦 ${motivo}`, data: new Date().toISOString(), usuario: 'Sistema (automático)' }];
      await doc.ref.update({ status: 'Concluído', data_conclusao: new Date(), historico: hist, updatedAt: new Date() });

      // Devolve a quantidade pro estoque (sede) — usa o mesmo texto livre
      // que foi usado pra dar baixa quando o chamado foi criado.
      const itensTexto = dados.itens_brinde || dados.titulo || '';
      const textoNorm = normalizarNome(itensTexto);
      const estoqueSnap = await db.collection('estoque_brindes').get();
      for (const itemDoc of estoqueSnap.docs) {
        const itemDados = itemDoc.data();
        const nomeNorm = normalizarNome(itemDados.nome || itemDoc.id);
        const qtd = detectarQtdNoTexto(textoNorm, nomeNorm);
        if (qtd && qtd > 0) {
          const sedeAtual = typeof itemDados.sede === 'number' ? itemDados.sede : 0;
          await itemDoc.ref.update({ sede: sedeAtual + qtd, ultimaAtualizacao: new Date(), ultimaBaixaPor: 'devolucao_automatica' });
        }
      }

      const emailColaborador = dados.userEmail || dados.email;
      if (emailColaborador) {
        await notificarColaboradorPorEmail(emailColaborador,
          `📦 Seu brinde do chamado *#${dados.id}* estava pronto pra retirada há mais de 5 dias e foi devolvido ao estoque por falta de retirada. Se ainda precisar, pode abrir um novo chamado.`);
      }

      concluidos.push({ id: dados.id, itens_brinde: dados.itens_brinde });
    }
  } catch (e) {
    console.warn('rodarAutoConcluirBrindes falhou:', e.message);
  }
  return concluidos;
}

// ── IDs dos gestores que recebem notificação de chamado QR ──
const JOAO_SLACK_ID = 'U09MEN4BS0N';
const HENRIQUE_SLACK_ID = 'D09NP8EMYLX'; // chefe do João

// Supabase helpers (para escrita dupla no QR)
const SUPABASE_URL_ENV = process.env.SUPABASE_URL;
const SUPABASE_KEY_ENV = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function supabasePost(path, body) {
  if (!SUPABASE_URL_ENV || !SUPABASE_KEY_ENV) return;
  await fetch(`${SUPABASE_URL_ENV}/rest/v1/${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_KEY_ENV,
      'Authorization': `Bearer ${SUPABASE_KEY_ENV}`,
      'Prefer': 'resolution=merge-duplicates',
    },
    body: JSON.stringify(body),
  });
}

// Gera ID sequencial via Supabase (evita dependência do Firestore)
async function gerarIdQR() {
  try {
    // Usa Supabase para pegar o próximo seq
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/next_ticket_id`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      },
      body: JSON.stringify({}),
    });
    if (r.ok) {
      const seq = await r.json();
      return 'LC-' + String(seq).padStart(5, '0');
    }
  } catch(e) { console.warn('gerarIdQR supabase falhou:', e.message); }
  // Fallback: gera ID baseado em timestamp (se Firestore indisponível)
  const ts = Date.now();
  const seq = ts % 100000;
  return 'LC-' + String(seq).padStart(5, '0');
}

// Classifica categoria via Claude Haiku baseado na descrição
async function classificarCategoriaQR(descricao, localNome) {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{
          role: 'user',
          content: `Você é um classificador de chamados de Facilities. Com base na descrição, retorne APENAS uma das categorias abaixo (só a palavra, sem explicação):

suprimentos - papel higiênico, sabonete, papel toalha, copos, material de escritório, itens de consumo que acabaram
manutencao - torneira, lâmpada, ar condicionado, vazamento, elétrica, conserto, porta, janela, fechadura, equipamento quebrado

Local: ${localNome}
Descrição: "${descricao}"

Categoria:`,
        }],
      }),
    });
    const data = await resp.json();
    const cat = (data.content?.[0]?.text || '').trim().toLowerCase().replace(/[^a-z]/g, '');
    return cat === 'suprimentos' ? 'suprimentos' : 'manutencao';
  } catch(e) {
    return 'outros';
  }
}

// Gera título curto via IA
async function gerarTituloQR(descricao, localNome) {
  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 60,
        messages: [{
          role: 'user',
          content: `Crie um título curto (máximo 8 palavras) para este chamado de facilities. Seja direto e descritivo. Só o título, sem pontuação final.

Local: ${localNome}
Descrição: "${descricao}"

Título:`,
        }],
      }),
    });
    const data = await resp.json();
    return (data.content?.[0]?.text || '').trim().replace(/^["']|["']$/g, '') || descricao.slice(0, 50);
  } catch(e) {
    return descricao.slice(0, 50);
  }
}

// Envia notificação Slack (DM) para um Slack ID
async function notificarSlackQR(slackId, texto, blocos) {
  const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!SLACK_TOKEN) return;
  await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SLACK_TOKEN}` },
    body: JSON.stringify({ channel: slackId, text: texto, blocks: blocos }),
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── QR Code: abertura de chamado via página /qr.html (público, sem autenticação) ──
  // POST com { local, localNome, descricao, email, nome }
  if (req.method === 'POST' && req.query && req.query.qr === '1') {
    try {
      const { local, localNome, descricao, email, nome: nomeEnviado } = req.body || {};
      if (!descricao || !email || descricao.trim().length < 5) {
        return res.status(400).json({ ok: false, error: 'Dados insuficientes' });
      }

      // Busca dados do colaborador (best-effort com timeout de 2s)
      let colabData = { nome: nomeEnviado || email.split('@')[0], centroCusto: null, cargo: null };
      try {
        const colabPromise = db.collection('colaboradores')
          .where('email', '==', email.toLowerCase().trim())
          .limit(1)
          .get();
        const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 2000));
        const colabSnap = await Promise.race([colabPromise, timeout]);
        if (!colabSnap.empty) {
          const c = colabSnap.docs[0].data();
          colabData = {
            nome: c.nome || c.name || nomeEnviado || email.split('@')[0],
            centroCusto: c.centroCusto || c.centro_custo || null,
            cargo: c.cargo || null,
          };
        }
      } catch(e) { console.warn('busca colaborador falhou/timeout:', e.message); }

      // Classifica categoria e gera título em paralelo
      const [categoria, titulo] = await Promise.all([
        classificarCategoriaQR(descricao.trim(), localNome || local),
        gerarTituloQR(descricao.trim(), localNome || local),
      ]);

      // Gera ID sequencial
      const ticketId = await gerarIdQR();
      const agora = new Date();

      const docData = {
        id: ticketId,
        titulo,
        descricao: descricao.trim(),
        categoria,
        subcategoria: null,
        prioridade: 'media',
        status: 'Aberto',
        data_abertura: agora,
        updatedAt: agora,
        origem: 'qrcode',
        local_qr: local || null,
        local_qr_nome: localNome || local || null,
        userEmail: email.toLowerCase().trim(),
        email: email.toLowerCase().trim(),
        nome: colabData.nome,
        centroCusto: colabData.centroCusto,
        departamento: colabData.centroCusto,
        cargo: colabData.cargo,
        historico: [{
          acao: `Chamado aberto via QR Code em ${localNome || local || 'local não identificado'}`,
          data: agora.toISOString(),
          usuario: email,
        }],
      };

      // Salva no Firestore (best-effort com timeout de 3s — Supabase é fonte de verdade)
      try {
        const fsPromise = db.collection('tickets').add(docData);
        const fsTimeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 3000));
        await Promise.race([fsPromise, fsTimeout]);
      } catch(e) { console.warn('Firestore add falhou/timeout:', e.message); }

      // Espelha no Supabase (não bloqueia em caso de erro)
      supabasePost('tickets?on_conflict=id', [{
        id: ticketId,
        titulo,
        descricao: descricao.trim(),
        categoria,
        subcategoria: null,
        prioridade: 'media',
        status: 'Aberto',
        origem: 'qrcode',
        user_email: email.toLowerCase().trim(),
        nome: colabData.nome,
        centro_custo: colabData.centroCusto,
        departamento: colabData.centroCusto,
        cargo: colabData.cargo,
        dentro_sla: null,
        data_abertura: agora.toISOString(),
      }]).catch(e => console.warn('supabase qr falhou:', e.message));

      // Emojis por categoria
      const emojiCat = { suprimentos: '📎', manutencao: '🔧', limpeza: '🧹', reforma: '🏗️', outros: '📝' };
      const emoji = emojiCat[categoria] || '📝';
      const localLabel = localNome || local || 'Local não identificado';

      // Notifica o João
      const blocos = [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *Novo chamado via QR Code*\n*${ticketId}* · ${titulo}`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*📍 Local:*\n${localLabel}` },
            { type: 'mrkdwn', text: `*🗂️ Categoria:*\n${categoria}` },
            { type: 'mrkdwn', text: `*👤 Solicitante:*\n${colabData.nome}` },
            { type: 'mrkdwn', text: `*📧 E-mail:*\n${email}` },
          ],
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `*💬 Descrição:*\n>${descricao.trim()}` },
        },
        {
          type: 'actions',
          elements: [{
            type: 'button',
            text: { type: 'plain_text', text: '📋 Ver no admin', emoji: true },
            url: `https://facilities-api.vercel.app/admin.html`,
            style: 'primary',
          }],
        },
      ];

      // Notifica João (DM)
      await notificarSlackQR(JOAO_SLACK_ID,
        `${emoji} Novo chamado QR: ${ticketId} — ${localLabel}`, blocos);

      // Notifica Henrique (DM) — só abertura e conclusão, sem fases intermediárias
      await notificarSlackQR(HENRIQUE_SLACK_ID,
        `${emoji} Novo chamado via QR Code: ${ticketId} — ${localLabel} — ${titulo}`, [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *Chamado aberto via QR Code*\n*${ticketId}* · ${titulo}\n\n*📍 Local:* ${localLabel}\n*👤 Solicitante:* ${colabData.nome} (${email})\n*🗂️ Categoria:* ${categoria}\n\n>${descricao.trim()}`,
            },
          },
        ]);

      return res.status(200).json({ ok: true, ticketId });
    } catch(e) {
      console.error('qr chamado erro:', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  // ── Cron diário: alerta de SLA (chamados perto de vencer ou já vencidos) ──
  // Chamado pelo Vercel Cron (vercel.json), seg-sex 8h30 Curitiba. Protegido
  // pelo CRON_SECRET que o próprio Vercel injeta como Bearer automaticamente.
  if (req.query && req.query.cron === 'sla_alertas') {
    const authHeader = req.headers.authorization;
    if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
      return res.status(401).json({ ok: false, error: 'unauthorized' });
    }
    try {
      const resultado = await rodarAlertaSLA();
      return res.status(200).json(resultado);
    } catch (e) {
      console.error('cron sla_alertas erro:', e);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── "Meus chamados" (index.html) — lê do Supabase por e-mail ──
  // Só devolve os campos que a tela usa, nunca dados de outras pessoas
  // (o e-mail vem do usuário logado no Firebase Auth, no próprio front).
  if (req.query && req.query.meus_chamados === '1') {
    const email = (req.query.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, error: 'email obrigatório' });
    try {
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
      const rTickets = await fetch(
        `${SUPABASE_URL}/rest/v1/tickets?user_email=eq.${encodeURIComponent(email)}&order=data_abertura.desc&limit=100`,
        { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
      );
      const tickets = await rTickets.json();
      const ids = tickets.map(t => t.id);
      let historicoPorTicket = {};
      if (ids.length) {
        const filtroIds = ids.map(id => `"${id}"`).join(',');
        const rHist = await fetch(
          `${SUPABASE_URL}/rest/v1/tickets_historico?ticket_id=in.(${filtroIds})&order=data.desc`,
          { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
        );
        const historico = await rHist.json();
        for (const h of historico) {
          if (!historicoPorTicket[h.ticket_id]) historicoPorTicket[h.ticket_id] = { ultima: h.acao, total: 0 };
          historicoPorTicket[h.ticket_id].total++;
        }
      }
      const resultado = tickets.map(t => ({
        ...t,
        _ultimaAcao: historicoPorTicket[t.id]?.ultima || null,
        _temAtualizacao: (historicoPorTicket[t.id]?.total || 0) > 1,
      }));
      return res.status(200).json({ ok: true, tickets: resultado });
    } catch (e) {
      console.error('meus_chamados erro:', e);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }

  // ── Endpoint público (sem login) para a TV do setor — "Go Live" ──
  // Ativado com ?tv=facilities. Devolve só números agregados de 2026,
  // nunca dados individuais de chamados (nome, e-mail etc).
  // Cache de borda por 2min: bom meio-termo entre atualização rápida e
  // economia de cota — combinado com as consultas de agregação abaixo,
  // o custo por atualização cai de centenas de leituras para ~5.
  if (req.query && req.query.tv === 'facilities') {
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=110, stale-while-revalidate=30');
    try {
      const anoAlvo = parseInt(req.query.ano) || new Date().getFullYear();
      const inicioAno = `${anoAlvo}-01-01T00:00:00.000Z`;
      const inicioProxAno = `${anoAlvo + 1}-01-01T00:00:00.000Z`;
      const SUPABASE_URL = process.env.SUPABASE_URL;
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

      // Conta via Postgres (Prefer: count=exact) sem baixar nenhuma linha —
      // Range 0-0 pede só 1 registro de volta, a contagem real vem no
      // cabeçalho content-range. Bem mais simples que a agregação do Firestore.
      async function contar(filtroExtra) {
        const url = `${SUPABASE_URL}/rest/v1/tickets?data_abertura=gte.${encodeURIComponent(inicioAno)}&data_abertura=lt.${encodeURIComponent(inicioProxAno)}${filtroExtra}&select=id`;
        const r = await fetch(url, {
          headers: {
            apikey: SUPABASE_KEY,
            Authorization: `Bearer ${SUPABASE_KEY}`,
            Prefer: 'count=exact',
            Range: '0-0',
          },
        });
        // NUNCA assume 0 numa falha passageira (rede, Supabase momentâneo) —
        // isso já causou um "Concluídos: 0" errado na TV. Se não conseguir
        // confirmar o número de verdade, lança erro; o endpoint todo falha
        // e o front-end mantém o último valor bom (em vez de mostrar 0).
        if (!r.ok) throw new Error(`Supabase respondeu ${r.status} pra "${filtroExtra}"`);
        const contentRange = r.headers.get('content-range');
        if (!contentRange || !contentRange.includes('/')) {
          throw new Error(`content-range ausente/inválido pra "${filtroExtra}": ${contentRange}`);
        }
        const total = parseInt(contentRange.split('/')[1]);
        if (Number.isNaN(total)) throw new Error(`content-range não numérico: ${contentRange}`);
        return total;
      }

      const [total, concluidos, cancelados, slaTrue, slaFalse] = await Promise.all([
        contar(''),
        contar(`&status=eq.${encodeURIComponent('Concluído')}`),
        contar(`&status=eq.${encodeURIComponent('Cancelado')}`),
        contar('&dentro_sla=eq.true'),
        contar('&dentro_sla=eq.false'),
      ]);

      const abertos = total - concluidos - cancelados;
      const comSLA = slaTrue + slaFalse;
      const slaPct = comSLA > 0 ? Math.round((slaTrue / comSLA) * 100) : null;

      return res.status(200).json({
        ok: true,
        ano: anoAlvo,
        total,
        abertos, concluidos, cancelados,
        sla_pct: slaPct,
        atualizado_em: new Date().toISOString(),
        fonte: 'supabase',
      });
    } catch (e) {
      console.error('tv=facilities erro:', e);
      return res.status(500).json({ ok: false, error: e.message });
    }
  }

  try {
    // 1. Buscar tudo do Firebase
    const [patrimonioSnap, espacosSnap, contratosSnap] = await Promise.all([
      db.collection('imob_patrimonio').get(),
      db.collection('imob_espacos').get(),
      db.collection('imob_contratos').get(),
    ]);
    const patrimonio = patrimonioSnap.docs.map(d => d.data());
    const espacos = espacosSnap.docs.map(d => d.data());
    const contratos = contratosSnap.docs.map(d => d.data());

    // 2. Calcular estatísticas
    const stats = {
      patrimonio: {
        total: patrimonio.length,
        por_categoria: contar(patrimonio, x => x.categoria),
        por_status: contar(patrimonio, x => x.status),
        por_local: contar(patrimonio, x => x.localizacao),
        por_marca: contar(patrimonio, x => x.marca),
        validados: patrimonio.filter(x => x.status_validacao === 'validado').length,
        pendentes: patrimonio.filter(x => x.status_validacao === 'pendente_validacao').length,
        sem_responsavel: patrimonio.filter(x => !x.responsavel).length,
        sem_contrato: patrimonio.filter(x => !x.contrato_url).length,
        sem_data_compra: patrimonio.filter(x => !x.data_compra).length,
        sem_valor: patrimonio.filter(x => !x.valor_aquisicao).length,
        sem_localizacao: patrimonio.filter(x => !x.localizacao).length,
      },
      espacos: {
        total: espacos.length,
        por_tipo: contar(espacos, x => x.tipo),
      },
      contratos: {
        total: contratos.length,
        por_tipo: contar(contratos, x => x.tipo),
        vencendo_em_breve: contratos.filter(c => {
          if (!c.data_vencimento) return false;
          const dt = c.data_vencimento?.toDate ? c.data_vencimento.toDate() : new Date(c.data_vencimento);
          const dias = (dt - new Date()) / (1000*60*60*24);
          return dias > 0 && dias <= 90;
        }).length,
      },
    };

    // 3. Top categorias e locais
    const topCategorias = Object.entries(stats.patrimonio.por_categoria).slice(0, 5);
    const topLocais = Object.entries(stats.patrimonio.por_local).slice(0, 8);
    const topMarcas = Object.entries(stats.patrimonio.por_marca).slice(0, 5);

    // 4. Montar prompt pro Claude Haiku
    const promptIA = `Você é uma assistente que prepara um relatório executivo sobre o patrimônio físico de uma empresa de tecnologia (LogComex). Os dados vêm de um sistema de gestão de Facilities.

DADOS ATUAIS:

📦 PATRIMÔNIO (${stats.patrimonio.total} itens)
- Validados: ${stats.patrimonio.validados} | Pendentes validação: ${stats.patrimonio.pendentes}
- Top categorias: ${topCategorias.map(([k,v]) => `${k} (${v})`).join(', ')}
- Top marcas: ${topMarcas.map(([k,v]) => `${k} (${v})`).join(', ')}
- Top localizações: ${topLocais.map(([k,v]) => `${k} (${v})`).join(', ')}
- Por status: ${JSON.stringify(stats.patrimonio.por_status)}

⚠️ QUALIDADE DOS DADOS:
- Sem responsável atribuído: ${stats.patrimonio.sem_responsavel} (${(stats.patrimonio.sem_responsavel/stats.patrimonio.total*100).toFixed(0)}%)
- Sem contrato de compra anexado: ${stats.patrimonio.sem_contrato} (${(stats.patrimonio.sem_contrato/stats.patrimonio.total*100).toFixed(0)}%)
- Sem data de compra registrada: ${stats.patrimonio.sem_data_compra} (${(stats.patrimonio.sem_data_compra/stats.patrimonio.total*100).toFixed(0)}%)
- Sem valor de aquisição: ${stats.patrimonio.sem_valor} (${(stats.patrimonio.sem_valor/stats.patrimonio.total*100).toFixed(0)}%)
- Sem localização: ${stats.patrimonio.sem_localizacao}

🏢 ESPAÇOS: ${stats.espacos.total} cadastrados
📄 CONTRATOS: ${stats.contratos.total} cadastrados (${stats.contratos.vencendo_em_breve} vencendo nos próximos 90 dias)

TAREFA: Gere um relatório executivo em Markdown com até 600 palavras, dividido nas seções:

## Resumo Executivo
(2-3 frases com o panorama geral)

## Composição do Patrimônio
(análise dos números: o que predomina, distribuição, marcas, etc)

## ⚠️ Pontos de Atenção
(maior preocupação primeiro. Foque em qualidade dos dados — % sem responsável, sem contrato, etc. Se a maioria não está validada, isso é importante)

## 🎯 Recomendações Prioritárias
(3 a 5 ações práticas que o time deveria fazer, em ordem de prioridade. Exemplos: "Atribuir responsável aos X itens da Área Comum", "Subir contratos para os itens caros", "Validar a próxima planilha pra confirmar quais ainda existem fisicamente")

REGRAS:
- Tom profissional mas direto, em português brasileiro
- Use números reais dos dados acima, NÃO invente
- Use **negrito** pra destacar achados importantes
- Não ofereça ajuda extra ao final, só termine o relatório`;

    // 5. Chamar Claude Haiku
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2000,
        messages: [{ role: 'user', content: promptIA }],
      }),
    });
    const aiData = await aiRes.json();
    if (!aiData.content || !aiData.content[0]) {
      console.error('Resposta IA:', aiData);
      return res.status(500).json({ ok: false, error: 'IA não retornou conteúdo', details: aiData });
    }

    const relatorioMd = aiData.content[0].text;

    return res.status(200).json({
      ok: true,
      stats,
      relatorio_markdown: relatorioMd,
      gerado_em: new Date().toISOString(),
    });
  } catch (e) {
    console.error('relatorio-imobiliario erro:', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
};
