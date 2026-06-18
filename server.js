const wppconnect = require('@wppconnect-team/wppconnect');
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3001;
const CLAUDE_KEY = process.env.CLAUDE_KEY;
const SUPA_URL = "https://kjwfzsouoeolycekyldd.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtqd2Z6c291b2VvbHljZWt5bGRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMjcxODksImV4cCI6MjA5NjcwMzE4OX0.aRWc4yBiWx7W8NjQIcHn7JvxAqDho0fnvdzKSndOUDU";

let clienteWpp = null;
let statusConexao = 'desconectado';
const historicos = {};

const SYSTEM = `Você é a FarmaBot, assistente farmacêutica virtual da UBS de Trindade-GO.
Criada pela farmacêutica Vanessa, Diretora de Assistência Farmacêutica.
PERFIL: Idosos com HAS/DM, polimedicados, baixa escolaridade.
REGRAS: Linguagem simples e acolhedora. Máx 3 parágrafos. Nunca altere doses.
Perguntas sobre disponibilidade de medicamento: diga que vai verificar com o farmacêutico.
Emergências: SAMU 192. Só medicamentos do SUS/REMUME.`;

// Buscar paciente pelo telefone no Supabase
async function buscarPaciente(telefone) {
  try {
    const num = telefone.replace(/\D/g, '').replace(/^55/, '').slice(-11);
    const res = await fetch(
      `${SUPA_URL}/rest/v1/farmabot_pacientes?telefone=eq.${num}&limit=1`,
      { headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` } }
    );
    const data = await res.json();
    return data?.[0] || null;
  } catch { return null; }
}

// Salvar conversa pendente no Supabase
async function salvarPendencia(pacienteNome, numero, mensagem) {
  try {
    const hora = new Date().toLocaleTimeString('pt-BR', {hour:'2-digit', minute:'2-digit'});
    const conv = {
      id: `wa_${Date.now()}`,
      paciente: pacienteNome || numero,
      numero: numero.replace('@c.us', '').replace('55', ''),
      msgs: [
        { tipo:'paciente', texto:mensagem, hora },
        { tipo:'bot', texto:'Mensagem encaminhada ao farmacêutico. ⏳', hora }
      ],
      pendente: true,
      hora
    };
    await fetch(`${SUPA_URL}/rest/v1/farmabot_conversas`, {
      method: 'POST',
      headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify(conv)
    });
  } catch(e) { console.error('Erro ao salvar pendência:', e.message); }
}

// Inicializar WPPConnect
async function iniciarWpp() {
  try {
    console.log('🔄 Iniciando WPPConnect...');
    const cliente = await wppconnect.create({
      session: 'farmabot-trindade',
      catchQR: (base64Qr) => {
        console.log('📱 QR CODE gerado — acesse /qr para ver');
        global.qrCodeAtual = base64Qr;
        statusConexao = 'aguardando_qr';
      },
      statusFind: (statusSession) => {
        console.log('Status WPP:', statusSession);
        statusConexao = statusSession;
      },
      headless: true,
      logQR: false,
      browserArgs: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu'
      ],
      puppeteerOptions: {
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage'
        ]
      }
    });

    clienteWpp = cliente;
    statusConexao = 'conectado';
    console.log('✅ WhatsApp conectado!');

    // Ouvir mensagens
    cliente.onMessage(async (mensagem) => {
      if (mensagem.isGroupMsg) return;
      const numero = mensagem.from;
      const texto = mensagem.body;
      if (!texto || !numero) return;

      console.log(`📩 Mensagem de ${numero}: ${texto}`);

      // Detectar palavras de estoque → encaminhar para farmacêutico
      const gatilhosEstoque = ['tem ','disponível','disponivel','acabou','faltou','buscar','retirar','pegar','estoque'];
      const ehEstoque = gatilhosEstoque.some(g => texto.toLowerCase().includes(g));

      // Detectar emergência
      const ehEmergencia = ['dor no peito','falta de ar','desmaio','pressão muito alta','convulsão','infarto'].some(g => texto.toLowerCase().includes(g));

      if (ehEmergencia) {
        await cliente.sendText(numero, '🚨 ATENÇÃO! Pelos sintomas que descreveu, ligue agora para o SAMU: *192*\n\nNão espere — sua saúde é prioridade!');
        return;
      }

      if (ehEstoque) {
        const paciente = await buscarPaciente(numero);
        await salvarPendencia(paciente?.nome, numero, texto);
        await cliente.sendText(numero, 'Sua mensagem foi encaminhada para o farmacêutico da sua UBS. ⏳\n\nEm breve você receberá uma resposta. Para emergências: SAMU 192.');
        return;
      }

      // IA responde
      if (!historicos[numero]) historicos[numero] = [];
      historicos[numero].push({ role: 'user', content: texto });
      if (historicos[numero].length > 10) historicos[numero] = historicos[numero].slice(-10);

      try {
        const paciente = await buscarPaciente(numero);
        const systemComPaciente = paciente
          ? `${SYSTEM}\nPACIENTE: ${paciente.nome}, ${paciente.idade} anos, condições: ${JSON.parse(paciente.condicoes||'[]').join(', ')}, medicamentos: ${JSON.parse(paciente.medicamentos||'[]').map(m=>`${m.nome} (${m.dose})`).join('; ')}`
          : SYSTEM;

        const res = await fetch('https://kjwfzsouoeolycekyldd.supabase.co/functions/v1/rapid-handler', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${SUPA_KEY}`,
            'apikey': SUPA_KEY
          },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 500,
            system: systemComPaciente,
            messages: historicos[numero]
          })
        });
        const data = await res.json();
        const resposta = data.content?.[0]?.text || 'Desculpe, tive um problema. Tente novamente.';
        historicos[numero].push({ role: 'assistant', content: resposta });
        await cliente.sendText(numero, resposta);
      } catch(e) {
        console.error('Erro IA:', e.message);
        await cliente.sendText(numero, 'Desculpe, estou com dificuldades no momento. Para dúvidas urgentes, ligue para sua UBS.');
      }
    });

    return cliente;
  } catch(e) {
    console.error('Erro ao iniciar WPP:', e.message);
    statusConexao = 'erro';
  }
}

// ── ENDPOINTS ────────────────────────────────────────────────────────────────

// QR Code para conectar o WhatsApp
app.get('/qr', (req, res) => {
  if (global.qrCodeAtual) {
    res.send(`
      <html><body style="background:#054d38;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
      <h2 style="color:#fff;font-family:sans-serif;margin-bottom:20px">📱 Escaneie com o WhatsApp</h2>
      <img src="${global.qrCodeAtual}" style="width:300px;border-radius:16px"/>
      <p style="color:rgba(255,255,255,0.7);margin-top:16px;font-family:sans-serif">Abra o WhatsApp → Dispositivos conectados → Conectar dispositivo</p>
      <script>setTimeout(()=>location.reload(),15000)</script>
      </body></html>
    `);
  } else {
    res.send(`<html><body style="background:#054d38;color:#fff;font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column">
      <h2>${statusConexao === 'conectado' ? '✅ WhatsApp já conectado!' : '⏳ Aguarde... gerando QR Code'}</h2>
      <p>Status: ${statusConexao}</p>
      <script>setTimeout(()=>location.reload(),5000)</script>
    </body></html>`);
  }
});

// Status
app.get('/', (req, res) => {
  res.json({
    status: statusConexao === 'conectado' ? '✅ FarmaBot WhatsApp Online!' : `⏳ ${statusConexao}`,
    municipio: 'Trindade-GO',
    versao: '1.0.0',
    qr: statusConexao !== 'conectado' ? '/qr' : null
  });
});

// Enviar mensagem manualmente (para respostas do farmacêutico)
app.post('/enviar', async (req, res) => {
  const { numero, mensagem } = req.body;
  if (!clienteWpp || statusConexao !== 'conectado') {
    return res.status(503).json({ erro: 'WhatsApp não conectado' });
  }
  try {
    const numFormatado = `55${numero.replace(/\D/g,'')}@c.us`;
    await clienteWpp.sendText(numFormatado, mensagem);
    res.json({ ok: true });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`✅ Servidor rodando na porta ${PORT}`);
  iniciarWpp();
});
