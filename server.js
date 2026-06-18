const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const CLAUDE_KEY = process.env.CLAUDE_KEY;
const SUPA_URL = "https://kjwfzsouoeolycekyldd.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtqd2Z6c291b2VvbHljZWt5bGRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMjcxODksImV4cCI6MjA5NjcwMzE4OX0.aRWc4yBiWx7W8NjQIcHn7JvxAqDho0fnvdzKSndOUDU";

let sock = null;
let qrAtual = null;
let statusConexao = 'desconectado';
const historicos = {};

const SYSTEM = `Você é a FarmaBot, assistente farmacêutica virtual da UBS de Trindade-GO.
Criada pela farmacêutica Vanessa, Diretora de Assistência Farmacêutica do município.
PERFIL: Idosos com HAS/DM, polimedicados, baixa escolaridade.
REGRAS ABSOLUTAS:
- Linguagem simples, acolhedora, sem termos técnicos
- Máximo 3 parágrafos curtos
- Nunca altere doses ou prescrições
- Não confirme disponibilidade de medicamentos (diga que vai verificar com o farmacêutico)
- Emergências: oriente SAMU 192 imediatamente
- Só medicamentos do SUS/REMUME de Trindade-GO`;

// ── Buscar paciente no Supabase ───────────────────────────────────────────────
async function buscarPaciente(telefone) {
  try {
    const num = telefone.replace(/\D/g, '').slice(-11);
    const res = await fetch(
      `${SUPA_URL}/rest/v1/farmabot_pacientes?telefone=eq.${num}&limit=1`,
      { headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` } }
    );
    const data = await res.json();
    return data?.[0] || null;
  } catch { return null; }
}

// ── Salvar conversa pendente no Supabase ──────────────────────────────────────
async function salvarPendencia(pacienteNome, numero, mensagem) {
  try {
    const hora = new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
    await fetch(`${SUPA_URL}/rest/v1/farmabot_conversas`, {
      method: 'POST',
      headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({
        id: `wa_${Date.now()}`,
        paciente: pacienteNome || numero,
        numero: numero.replace(/\D/g,'').slice(-11),
        msgs: [
          { tipo:'paciente', texto:mensagem, hora },
          { tipo:'bot', texto:'Mensagem encaminhada ao farmacêutico. ⏳', hora }
        ],
        pendente: true,
        hora
      })
    });
  } catch(e) { console.error('Erro salvar pendência:', e.message); }
}

// ── Enviar mensagem WhatsApp ───────────────────────────────────────────────────
async function enviarMensagem(jid, texto) {
  if (!sock) return;
  try {
    await sock.sendMessage(jid, { text: texto });
    console.log(`✉️ Enviado para ${jid}`);
  } catch(e) {
    console.error('Erro enviar mensagem:', e.message);
  }
}

// ── Inicializar Baileys ────────────────────────────────────────────────────────
async function iniciarBaileys() {
  const AUTH_DIR = path.join('/tmp', 'farmabot_auth');
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const logger = pino({ level: 'silent' });

  sock = makeWASocket({
    version,
    auth: state,
    logger,
    printQRInTerminal: false,
    browser: ['FarmaBot SUS', 'Chrome', '1.0.0'],
    connectTimeoutMs: 60000,
    keepAliveIntervalMs: 30000,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('📱 QR Code gerado — acesse /qr');
      qrAtual = qr;
      statusConexao = 'aguardando_qr';
    }

    if (connection === 'close') {
      const shouldReconnect = (lastDisconnect?.error instanceof Boom)
        ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
        : true;
      console.log('Conexão fechada. Reconectar:', shouldReconnect);
      statusConexao = 'desconectado';
      qrAtual = null;
      if (shouldReconnect) {
        setTimeout(iniciarBaileys, 5000);
      }
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado via Baileys!');
      statusConexao = 'conectado';
      qrAtual = null;
    }
  });

  // ── Processar mensagens recebidas ──────────────────────────────────────────
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (msg.key.remoteJid?.includes('@g.us')) continue; // ignorar grupos

      const jid = msg.key.remoteJid;
      const texto = msg.message?.conversation ||
                    msg.message?.extendedTextMessage?.text ||
                    msg.message?.imageMessage?.caption || '';

      if (!texto.trim()) continue;

      const telefone = jid.replace('@s.whatsapp.net', '').replace(/^55/, '');
      console.log(`📩 ${telefone}: ${texto}`);

      // Emergência
      const ehEmergencia = ['dor no peito','falta de ar','desmaio','pressão muito alta','convulsão','infarto','avc','sangramento']
        .some(g => texto.toLowerCase().includes(g));
      if (ehEmergencia) {
        await enviarMensagem(jid, '🚨 *ATENÇÃO!* Pelos sintomas que descreveu, ligue *AGORA* para o SAMU: *192*\n\nNão espere — sua saúde é prioridade!\n\nSe não conseguir ligar, peça para alguém levar você à UPA mais próxima.');
        continue;
      }

      // Pergunta sobre estoque/disponibilidade → farmacêutico
      const ehEstoque = ['tem esse','tem o remédio','tem remedio','disponível','disponivel','acabou','faltou','buscar remédio','retirar','pegar remédio','estoque','medicamento disponível']
        .some(g => texto.toLowerCase().includes(g));
      if (ehEstoque) {
        const paciente = await buscarPaciente(telefone);
        await salvarPendencia(paciente?.nome, jid, texto);
        await enviarMensagem(jid, 'Sua dúvida sobre disponibilidade de medicamento foi encaminhada para o farmacêutico da sua UBS. ⏳\n\nEm breve você receberá uma resposta. Para emergências ligue para o SAMU: 192.');
        continue;
      }

      // IA responde
      if (!historicos[jid]) historicos[jid] = [];
      historicos[jid].push({ role: 'user', content: texto });
      if (historicos[jid].length > 10) historicos[jid] = historicos[jid].slice(-10);

      try {
        const paciente = await buscarPaciente(telefone);
        const contextoPaciente = paciente
          ? `\nPACIENTE IDENTIFICADO: ${paciente.nome}, ${paciente.idade} anos. Condições: ${(paciente.condicoes||[]).join(', ')}. Medicamentos: ${(paciente.medicamentos||[]).map(m=>`${m.nome} (${m.dose})`).join('; ')}.`
          : '';

        const res = await fetch('https://kjwfzsouoeolycekyldd.supabase.co/functions/v1/rapid-handler', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${SUPA_KEY}`, 'apikey': SUPA_KEY },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            system: SYSTEM + contextoPaciente,
            messages: historicos[jid]
          })
        });
        const dados = await res.json();
        const resposta = dados.content?.[0]?.text || 'Desculpe, tive um problema. Tente novamente em instantes.';
        historicos[jid].push({ role: 'assistant', content: resposta });
        await enviarMensagem(jid, resposta);
      } catch(e) {
        console.error('Erro IA:', e.message);
        await enviarMensagem(jid, 'Desculpe, estou com dificuldades técnicas no momento. Para dúvidas urgentes, ligue para sua UBS ou SAMU 192.');
      }
    }
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

// QR Code para conectar
app.get('/qr', async (req, res) => {
  if (statusConexao === 'conectado') {
    return res.send(`
      <html><body style="background:#054d38;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif">
      <div style="font-size:60px;margin-bottom:16px">✅</div>
      <h2 style="color:#fff;margin-bottom:8px">WhatsApp Conectado!</h2>
      <p style="color:rgba(255,255,255,0.7)">FarmaBot SUS está online e respondendo mensagens.</p>
      </body></html>
    `);
  }
  if (qrAtual) {
    try {
      const qrImagem = await QRCode.toDataURL(qrAtual, { width: 300, margin: 2 });
      return res.send(`
        <html><body style="background:#054d38;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif">
        <h2 style="color:#fff;margin-bottom:4px">📱 Conectar FarmaBot SUS</h2>
        <p style="color:rgba(255,255,255,0.7);margin-bottom:20px;text-align:center">Abra o WhatsApp → Dispositivos conectados → Conectar dispositivo</p>
        <img src="${qrImagem}" style="width:280px;border-radius:16px;background:#fff;padding:12px"/>
        <p style="color:rgba(255,255,255,0.5);margin-top:16px;font-size:13px">Esta página atualiza automaticamente a cada 15 segundos</p>
        <script>setTimeout(()=>location.reload(),15000)</script>
        </body></html>
      `);
    } catch(e) {
      return res.send('<html><body style="background:#054d38;color:#fff;font-family:sans-serif;padding:40px"><h2>Gerando QR Code... aguarde e recarregue a página.</h2></body></html>');
    }
  }
  res.send(`
    <html><body style="background:#054d38;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif">
    <div style="font-size:48px;margin-bottom:16px">⏳</div>
    <h2 style="color:#fff">Aguardando QR Code...</h2>
    <p style="color:rgba(255,255,255,0.7)">Status: ${statusConexao}</p>
    <p style="color:rgba(255,255,255,0.5);font-size:13px">Esta página atualiza em 5 segundos</p>
    <script>setTimeout(()=>location.reload(),5000)</script>
    </body></html>
  `);
});

// Status
app.get('/', (req, res) => {
  res.json({
    status: statusConexao === 'conectado' ? '✅ FarmaBot WhatsApp Online!' : `⏳ ${statusConexao}`,
    municipio: 'Trindade-GO — DAF',
    versao: '2.0.0',
    qr_url: statusConexao !== 'conectado' ? '/qr' : null
  });
});

// Enviar mensagem manualmente (para respostas do farmacêutico)
app.post('/enviar', async (req, res) => {
  const { numero, mensagem } = req.body;
  if (!sock || statusConexao !== 'conectado') {
    return res.status(503).json({ erro: 'WhatsApp não conectado. Acesse /qr para conectar.' });
  }
  try {
    const jid = `55${numero.replace(/\D/g,'')}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: mensagem });
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── Iniciar servidor ──────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ FarmaBot SUS rodando na porta ${PORT}`);
  console.log(`📱 Acesse /qr para conectar o WhatsApp`);
  console.log(`Município: Trindade-GO | DAF`);
  iniciarBaileys();
});
