// api/relatorio.js
// Gera relatório executivo a partir de stats pré-calculados no frontend
// O frontend já busca do Pipefy e manda os dados prontos para evitar timeout

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY não configurado' });

  const { tickets, mes, ano, stats: statsExterno } = req.body;
  const mesNum = parseInt(mes) || new Date().getMonth() + 1;
  const anoNum = parseInt(ano) || new Date().getFullYear();
  const mesNome = MESES[mesNum - 1];

  const CATLABELS = {
    manutencao: 'Manutenção', infraestrutura: 'Infraestrutura', limpeza: 'Limpeza',
    seguranca: 'Segurança', brindes: 'Brindes', suprimentos: 'Suprimentos',
    plataformas: 'Plataformas', outros: 'Outros'
  };

  try {
    let statsMes, statsAno;

    if (statsExterno) {
      // Frontend mandou stats pré-calculados do Pipefy — usa direto
      statsMes = statsExterno.mes;
      statsAno = statsExterno.ano;
    } else {
      // Fallback: calcula a partir dos tickets Firebase
      const ticketsList = Array.isArray(tickets) ? tickets : [];

      const doMes = ticketsList.filter(t => {
        const d = new Date(t.data_abertura?.toDate ? t.data_abertura.toDate() : (t.data_abertura || 0));
        return d.getMonth() + 1 === mesNum && d.getFullYear() === anoNum;
      });
      const doAno = ticketsList.filter(t =>
        new Date(t.data_abertura?.toDate ? t.data_abertura.toDate() : (t.data_abertura || 0)).getFullYear() === anoNum
      );

      function calcStats(list) {
        const total = list.length;
        const concluidos = list.filter(t => t.status === 'Concluído').length;
        const cancelados = list.filter(t => t.status === 'Cancelado').length;
        const andamento = total - concluidos - cancelados;
        // SLA real: inclui concluidos, cancelados e recusados
        const statusFechado = ['Concluido', 'Cancelado', 'Recusado'];
        const comSLA = list.filter(t => t.dentroSLA === true || t.dentroSLA === false || statusFechado.includes(t.status));
        const dentroDeSLA = comSLA.filter(t => t.dentroSLA === true || (t.dentroSLA == null && statusFechado.includes(t.status))).length;
        const sla = comSLA.length > 0 ? Math.round((dentroDeSLA / comSLA.length) * 100) : 0;
        const porTipo = {};
        list.forEach(t => {
          const tipo = CATLABELS[t.categoria] || t.tipo_pipefy || t.categoria || 'Outros';
          porTipo[tipo] = (porTipo[tipo] || 0) + 1;
        });
        const topTipos = Object.entries(porTipo).sort((a,b) => b[1]-a[1]).slice(0,6);
        return { total, concluidos, cancelados, andamento, sla, topTipos };
      }

      statsMes = calcStats(doMes.length > 0 ? doMes : ticketsList);
      statsAno = calcStats(doAno.length > 0 ? doAno : ticketsList);
    }

    const contexto = `
=== MÊS: ${mesNome}/${anoNum} ===
Total: ${statsMes.total} | Concluídas: ${statsMes.concluidos} | Canceladas: ${statsMes.cancelados} | Em andamento: ${statsMes.andamento}
SLA do mês: ${statsMes.sla}% (meta: 93%)
Top tipos: ${(statsMes.topTipos || []).map(([t,n]) => `${t}(${n})`).join(', ') || 'N/D'}

=== ACUMULADO ${anoNum} ===
Total: ${statsAno.total} | Concluídas: ${statsAno.concluidos} | Canceladas: ${statsAno.cancelados} | Em andamento: ${statsAno.andamento}
SLA acumulado: ${statsAno.sla}% (meta: 93%)
Top tipos: ${(statsAno.topTipos || []).map(([t,n]) => `${t}(${n})`).join(', ') || 'N/D'}
    `.trim();

    const prompt = `Você é analista executivo de Facilities da LogComex. Gere um relatório mensal executivo no estilo CFO report.

REGRAS: Tom neutro e profissional. Máximo 400 palavras. Sem dramatização. SLA ≥ 93% = destaque positivo. Use markdown.

ESTRUTURA OBRIGATÓRIA:

## ${mesNome}/${anoNum} — Resumo Executivo
Parágrafo único com panorama do mês vs acumulado.

## Indicadores
| Indicador | ${mesNome} | Acumulado ${anoNum} |
|---|---|---|
| Total | ${statsMes.total} | ${statsAno.total} |
| Concluídas | ${statsMes.concluidos} | ${statsAno.concluidos} |
| Em andamento | ${statsMes.andamento} | ${statsAno.andamento} |
| SLA | **${statsMes.sla}%** | **${statsAno.sla}%** |

## Distribuição por Tipo
2 linhas sobre os tipos que dominaram.

## Destaques
Máx. 3 pontos objetivos.

## Próximos Passos
1-2 ações concretas.

DADOS: ${contexto}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 800,
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
        totalAno: statsAno.total,
        slaAno: statsAno.sla,
      }
    });

  } catch (err) {
    console.error('Erro relatorio:', err);
    return res.status(500).json({ error: err.message });
  }
}
