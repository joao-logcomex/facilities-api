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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');

  // ── Endpoint público (sem login) para a TV do setor — "Go Live" ──
  // Ativado com ?tv=facilities. Devolve só números agregados de 2026,
  // nunca dados individuais de chamados (nome, e-mail etc).
  if (req.query && req.query.tv === 'facilities') {
    try {
      const anoAlvo = parseInt(req.query.ano) || new Date().getFullYear();
      const inicioAno = new Date(`${anoAlvo}-01-01T00:00:00.000Z`);
      const inicioProxAno = new Date(`${anoAlvo + 1}-01-01T00:00:00.000Z`);
      const [ticketsSnap, projetosSnap] = await Promise.all([
        db.collection('tickets')
          .where('data_abertura', '>=', inicioAno)
          .where('data_abertura', '<', inicioProxAno)
          .get(),
        db.collection('projetos_ia').get(),
      ]);
      const doAno = ticketsSnap.docs.map(d => d.data());
      const CATLABELS = {
        manutencao: 'Manutenção', infraestrutura: 'Infraestrutura', limpeza: 'Limpeza',
        seguranca: 'Segurança', brindes: 'Brindes', suprimentos: 'Suprimentos',
        plataformas: 'Plataformas', outros: 'Outros', logistica: 'Logística', acessos: 'Acessos'
      };
      const abertos = doAno.filter(t => !['Concluído', 'Cancelado'].includes(t.status)).length;
      const concluidos = doAno.filter(t => t.status === 'Concluído').length;
      const cancelados = doAno.filter(t => t.status === 'Cancelado').length;
      const porCategoria = contar(doAno, x => CATLABELS[x.categoria] || x.categoria || 'Outros');
      const projetos = projetosSnap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .sort((a, b) => (a.ordem || 0) - (b.ordem || 0));

      return res.status(200).json({
        ok: true,
        ano: anoAlvo,
        total: doAno.length,
        abertos, concluidos, cancelados,
        por_categoria: porCategoria,
        projetos,
        atualizado_em: new Date().toISOString(),
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
