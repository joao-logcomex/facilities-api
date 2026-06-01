// /api/slack-teste-dm.js — TEMPORÁRIO
// Força uma DM do bot pro user passado em ?user= ou padrão U09MEN4BS0N (João)
// Útil pra debugar se o bot consegue postar mensagens, sem depender do Events API.

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;

module.exports = async function handler(req, res) {
  const userId = req.query.user || 'U09MEN4BS0N';
  const passo = {};

  try {
    // Passo 1: abrir DM
    const r1 = await fetch('https://slack.com/api/conversations.open', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ users: userId })
    });
    const dm = await r1.json();
    passo.conversations_open = dm;

    if (!dm.ok) {
      return res.status(200).json({ erro: 'conversations.open falhou', ...passo });
    }

    // Passo 2: mandar mensagem teste
    const r2 = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channel: dm.channel.id,
        text: `🧪 *Teste de DM do bot* (${new Date().toISOString()})\nSe você está vendo essa mensagem, o bot consegue te enviar DMs!`,
      })
    });
    const msg = await r2.json();
    passo.chat_postMessage = msg;

    res.status(200).json({ ok: msg.ok, dm_channel: dm.channel.id, ...passo });
  } catch (err) {
    res.status(500).json({ erro: err.message, stack: err.stack, ...passo });
  }
};
