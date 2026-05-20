// api/notify-slack.js
// Notificações Slack: conclusão, rastreio DHL, aprovação/recusa de brindes

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  if (!SLACK_BOT_TOKEN) return res.status(500).json({ error: 'SLACK_BOT_TOKEN não configurado' });

  const {
    tipo, ticket, ticketId, titulo, categoria,
    solicitanteEmail, solicitanteNome, dataAbertura,
    email, nome, transportadora, rastreio, item,
    itens, aprovado, motivo
  } = req.body;

  const emailAlvo = solicitanteEmail || email;
  if (!emailAlvo) return res.status(400).json({ error: 'email obrigatório' });
  const nomeAlvo = solicitanteNome || nome || emailAlvo.split('@')[0];
  const ticketNum = ticket || ticketId || '—';

  try {
    // 1. Buscar usuário Slack
    const userRes = await fetch(
      `https://slack.com/api/users.lookupByEmail?email=${encodeURIComponent(emailAlvo)}`,
      { headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` } }
    );
    const userData = await userRes.json();
    if (!userData.ok) return res.status(404).json({ error: `Usuário não encontrado: ${userData.error}` });
    const slackUserId = userData.user.id;

    // 2. Abrir DM
    const dmRes = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ users: slackUserId }),
    });
    const dmData = await dmRes.json();
    if (!dmData.ok) return res.status(500).json({ error: `Erro ao abrir DM: ${dmData.error}` });
    const channelId = dmData.channel.id;

    let blocks, text;

    // ── APROVAÇÃO / RECUSA DE BRINDE ────────────────────────
    if (tipo === 'aprovacao_brinde') {
      if (aprovado) {
        text = `✅ Sua solicitação de brinde ${ticketNum} foi aprovada!`;
        blocks = [
          { type: 'header', text: { type: 'plain_text', text: '✅ Brinde Aprovado!', emoji: true } },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `Boa notícia, *${nomeAlvo}*! Sua solicitação de brinde foi *aprovada* pelo gestor e já foi encaminhada para o time de Facilities. 🎁` }
          },
          { type: 'divider' },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Chamado:*\n${ticketNum}` },
              { type: 'mrkdwn', text: `*Status:*\nEm andamento ✅` },
              ...(titulo ? [{ type: 'mrkdwn', text: `*Solicitação:*\n${titulo}` }] : []),
              ...(itens ? [{ type: 'mrkdwn', text: `*Itens:*\n${itens}` }] : []),
            ]
          },
          { type: 'divider' },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: '🏢 *Facilities LogComex* • Dúvidas? Abra um chamado em facilities-api.vercel.app' }]
          }
        ];
      } else {
        text = `❌ Sua solicitação de brinde ${ticketNum} foi recusada.`;
        blocks = [
          { type: 'header', text: { type: 'plain_text', text: '❌ Solicitação Recusada', emoji: true } },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: `Olá, *${nomeAlvo}*. Infelizmente sua solicitação de brinde *não foi aprovada* pelo gestor.` }
          },
          { type: 'divider' },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Chamado:*\n${ticketNum}` },
              ...(titulo ? [{ type: 'mrkdwn', text: `*Solicitação:*\n${titulo}` }] : []),
              ...(motivo ? [{ type: 'mrkdwn', text: `*Motivo:*\n${motivo}` }] : []),
            ]
          },
          {
            type: 'section',
            text: { type: 'mrkdwn', text: 'Se tiver dúvidas, entre em contato com o time de Facilities.' }
          },
          { type: 'divider' },
          {
            type: 'context',
            elements: [{ type: 'mrkdwn', text: '🏢 *Facilities LogComex* • facilities-api.vercel.app' }]
          }
        ];
      }
    }

    // ── RASTREIO DHL ────────────────────────────────────────
    else if (tipo === 'rastreio') {
      const transp = transportadora || 'DHL';
      const trackUrl = transp === 'DHL'
        ? `https://www.dhl.com/br-pt/home/tracking.html?tracking-id=${rastreio}`
        : null;
      text = `📦 Código de rastreio do seu envio: ${rastreio}`;
      blocks = [
        { type: 'header', text: { type: 'plain_text', text: '📦 Seu envio está a caminho!', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `Olá, *${nomeAlvo}*! Seu envio via *${transp}* foi processado. 🚚` } },
        { type: 'divider' },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Chamado:*\n${ticketNum}` },
            { type: 'mrkdwn', text: `*Transportadora:*\n${transp}` },
            ...(item ? [{ type: 'mrkdwn', text: `*Item:*\n${item}` }] : []),
          ]
        },
        { type: 'section', text: { type: 'mrkdwn', text: `📋 *Código de rastreio:*\n\`${rastreio}\`` } },
        ...(trackUrl ? [{ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '🔍 Rastrear meu envio', emoji: true }, url: trackUrl, style: 'primary' }] }] : []),
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '🏢 *Facilities LogComex* • facilities-api.vercel.app' }] }
      ];
    }

    // ── CONCLUSÃO DE CHAMADO ────────────────────────────────
    else {
      let dataFormatada = dataAbertura;
      try {
        const d = new Date(dataAbertura);
        dataFormatada = d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'numeric' });
      } catch {}
      const feedbackUrl = `https://facilities-api.vercel.app/?feedback=${encodeURIComponent(ticketId || ticket || '')}`;
      text = `✅ Chamado concluído!`;
      blocks = [
        { type: 'header', text: { type: 'plain_text', text: '✅ Chamado Concluído!', emoji: true } },
        { type: 'section', text: { type: 'mrkdwn', text: `Olá, *${nomeAlvo}*! Seu chamado foi resolvido pelo time de Facilities. 🎉` } },
        { type: 'divider' },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Chamado:*\n${ticketId || ticket || '—'}` },
            { type: 'mrkdwn', text: `*Categoria:*\n${categoria || '—'}` },
            { type: 'mrkdwn', text: `*Título:*\n${titulo || '—'}` },
            { type: 'mrkdwn', text: `*Aberto em:*\n${dataFormatada || '—'}` },
          ]
        },
        { type: 'divider' },
        { type: 'section', text: { type: 'mrkdwn', text: '💬 *Como foi o atendimento?* Sua avaliação nos ajuda a melhorar!' } },
        { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: '⭐ Avaliar atendimento', emoji: true }, url: feedbackUrl, style: 'primary' }] },
        { type: 'divider' },
        { type: 'context', elements: [{ type: 'mrkdwn', text: '🏢 *Facilities LogComex* • facilities-api.vercel.app' }] }
      ];
    }

    // 3. Enviar DM
    const msgRes = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: channelId,
        username: 'Facilities LogComex',
        icon_emoji: tipo === 'aprovacao_brinde' ? (aprovado ? ':white_check_mark:' : ':x:') : tipo === 'rastreio' ? ':package:' : ':white_check_mark:',
        text,
        blocks,
      }),
    });
    const msgData = await msgRes.json();
    if (!msgData.ok) return res.status(500).json({ error: `Erro ao enviar mensagem: ${msgData.error}` });

    return res.status(200).json({ success: true, message: `Notificação enviada para ${emailAlvo}` });

  } catch (err) {
    console.error('Erro notify-slack:', err);
    return res.status(500).json({ error: err.message });
  }
}
