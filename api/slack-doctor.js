// /api/slack-doctor.js — TEMPORÁRIO
// Diagnóstico passo-a-passo do fluxo Slack DM
// Testa: env vars, Firebase, IA Claude, Slack postMessage
//
// USO: curl https://facilities-api.vercel.app/api/slack-doctor

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}
const db = admin.firestore();

module.exports = async function handler(req, res) {
  const r = { now: new Date().toISOString(), passos: {} };

  // 1. Env vars presentes?
  r.passos['1_env_vars'] = {
    SLACK_BOT_TOKEN: !!process.env.SLACK_BOT_TOKEN,
    ANTHROPIC_API_KEY: !!process.env.ANTHROPIC_API_KEY,
    FIREBASE_PROJECT_ID: !!process.env.FIREBASE_PROJECT_ID,
    FIREBASE_CLIENT_EMAIL: !!process.env.FIREBASE_CLIENT_EMAIL,
    FIREBASE_PRIVATE_KEY: !!process.env.FIREBASE_PRIVATE_KEY,
  };

  // 2. Firebase write/read
  try {
    const t0 = Date.now();
    await db.collection('slack_doctor_tests').doc('teste').set({ at: new Date(), value: 'ok' });
    const doc = await db.collection('slack_doctor_tests').doc('teste').get();
    r.passos['2_firebase'] = { ok: doc.exists, duration_ms: Date.now() - t0 };
  } catch (e) {
    r.passos['2_firebase'] = { ok: false, error: e.message };
  }

  // 3. Anthropic API
  try {
    const t0 = Date.now();
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 50,
        messages: [{ role: 'user', content: 'Diga apenas: ok' }]
      })
    });
    const data = await resp.json();
    r.passos['3_anthropic'] = {
      status: resp.status,
      duration_ms: Date.now() - t0,
      ok: resp.ok,
      content: data?.content?.[0]?.text || null,
      error: data?.error || null,
    };
  } catch (e) {
    r.passos['3_anthropic'] = { ok: false, error: e.message };
  }

  // 4. Slack API (auth.test)
  try {
    const t0 = Date.now();
    const resp = await fetch('https://slack.com/api/auth.test', {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });
    const data = await resp.json();
    r.passos['4_slack_auth'] = {
      ok: data.ok,
      duration_ms: Date.now() - t0,
      bot_id: data.bot_id,
      user_id: data.user_id,
      team: data.team,
      error: data.error,
    };
  } catch (e) {
    r.passos['4_slack_auth'] = { ok: false, error: e.message };
  }

  // 5. Buscar usuário João + abrir DM
  let dmChannel = null;
  try {
    const t0 = Date.now();
    const u = await fetch('https://slack.com/api/users.lookupByEmail?email=joao.faria@logcomex.com', {
      headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}` }
    });
    const ud = await u.json();
    if (ud.ok && ud.user) {
      const dm = await fetch('https://slack.com/api/conversations.open', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ users: ud.user.id })
      });
      const dmData = await dm.json();
      dmChannel = dmData.channel?.id;
      r.passos['5_slack_dm'] = {
        ok: dmData.ok,
        duration_ms: Date.now() - t0,
        user_id: ud.user.id,
        dm_channel: dmChannel,
      };
    } else {
      r.passos['5_slack_dm'] = { ok: false, error: ud.error };
    }
  } catch (e) {
    r.passos['5_slack_dm'] = { ok: false, error: e.message };
  }

  // 6. (opcional) postMessage de teste
  if (req.query.post === '1' && dmChannel) {
    try {
      const t0 = Date.now();
      const msg = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel: dmChannel,
          text: `🩺 Doctor test: ${new Date().toISOString()}`
        })
      });
      const msgData = await msg.json();
      r.passos['6_post_msg'] = { ok: msgData.ok, duration_ms: Date.now() - t0, error: msgData.error };
    } catch (e) {
      r.passos['6_post_msg'] = { ok: false, error: e.message };
    }
  }

  // 7. Cleanup
  try { await db.collection('slack_doctor_tests').doc('teste').delete(); } catch {}

  res.status(200).json(r);
};
