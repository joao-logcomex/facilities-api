// api/relatorio.js
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurado' });

  const { tickets, mes, ano } = req.body;
  if (!tickets) return res.status(400).json({ error: 'tickets obrigatório' });

  const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  const mesNome = MESES[(mes || 1) - 1];

  const CATLABELS = {
    manutencao: 'Manutenção', infraestrutura: 'Infraestrutura', limpeza: 'Limpeza',
    seguranca: 'Segurança', brindes: 'Brindes', suprimentos: 'Suprimentos', plataformas: 'Plataformas'
  };

  // Calcula stats
  const total = tickets.length;
  const concluidos = tickets.filter(t => t.status === 'Concluído').length;
  const abertos = tickets.filter(t => t.status === 'Aberto').length;
  const urgentes = tickets.filter(t => t.prioridade === 'Urgente').length;
  const cancelados = tickets.filter(t => t.status === 'Cancelado').length;
  const slaGeral = (concluidos + cancelados) > 0 ? Math.round((concluidos / (concluidos + cancelados)) * 100) : 0;

  // Agrupa por categoria
  const porCategoria = {};
  tickets.forEach(t => {
    const cat = CATLABELS[t.categoria] || t.categoria || 'Outros';
    porCategoria[cat] = (porCategoria[cat] || 0) + 1;
  });

  // Agrupa por CC
  const porCC = {};
  tickets.forEach(t => {
    if (t.departamento) porCC[t.departamento] = (porCC[t.departamento] || 0) + 1;
  });
  const topCC = Object.entries(porCC).sort((a,b) => b[1]-a[1]).slice(0,5);

  const statsTexto = `
DADOS DO MÊS: ${mesNome}/${ano}
- Total de solicitações: ${total}
- Concluídas: ${concluidos}
- Em aberto: ${abertos}
- Canceladas: ${cancelados}
- Urgentes: ${urgentes}
- SLA (concluídas / concluídas+canceladas): ${slaGeral}%
- Meta de SLA: 93%

POR CATEGORIA:
${Object.entries(porCategoria).map(([k,v]) => `- ${k}: ${v} (${Math.round(v/total*100)}%)`).join('\n')}

TOP CENTROS DE CUSTO:
${topCC.map(([cc,n]) => `- ${cc}: ${n} solicitações`).join('\n') || '- Não informado'}
  `.trim();

  const prompt = `Você é um analista executivo de Facilities da LogComex. Gere um relatório mensal executivo, direto e objetivo, no estilo de um CFO report — linguagem de negócio, sem drama, sem exageros, focado em dados e tendências.

REGRAS DE ESTILO:
- Tom neutro e profissional, como um email executivo
- Frases curtas e diretas
- Evite palavras como "crítico", "alarmante", "grave", "urgente" para descrever situações normais
- Quando o SLA está acima de 93%, destaque positivamente de forma sutil
- Quando abaixo de 93%, mencione como ponto de atenção sem dramatizar
- Não use bullet points excessivos — prefira parágrafos curtos
- Máximo 400 palavras no total
- Use markdown simples: ## para seções, **negrito** para números importantes

ESTRUTURA OBRIGATÓRIA:
## Resumo do Mês
Um parágrafo com o panorama geral do mês em linguagem executiva.

## Indicadores
Tabela ou lista limpa com: Total | Concluídas | Em aberto | SLA% | Meta

## Distribuição por Tipo
Quais tipos de solicitação mais apareceram e o que isso indica operacionalmente.

## Destaques
Máximo 2-3 pontos: o que foi bem, o que merece atenção. Sem exageros.

## Próximos Passos
1-2 ações concretas e realistas para o próximo mês.

DADOS:
${statsTexto}

Gere o relatório agora:`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-opus-4-6',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || 'Erro na API Anthropic');

    const relatorio = data.content[0].text;

    return res.status(200).json({
      relatorio,
      stats: { total, concluidos, abertos, urgentes, cancelados, slaGeral }
    });

  } catch (err) {
    console.error('Erro relatorio:', err);
    return res.status(500).json({ error: err.message });
  }
}
