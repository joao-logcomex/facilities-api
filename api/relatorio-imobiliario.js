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

async function rodarAlertaSLA() {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const statusAbertos = ['Aberto', 'Em andamento', 'Aguardando aprovação'].map(encodeURIComponent).join(',');
  const r = await fetch(
    `${SUPABASE_URL}/rest/v1/tickets?status=in.(${statusAbertos})&select=id,titulo,categoria,status,data_abertura,nome,user_email`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  const tickets = await r.json();

  const vencidos = [];
  const quaseVencendo = [];
  for (const t of tickets) {
    if (!t.data_abertura) continue;
    const diasSLA = SLA_DIAS[t.categoria] || 7;
    const diasPassados = diasUteisPassados(t.data_abertura);
    if (diasPassados > diasSLA) {
      vencidos.push({ ...t, diasSLA, diasPassados });
    } else if (diasPassados >= diasSLA - 1) {
      quaseVencendo.push({ ...t, diasSLA, diasPassados });
    }
  }

  const linha = (t) => `• *#${t.id}* — ${t.titulo || '(sem título)'} _(${t.categoria}, ${t.diasPassados}/${t.diasSLA} dias úteis, aberto por ${t.nome || t.user_email || '—'})_`;

  let texto;
  if (!vencidos.length && !quaseVencendo.length) {
    texto = '✅ *Alerta de SLA* — nenhum chamado vencido ou perto do prazo hoje. Tudo em dia!';
  } else {
    const partes = ['📋 *Alerta diário de SLA*'];
    if (vencidos.length) {
      partes.push(`\n🔴 *Vencidos (${vencidos.length}):*`);
      partes.push(vencidos.map(linha).join('\n'));
    }
    if (quaseVencendo.length) {
      partes.push(`\n🟡 *Perto de vencer (${quaseVencendo.length}):*`);
      partes.push(quaseVencendo.map(linha).join('\n'));
    }
    texto = partes.join('\n');
  }

  // DM pro João — mesmo padrão de envio usado no resto do bot
  try {
    await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ channel: 'U09MEN4BS0N', text: texto }),
    });
  } catch (e) { console.warn('envio do alerta de SLA falhou:', e.message); }

  return { ok: true, vencidos: vencidos.length, quase_vencendo: quaseVencendo.length, total_abertos: tickets.length };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

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
