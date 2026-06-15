// api/sync-pipefy-periodo.js
// Sincroniza cards do Pipefy de um periodo especifico para o Firebase

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

function getDB() {
  if (!getApps().length) {
    initializeApp({ credential: cert({ projectId: process.env.FIREBASE_PROJECT_ID, clientEmail: process.env.FIREBASE_CLIENT_EMAIL, privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n') }) });
  }
  return getFirestore();
}

const CAT_MAP = { 'Suprimentos de escritorio': 'suprimentos', 'Manutencao': 'manutencao', 'Brinde': 'brindes', 'Recebimento de Encomendas': 'outros', 'Elogios ou Sugestoes': 'outros', 'Acessos': 'plataformas', 'Logistica': 'logistica', 'Reforma': 'reforma', 'Seguranca': 'seguranca' };
const FASE_STATUS = { 'Solicitacoes': 'Aberto', 'Aprovacao Gestor CS': 'Aguardando aprovacao', 'Brinde': 'Aguardando aprovacao', 'Brinde Comercial': 'Aguardando aprovacao', 'Brinde Coleta': 'Em andamento', 'Acessos': 'Em andamento', 'Suprimentos de escritorio': 'Em andamento', 'Manutencao': 'Em andamento', 'Recebimento de Encomendas': 'Concluido', 'Elogios ou Sugestoes': 'Concluido', 'Solicitacoes concluidas': 'Concluido', 'Solicitacoes Canceladas': 'Cancelado' };
const SLA_DIAS = { brindes: 5, suprimentos: 7, manutencao: 60, reforma: 60, seguranca: 2, logistica: 3, outros: 7, infraestrutura: 7, limpeza: 7, plataformas: 3, gestao: 7 };

async function pipefyQuery(query, token) {
  const r = await fetch('https://api.pipefy.com/graphql', { method: 'POST', headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ query }) });
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();
  const { dataInicio, dataFim } = req.body;
  if (!dataInicio || !dataFim) return res.status(400).json({ error: 'dataInicio e dataFim obrigatorios (YYYY-MM-DD)' });
  const TOKEN = process.env.PIPEFY_TOKEN;
  if (!TOKEN) return res.status(500).json({ error: 'PIPEFY_TOKEN nao configurado' });
  const db = getDB();
  const inicio = new Date(dataInicio + 'T00:00:00Z');
  const fim = new Date(dataFim + 'T23:59:59Z');
  let totalSalvos = 0, totalEncontrados = 0;
  const erros = [];
  const dadosFases = await pipefyQuery('{ pipe(id: "304316750") { phases { id name } } }', TOKEN);
  const fases = dadosFases?.data?.pipe?.phases || [];
  for (const fase of fases) {
    let cursor = null, pagina = 0;
    const faseStatus = FASE_STATUS[fase.name] || 'Em andamento';
    while (pagina < 50) {
      const after = cursor ? ', after: "' + cursor + '"' : '';
      const q = '{ phase(id: "' + fase.id + '") { cards(first: 50' + after + ') { edges { node { id title created_at finished_at fields { name value } } } pageInfo { hasNextPage endCursor } } } }';
      let data;
      try { data = await pipefyQuery(q, TOKEN); } catch(e) { erros.push(fase.name + ': ' + e.message); break; }
      const edges = data?.data?.phase?.cards?.edges || [];
      const pageInfo = data?.data?.phase?.cards?.pageInfo;
      for (const edge of edges) {
        const node = edge.node;
        const createdAt = new Date(node.created_at);
        if (createdAt < inicio || createdAt > fim) continue;
        totalEncontrados++;
        const tipo = node.fields?.find(f => f.name === 'Tipo de solicitacao')?.value || fase.name;
        const descricao = node.fields?.find(f => f.name === 'Descricao do problema ou necessidade')?.value || '';
        const nomeField = node.fields?.find(f => f.name === 'Nome')?.value || '';
        const emailField = node.fields?.find(f => f.name === 'E-mail')?.value || '';
        const categoria = CAT_MAP[tipo] || 'outros';
        const diasSLA = SLA_DIAS[categoria] || 7;
        let dentroSLA = null;
        if (node.finished_at) { const diasGastos = (new Date(node.finished_at) - createdAt) / 86400000; dentroSLA = diasGastos <= diasSLA; }
        try {
          await db.collection('tickets').doc('pipefy-' + node.id).set({ id: 'pipefy-' + node.id, titulo: node.title || 'Sem titulo', descricao, nome: nomeField, email: emailField, categoria, tipo_pipefy: tipo, fase_pipefy: fase.name, status: faseStatus, data_abertura: createdAt, data_conclusao: node.finished_at ? new Date(node.finished_at) : null, origem: 'pipefy', dentroSLA, syncedAt: new Date() }, { merge: true });
          totalSalvos++;
        } catch(e) { erros.push('Card ' + node.id + ': ' + e.message); }
      }
      if (!pageInfo?.hasNextPage) break;
      cursor = pageInfo.endCursor;
      pagina++;
    }
  }
  return res.status(200).json({ ok: true, periodo: dataInicio + ' a ' + dataFim, encontrados: totalEncontrados, salvos: totalSalvos, erros: erros.slice(0, 10) });
}