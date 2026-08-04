// api/supabase-sync.js
// Endpoint genérico de espelhamento pro Supabase (fase de transição).
// Recebe {table, id, conflict, fields} e faz um upsert. Usado pelo
// formulário público e pelo admin, SEMPRE depois de uma escrita já ter
// sido feita com sucesso no Firestore — isso nunca é a fonte de verdade,
// só uma cópia, então falhar aqui nunca deve travar o fluxo de quem chama.

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Tabelas que este endpoint tem permissão de tocar — trava simples pra
// não virar uma porta aberta pra escrever em qualquer tabela do banco.
const TABELAS_PERMITIDAS = new Set(['tickets', 'tickets_historico']);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return res.status(500).json({ ok: false, error: 'Supabase não configurado' });
  }

  const { table, conflict, rows, action, id } = req.body || {};
  if (!table || !TABELAS_PERMITIDAS.has(table)) {
    return res.status(400).json({ ok: false, error: 'Tabela não permitida' });
  }

  try {
    if (action === 'delete') {
      if (!id) return res.status(400).json({ ok: false, error: 'id obrigatório pra excluir' });
      const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}?id=eq.${encodeURIComponent(id)}`, {
        method: 'DELETE',
        headers: {
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        },
      });
      if (!r.ok) {
        const errText = await r.text();
        console.warn('supabase-sync (delete) falhou:', r.status, errText);
        return res.status(200).json({ ok: false, error: errText });
      }
      return res.status(200).json({ ok: true });
    }

    if (!Array.isArray(rows) || !rows.length) {
      return res.status(400).json({ ok: false, error: 'rows vazio ou inválido' });
    }
    const query = conflict ? `?on_conflict=${encodeURIComponent(conflict)}` : '';
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${table}${query}`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify(rows),
    });
    if (!r.ok) {
      const errText = await r.text();
      console.warn('supabase-sync falhou:', r.status, errText);
      return res.status(200).json({ ok: false, error: errText }); // 200 de propósito: nunca deve travar quem chamou
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.warn('supabase-sync erro:', e.message);
    return res.status(200).json({ ok: false, error: e.message }); // idem
  }
}
