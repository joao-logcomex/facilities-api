// api/relatorio.js
// Gera relatório executivo combinando dados do Pipefy + Firebase
// Período: mês selecionado + acumulado anual

const PIPEFY_TOKEN = process.env.PIPEFY_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

// Prazos SLA por fase de execução (em dias)
const SLA_PRAZOS = {
  'Brinde': 5, 'Brinde Comercial': 5, 'Brinde Coleta': 5,
  'Acessos': 2, 'Manutenção': 60,
  'Suprimentos de escritório': 7, 'Emprestimo': 7,
  'Recebimento de Encomendas': 30, 'Elogios ou Sugestões': 30,
};

// Fases do pipe de Facilities
const FASES = [
  { id: '326115156', status: 'concluido' },
  { id: '326115157', status: 'cancelado' },
  { id: '333580091', status: 'andamento' },
  { id: '326115150', status: 'andamento' },
  { id: '326115158', status: 'andamento' },
  { id: '326115151', status: 'andamento' },
  { id: '326431237', status: 'andamento' },
  { id: '328355056', status: 'andamento' },
  { id: '326453470', status: 'andamento' },
  { id: '326518140', status: 'andamento' },
  { id: '326115149', status: 'andamento' },
  { id: '328355169', status: 'andamento' },
  { id: '327962192', status: 'andamento' },
];

async function pipefyQuery(query) {
  const r = await fetch('https://api.pipefy.com/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${PIPEFY_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });
  return r.json();
}

async function buscarCardsFase(faseId, faseStatus) {
  const cards = [];
  let cursor = null;
  let pagina = 0;

  while (pagina < 50) {
    const after = cursor ? `, after: "${cursor}"` : '';
    const q = `{ phase(id: "${faseId}") { cards(first: 50${after}) {
      edges { node {
        id title created_at finished_at
        fields { name value }
        phases_history { phase { name } duration }
      } }
      pageInfo { hasNextPage endCursor }
    } } }`;

    const data = await pipefyQuery(q);
    const phase = data?.data?.phase;
    if (!phase) break;

    for (const edge of phase.cards.edges) {
      const node = edge.node;
      const tipo = node.fields?.find(f => f.name === 'Tipo de solicitação')?.value || 'Outros';

      // Calcula SLA
      let dentroSLA = null, tempoExec = null, prazo = null;
      for (const ph of (node.phases_history || [])) {
        const nome = ph.phase?.name;
        if (SLA_PRAZOS[nome] !== undefined && ph.duration != null) {
          prazo = SLA_PRAZOS[nome];
          tempoExec = ph.duration / 86400;
          dentroSLA = tempoExec <= prazo;
          break;
        }
      }

      cards.push({
        id: node.id,
        titulo: node.title,
        tipo,
        status: faseStatus,
        created_at: node.created_at,
        finished_at: node.finished_at,
        dentroSLA,
        tempoExec,
        prazo,
        origem: 'pipefy',
      });
    }

    if (!phase.cards.pageInfo.hasNextPage) break;
    cursor = phase.cards.pageInfo.endCursor;
    pagina++;
  }
  return cards;
}

function calcStats(cards, mes, ano) {
  // Filtra por mês/ano
  const doMes = cards.filter(c => {
    const d = new Date(c.created_at);
    return d.getMonth() + 1 === mes && d.getFullYear() === ano;
  });

  // Filtra por ano (acumulado)
  const doAno = cards.filter(c => new Date(c.created_at).getFullYear() === ano);

  function stats(list) {
    const total = list.length;
    const concluidos = list.filter(c => c.status === 'concluido').length;
    const cancelados = list.filter(c => c.status === 'cancelado').length;
    const andamento = list.filter(c => c.status === 'andamento').length;
    const dentroSLA = list.filter(c => c.status === 'concluido' && c.dentroSLA === true).length;
    const foraSLA = list.filter(c => c.status === 'concluido' && c.dentroSLA === false).length;
    const baseSLA = dentroSLA + foraSLA;
    const sla = baseSLA > 0 ? Math.round((dentroSLA / baseSLA) * 100) : 0;

    // Por tipo
    const porTipo = {};
    list.forEach(c => { porTipo[c.tipo] = (porTipo[c.tipo] || 0) + 1; });
    const topTipos = Object.entries(porTipo).sort((a,b) => b[1]-a[1]).slice(0,6);

    // Tempo médio de conclusão
    const comTempo = list.filter(c => c.status === 'concluido' && c.tempoExec != null);
    const tempoMedio = comTempo.length > 0
      ? (comTempo.reduce((s, c) => s + c.tempoExec, 0) / comTempo.length).toFixed(1)
      : null;

    return { total, concluidos, cancelados, andamento, dentroSLA, foraSLA, sla, topTipos, tempoMedio };
  }

  return { mes: stats(doMes), ano: stats(doAno), totalAno: doAno.length };
}

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurado' });
  if (!PIPEFY_TOKEN) return res.status(500).json({ error: 'PIPEFY_TOKEN não configurado' });

  const { tickets: firebaseTickets = [], mes, ano } = req.body;
  const mesNum = parseInt(mes) || new Date().getMonth() + 1;
  const anoNum = parseInt(ano) || new Date().getFullYear();
  const mesNome = MESES[mesNum - 1];

  try {
    // 1. Busca dados do Pipefy em paralelo
    const pipefyCards = [];
    for (const fase of FASES) {
      try {
        const cards = await buscarCardsFase(fase.id, fase.status);
        pipefyCards.push(...cards);
      } catch (e) {
        console.warn(`Fase ${fase.id} falhou:`, e.message);
      }
    }

    // 2. Normaliza tickets Firebase para mesmo formato
    const firebaseCards = firebaseTickets.map(t => ({
      id: t.id || t._docId,
      titulo: t.titulo || '',
      tipo: t.categoria || 'Outros',
      status: t.status === 'Concluído' ? 'concluido' : t.status === 'Cancelado' ? 'cancelado' : 'andamento',
      created_at: t.data_abertura?.toDate ? t.data_abertura.toDate().toISOString() : (t.data_abertura || new Date().toISOString()),
      finished_at: null,
      dentroSLA: null,
      tempoExec: null,
      prazo: null,
      origem: 'firebase',
    }));

    // 3. Combina todos os cards
    const todosCards = [...pipefyCards, ...firebaseCards];

    // 4. Calcula stats
    const { mes: statsMes, ano: statsAno } = calcStats(todosCards, mesNum, anoNum);

    // 5. Monta contexto para a IA
    const contexto = `
=== MÊS: ${mesNome}/${anoNum} ===
Total de solicitações: ${statsMes.total}
Concluídas: ${statsMes.concluidos}
Canceladas: ${statsMes.cancelados}
Em andamento: ${statsMes.andamento}
Dentro do SLA: ${statsMes.dentroSLA} | Fora do SLA: ${statsMes.foraSLA}
SLA do mês: ${statsMes.sla}% (meta: 93%)
Tempo médio de conclusão: ${statsMes.tempoMedio ? statsMes.tempoMedio + ' dias' : 'N/D'}

Top tipos de solicitação no mês:
${statsMes.topTipos.map(([t,n]) => `- ${t}: ${n}`).join('\n') || '- Nenhum dado'}

=== ACUMULADO ${anoNum} ===
Total de solicitações: ${statsAno.total}
Concluídas: ${statsAno.concluidos}
Canceladas: ${statsAno.cancelados}
Em andamento: ${statsAno.andamento}
Dentro do SLA: ${statsAno.dentroSLA} | Fora do SLA: ${statsAno.foraSLA}
SLA acumulado: ${statsAno.sla}% (meta: 93%)
Tempo médio de conclusão: ${statsAno.tempoMedio ? statsAno.tempoMedio + ' dias' : 'N/D'}

Top tipos de solicitação no ano:
${statsAno.topTipos.map(([t,n]) => `- ${t}: ${n}`).join('\n') || '- Nenhum dado'}

Fontes: Pipefy (${pipefyCards.length} registros históricos) + Firebase (${firebaseCards.length} chamados do app)
    `.trim();

    // 6. Gera relatório com IA
    const prompt = `Você é um analista executivo de Facilities da LogComex. Gere um relatório mensal executivo, direto e objetivo, no estilo de um CFO report — linguagem de negócio, sem drama, sem exageros, focado em dados e tendências.

REGRAS DE ESTILO:
- Tom neutro e profissional, como um email executivo para diretoria
- Frases curtas e diretas, sem bullet points excessivos
- Evite palavras como "crítico", "alarmante", "grave" para situações normais
- Quando SLA ≥ 93%: destaque positivamente de forma sutil
- Quando SLA < 93%: mencione como ponto de atenção sem dramatizar
- Máximo 500 palavras no total
- Use markdown: ## para seções, **negrito** para números importantes
- Compare mês atual com acumulado do ano para mostrar tendência

ESTRUTURA OBRIGATÓRIA:

## ${mesNome}/${anoNum} — Resumo Executivo
Parágrafo único com panorama do mês e comparação com o acumulado do ano.

## Indicadores do Mês
| Indicador | ${mesNome} | Acumulado ${anoNum} |
|-----------|-------|---------|
(preencha a tabela com os dados)

## Distribuição por Tipo
Quais tipos dominaram o mês e o que indica operacionalmente (máx. 3 linhas).

## Destaques
Máx. 3 pontos objetivos: positivos e pontos de atenção.

## Próximos Passos
1-2 ações concretas para o próximo mês.

DADOS:
${contexto}

Gere o relatório:`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Erro na API Anthropic');

    const relatorio = data.content[0].text;

    return res.status(200).json({
      relatorio,
      stats: {
        total: statsMes.total,
        concluidos: statsMes.concluidos,
        abertos: statsMes.andamento,
        urgentes: 0,
        cancelados: statsMes.cancelados,
        slaGeral: statsMes.sla,
        // Acumulado
        totalAno: statsAno.total,
        slaAno: statsAno.sla,
        pipefyCards: pipefyCards.length,
        firebaseCards: firebaseCards.length,
      }
    });

  } catch (err) {
    console.error('Erro relatorio:', err);
    return res.status(500).json({ error: err.message });
  }
}
