const { default: makeWASocket, DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
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
const SUPA_URL = "https://kjwfzsouoeolycekyldd.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtqd2Z6c291b2VvbHljZWt5bGRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMjcxODksImV4cCI6MjA5NjcwMzE4OX0.aRWc4yBiWx7W8NjQIcHn7JvxAqDho0fnvdzKSndOUDU";

let sock = null;
let qrAtual = null;
let statusConexao = 'desconectado';
const historicos = {};

// ── FAQ Automático (sem precisar de IA) ───────────────────────────────────────
const FAQ = [
  { gatilhos:["horário","horario","que horas","quando abr","funciona","abre"], resposta:"🕐 Nossa UBS funciona de segunda a sexta, das 7h às 17h. Para emergências, ligue para o SAMU: 192." },
  { gatilhos:["telefone","fone","contato","ligar"], resposta:"📞 Para falar com nossa UBS, envie mensagem aqui mesmo ou compareça pessoalmente durante o horário de funcionamento (7h-17h, seg-sex)." },
  { gatilhos:["consulta","médico","medico","agendamento","agendar","marcar"], resposta:"📅 Para agendar consulta médica, compareça à recepção da UBS durante o horário de funcionamento (7h às 17h, seg a sex)." },
  { gatilhos:["endereço","endereco","onde fica","localização","localizacao","endereço"], resposta:"📍 Estamos em Trindade-GO. Para o endereço exato da sua UBS, verifique o cartão da unidade ou consulte a Prefeitura de Trindade." },
  { gatilhos:["obrigad","brigad","valeu","muito bem","ótimo","otimo","perfeito"], resposta:"😊 Fico feliz em ajudar! Cuidar da sua saúde é nossa missão. Qualquer dúvida, estou aqui!" },
  { gatilhos:["oi","olá","ola","bom dia","boa tarde","boa noite","salve","ei "], resposta:"👋 Olá! Bem-vindo(a) à FarmaBot da UBS de Trindade-GO.\n\nEstou aqui para ajudar com dúvidas sobre seus medicamentos. Como posso te ajudar hoje?" },
  { gatilhos:["esqueci","esqueceu","perdi a dose","perdi dose"], resposta:"💊 Se esqueceu uma dose, tome assim que lembrar — *a não ser que esteja próximo do horário da próxima dose*. Nesse caso, pule a dose esquecida e continue normalmente.\n\n⚠️ Nunca tome duas doses de uma vez. Em caso de dúvida, consulte o farmacêutico da sua UBS." },
  { gatilhos:["efeito","colateral","reação","enjoo","tontura","mal estar"], resposta:"Se estiver sentindo mal-estar com algum medicamento, *não pare de tomar por conta própria*. Procure a UBS para orientação. Para sintomas graves, ligue SAMU: 192." },
  { gatilhos:["pressão","hipertensão","hipertensao"], resposta:"💓 Para controlar a pressão arterial: tome os remédios nos horários certos, reduza o sal, evite estresse, caminhe pelo menos 30 min/dia e meça a pressão regularmente. Dúvidas? Procure nossa UBS!" },
  { gatilhos:["diabetes","glicose","açúcar no sangue","acucar"], resposta:"🩺 Para controlar o diabetes: tome os remédios certinho, controle a alimentação, evite açúcar e faça exercícios. Se sentir tontura ou fraqueza, pode ser hipoglicemia — coma algo doce e procure ajuda." },
];

const GATILHOS_ESTOQUE = ['tem esse','tem o remédio','tem remedio','disponível','disponivel','acabou','faltou','buscar remédio','retirar','pegar remédio','estoque','medicamento disponível','tem metformina','tem losartana','tem insulina','tem dipirona'];
const GATILHOS_EMERGENCIA = ['dor no peito','falta de ar','desmaio','pressão muito alta','convulsão','infarto','avc','sangramento excessivo','inconsciente'];

const SYSTEM = `Você é a FarmaBot, assistente farmacêutica virtual da UBS de Trindade-GO, criada pela farmacêutica Vanessa, Diretora de Assistência Farmacêutica.
PERFIL: Idosos com HAS/DM, polimedicados, baixa escolaridade.
REGRAS: Linguagem simples. Máx 3 parágrafos. Nunca altere doses. Não confirme disponibilidade de medicamentos. Emergências: SAMU 192.`;

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function buscarPaciente(telefone) {
  try {
    // Tenta com os últimos 11 dígitos (sem código do país)
    const num11 = telefone.replace(/\D/g,'').slice(-11);
    // Tenta com os últimos 10 dígitos (sem DDD 0)
    const num10 = telefone.replace(/\D/g,'').slice(-10);
    // Busca pelos dois formatos
    const res = await fetch(
      `${SUPA_URL}/rest/v1/farmabot_pacientes?or=(telefone.eq.${num11},telefone.eq.${num10})&limit=1`,
      { headers:{"apikey":SUPA_KEY,"Authorization":`Bearer ${SUPA_KEY}`} }
    );
    const data = await res.json();
    return data?.[0]||null;
  } catch { return null; }
}

async function buscarFaqs() {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/farmabot_faqs?order=ordem.asc`,
      { headers:{"apikey":SUPA_KEY,"Authorization":`Bearer ${SUPA_KEY}`} });
    const data = await res.json();
    return data?.length ? data : FAQ;
  } catch { return FAQ; }
}

async function salvarPendencia(pacienteNome, numero, mensagem) {
  try {
    const hora = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    await fetch(`${SUPA_URL}/rest/v1/farmabot_conversas`,{
      method:'POST',
      headers:{"apikey":SUPA_KEY,"Authorization":`Bearer ${SUPA_KEY}`,"Content-Type":"application/json","Prefer":"resolution=merge-duplicates"},
      body:JSON.stringify({id:`wa_${Date.now()}`,paciente:pacienteNome||numero,numero:numero.replace(/\D/g,'').slice(-11),msgs:[{tipo:'paciente',texto:mensagem,hora},{tipo:'bot',texto:'Mensagem encaminhada ao farmacêutico. ⏳',hora}],pendente:true,hora})
    });
  } catch(e){console.error('Erro pendência:',e.message);}
}

// ── Enviar mensagem ───────────────────────────────────────────────────────────
async function enviar(jid, texto) {
  if(!sock) return;
  try { await sock.sendMessage(jid,{text:texto}); } catch(e){console.error('Erro enviar:',e.message);}
}

// ── Processar mensagem ────────────────────────────────────────────────────────
async function processar(jid, texto) {
  const t = texto.toLowerCase().trim();
  const telefone = jid.replace('@s.whatsapp.net','').replace(/^55/,'');

  // 1. Emergência
  if(GATILHOS_EMERGENCIA.some(g=>t.includes(g))) {
    await enviar(jid,'🚨 *ATENÇÃO!* Pelos sintomas que descreveu, ligue *AGORA* para o SAMU: *192*\n\nNão espere — sua saúde é prioridade!');
    return;
  }

  // 2. FAQ automático (do Supabase ou padrão)
  const faqs = await buscarFaqs();
  const faqMatch = faqs.find(f => (f.gatilhos||[]).some(g=>t.includes(g)));
  if(faqMatch) {
    await enviar(jid, faqMatch.resposta);
    return;
  }

  // 3. Disponibilidade → farmacêutico
  if(GATILHOS_ESTOQUE.some(g=>t.includes(g))) {
    const paciente = await buscarPaciente(telefone);
    await salvarPendencia(paciente?.nome, jid, texto);
    await enviar(jid,'Sua dúvida sobre disponibilidade de medicamento foi encaminhada para o farmacêutico da sua UBS. ⏳\n\nEm breve você receberá uma resposta. Para emergências: SAMU 192.');
    return;
  }

  // 4. IA (Claude via Supabase Edge Function)
  if(!historicos[jid]) historicos[jid]=[];
  historicos[jid].push({role:'user',content:texto});
  if(historicos[jid].length>10) historicos[jid]=historicos[jid].slice(-10);

  try {
    const paciente = await buscarPaciente(telefone);
    const ctx = paciente
      ? `\nPACIENTE: ${paciente.nome}, ${paciente.idade} anos. Condições: ${(paciente.condicoes||[]).join(', ')}. Medicamentos: ${(paciente.medicamentos||[]).map(m=>`${m.nome} (${m.dose})`).join('; ')}.`
      : '';
    const res = await fetch('https://kjwfzsouoeolycekyldd.supabase.co/functions/v1/rapid-handler',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${SUPA_KEY}`,'apikey':SUPA_KEY},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:500,system:SYSTEM+ctx,messages:historicos[jid]})
    });
    const d = await res.json();
    const resposta = d.content?.[0]?.text;
    if(!resposta) throw new Error('Sem resposta da IA');
    historicos[jid].push({role:'assistant',content:resposta});
    await enviar(jid, resposta);
  } catch(e) {
    console.error('Erro IA:',e.message);
    await enviar(jid,'Não consegui processar sua dúvida agora. Por favor, ligue para sua UBS ou compareça pessoalmente. Emergências: SAMU 192.');
  }
}

// ── Baileys ───────────────────────────────────────────────────────────────────
async function iniciar() {
  const AUTH = path.join('/tmp','farmabot_auth');
  if(!fs.existsSync(AUTH)) fs.mkdirSync(AUTH,{recursive:true});
  const {state,saveCreds} = await useMultiFileAuthState(AUTH);
  const {version} = await fetchLatestBaileysVersion();
  const logger = pino({level:'silent'});

  sock = makeWASocket({version,auth:state,logger,printQRInTerminal:false,browser:['FarmaBot SUS','Chrome','1.0'],connectTimeoutMs:60000,keepAliveIntervalMs:30000});
  sock.ev.on('creds.update',saveCreds);

  sock.ev.on('connection.update',async({connection,lastDisconnect,qr})=>{
    if(qr){qrAtual=qr;statusConexao='aguardando_qr';console.log('📱 QR Code gerado — acesse /qr');}
    if(connection==='close'){
      statusConexao='desconectado';qrAtual=null;
      const code=lastDisconnect?.error?.output?.statusCode;
      if(code!==DisconnectReason.loggedOut) setTimeout(iniciar,5000);
    }
    if(connection==='open'){statusConexao='conectado';qrAtual=null;console.log('✅ WhatsApp conectado!');}
  });

  sock.ev.on('messages.upsert',async({messages,type})=>{
    if(type!=='notify') return;
    for(const msg of messages){
      if(msg.key.fromMe) continue;
      if(msg.key.remoteJid?.includes('@g.us')) continue;
      const jid = msg.key.remoteJid;
      const texto = msg.message?.conversation||msg.message?.extendedTextMessage?.text||'';
      if(!texto.trim()) continue;
      console.log(`📩 ${jid.split('@')[0]}: ${texto}`);
      await processar(jid,texto);
    }
  });
}

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get('/qr',async(req,res)=>{
  if(statusConexao==='conectado') return res.send(`<html><body style="background:#054d38;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif"><div style="font-size:60px;margin-bottom:16px">✅</div><h2 style="color:#fff">WhatsApp Conectado!</h2><p style="color:rgba(255,255,255,0.7)">FarmaBot SUS está online e respondendo mensagens.</p></body></html>`);
  if(qrAtual){
    try{
      const img=await QRCode.toDataURL(qrAtual,{width:300,margin:2});
      return res.send(`<html><body style="background:#054d38;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif"><h2 style="color:#fff;margin-bottom:4px">📱 Conectar FarmaBot SUS</h2><p style="color:rgba(255,255,255,0.7);margin-bottom:20px;text-align:center">WhatsApp → Dispositivos conectados → Conectar dispositivo</p><img src="${img}" style="width:280px;border-radius:16px;background:#fff;padding:12px"/><p style="color:rgba(255,255,255,0.5);margin-top:16px;font-size:13px">Atualiza automaticamente a cada 15 segundos</p><script>setTimeout(()=>location.reload(),15000)</script></body></html>`);
    }catch(e){return res.send('<html><body style="background:#054d38;color:#fff;font-family:sans-serif;padding:40px"><h2>Gerando QR Code... recarregue em instantes.</h2></body></html>');}
  }
  res.send(`<html><body style="background:#054d38;display:flex;align-items:center;justify-content:center;height:100vh;flex-direction:column;font-family:sans-serif"><div style="font-size:48px;margin-bottom:16px">⏳</div><h2 style="color:#fff">Aguardando QR Code...</h2><p style="color:rgba(255,255,255,0.7)">Status: ${statusConexao}</p><script>setTimeout(()=>location.reload(),5000)</script></body></html>`);
});

app.get('/',(req,res)=>res.json({status:statusConexao==='conectado'?'✅ FarmaBot WhatsApp Online!':`⏳ ${statusConexao}`,municipio:'Trindade-GO — DAF',versao:'2.1.0',qr:statusConexao!=='conectado'?'/qr':null}));

app.post('/enviar',async(req,res)=>{
  const{numero,mensagem}=req.body;
  if(!sock||statusConexao!=='conectado') return res.status(503).json({erro:'WhatsApp não conectado'});
  try{await sock.sendMessage(`55${numero.replace(/\D/g,'')}@s.whatsapp.net`,{text:mensagem});res.json({ok:true});}
  catch(e){res.status(500).json({erro:e.message});}
});

app.listen(PORT,()=>{
  console.log(`✅ FarmaBot SUS rodando na porta ${PORT}`);
  console.log(`📱 Acesse /qr para conectar o WhatsApp`);
  console.log(`Município: Trindade-GO | DAF`);
  iniciar();
});
