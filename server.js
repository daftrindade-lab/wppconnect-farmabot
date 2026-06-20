const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const SUPA_URL = "https://kjwfzsouoeolycekyldd.supabase.co";
const SUPA_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imtqd2Z6c291b2VvbHljZWt5bGRkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODExMjcxODksImV4cCI6MjA5NjcwMzE4OX0.aRWc4yBiWx7W8NjQIcHn7JvxAqDho0fnvdzKSndOUDU";

// ── Configuração Meta WhatsApp Cloud API ──────────────────────────────────────
const META_TOKEN = process.env.META_TOKEN || "COLE_AQUI_O_TOKEN_PERMANENTE";
const META_PHONE_NUMBER_ID_PADRAO = process.env.META_PHONE_NUMBER_ID || "1178353528691016"; // fallback/legado (número de teste)
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "Farmaciaesp2026";
const META_API_VERSION = "v23.0";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "DAF1401";

const historicos = {};
const pacientesIdentificados = {};
const aguardandoCpf = {};

// ── Cache de UBS (multi-número) ───────────────────────────────────────────────
// Mapeia phone_number_id (da Meta) -> { nome_ubs, phone_number_id, numero_whatsapp, display_name }
let ubsCache = new Map();

async function carregarUbsCache() {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/farmabot_ubs?select=*&status=eq.ativo`, {
      headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` }
    });
    const data = await res.json();
    if (Array.isArray(data)) {
      const novoCache = new Map();
      data.forEach(u => novoCache.set(u.phone_number_id, u));
      ubsCache = novoCache;
      console.log(`✅ Cache de UBS carregado: ${ubsCache.size} unidade(s) ativa(s)`);
    }
  } catch (e) {
    console.error('Erro ao carregar cache de UBS:', e.message);
  }
}

function getUbsPorPhoneNumberId(phoneNumberId) {
  const ubs = ubsCache.get(phoneNumberId);
  if (ubs) return ubs;
  // Número ainda não cadastrado na tabela farmabot_ubs (ex: número de teste durante transição)
  return {
    nome_ubs: 'UBS não identificada',
    phone_number_id: phoneNumberId || META_PHONE_NUMBER_ID_PADRAO
  };
}

carregarUbsCache();
setInterval(carregarUbsCache, 5 * 60 * 1000); // recarrega a cada 5 min (pega novas UBS cadastradas)

// ── FAQ Automático ────────────────────────────────────────────────────────────
const FAQ = [
  { gatilhos:["horário","horario","que horas","quando abr","funciona","abre"], resposta:"🕐 Nossa UBS funciona de segunda a sexta, das 7h às 17h. Para emergências, ligue para o SAMU: 192." },
  { gatilhos:["telefone","fone","contato","ligar"], resposta:"📞 Para falar com nossa UBS, envie mensagem aqui mesmo ou compareça pessoalmente durante o horário de funcionamento (7h-17h, seg-sex)." },
  { gatilhos:["consulta","médico","medico","agendamento","agendar","marcar"], resposta:"📅 Para agendar consulta médica, compareça à recepção da UBS durante o horário de funcionamento (7h às 17h, seg a sex)." },
  { gatilhos:["endereço","endereco","onde fica","localização","localizacao"], resposta:"📍 Estamos em Trindade-GO. Para o endereço exato da sua UBS, verifique o cartão da unidade ou consulte a Prefeitura de Trindade." },
  { gatilhos:["obrigad","brigad","valeu","muito bem","ótimo","otimo","perfeito"], resposta:"😊 Fico feliz em ajudar! Cuidar da sua saúde é nossa missão. Qualquer dúvida, estou aqui!" },
  { gatilhos:["esqueci","esqueceu","perdi a dose","perdi dose"], resposta:"💊 Se esqueceu uma dose, tome assim que lembrar — *a não ser que esteja próximo do horário da próxima dose*. Nesse caso, pule a dose esquecida e continue normalmente.\n\n⚠️ Nunca tome duas doses de uma vez. Em caso de dúvida, consulte o farmacêutico da sua UBS." },
  { gatilhos:["efeito","colateral","reação","enjoo","tontura","mal estar"], resposta:"Se estiver sentindo mal-estar com algum medicamento, *não pare de tomar por conta própria*. Procure a UBS para orientação. Para sintomas graves, ligue SAMU: 192." },
  { gatilhos:["pressão","hipertensão","hipertensao"], resposta:"💓 Para controlar a pressão arterial: tome os remédios nos horários certos, reduza o sal, evite estresse, caminhe pelo menos 30 min/dia e meça a pressão regularmente. Dúvidas? Procure nossa UBS!" },
  { gatilhos:["diabetes","glicose","açúcar no sangue","acucar"], resposta:"🩺 Para controlar o diabetes: tome os remédios certinho, controle a alimentação, evite açúcar e faça exercícios. Se sentir tontura ou fraqueza, pode ser hipoglicemia — coma algo doce e procure ajuda." },
  { gatilhos:["oi","olá","ola","bom dia","boa tarde","boa noite","salve","ei ","hello","opa"], resposta:"👋 Olá! Bem-vindo(a) à FarmaBot da UBS de Trindade-GO.\n\nEstou aqui para ajudar com dúvidas sobre seus medicamentos. Como posso te ajudar hoje?" },
];

const GATILHOS_ESTOQUE = [
  'tem esse','tem o remédio','tem remedio','disponível','disponivel',
  'acabou','faltou','buscar remédio','retirar','pegar remédio','estoque',
  'medicamento disponível','tem metformina','tem losartana','tem insulina',
  'tem dipirona','tem o medicamento','tem esse remédio','tem esse remedio',
  'tem ','remédio disponível','remedio disponivel','buscar o remédio'
];

const GATILHOS_RESET = ['reiniciar','recomeçar','comecar de novo','começar de novo','menu','início','inicio','voltar'];

const GATILHOS_EMERGENCIA = ['dor no peito','falta de ar','desmaio','pressão muito alta','convulsão','infarto','avc','sangramento excessivo','inconsciente'];

const SYSTEM = `Você é a FarmaBot, assistente farmacêutica virtual da UBS de Trindade-GO, criada pela farmacêutica Vanessa, Diretora de Assistência Farmacêutica.
PERFIL: Idosos com HAS/DM, polimedicados, baixa escolaridade.
REGRAS: Linguagem simples. Máx 3 parágrafos. Nunca altere doses. Não confirme disponibilidade de medicamentos. Emergências: SAMU 192.`;

// ── Supabase helpers ──────────────────────────────────────────────────────────
async function buscarPaciente(telefone) {
  try {
    const digits = telefone.replace(/\D/g,'');
    const semPais = digits.replace(/^55/,'');
    const variacoes = new Set();

    variacoes.add(digits);
    variacoes.add(semPais);

    if(semPais.length === 10) {
      const ddd = semPais.slice(0,2);
      const resto = semPais.slice(2);
      variacoes.add(`${ddd}9${resto}`);
      variacoes.add(`55${ddd}9${resto}`);
    }
    if(semPais.length === 11) {
      const ddd = semPais.slice(0,2);
      const resto = semPais.slice(3);
      variacoes.add(`${ddd}${resto}`);
      variacoes.add(`55${ddd}${resto}`);
    }

    const orFilter = Array.from(variacoes).map(v => `telefone.eq.${v}`).join(',');
    const res = await fetch(
      `${SUPA_URL}/rest/v1/farmabot_pacientes?or=(${orFilter})&limit=1`,
      { headers:{"apikey":SUPA_KEY,"Authorization":`Bearer ${SUPA_KEY}`} }
    );
    const data = await res.json();
    return data?.[0] || null;
  } catch(e) {
    console.error('Erro buscarPaciente:', e.message);
    return null;
  }
}

async function buscarPacientePorCpf(cpf) {
  try {
    const cpfLimpo = cpf.replace(/\D/g,'');
    if(cpfLimpo.length < 11) return null;
    for(let i=0; i<3; i++) {
      try {
        const res = await fetch(
          `${SUPA_URL}/rest/v1/farmabot_pacientes?cpf=eq.${cpfLimpo}&limit=1`,
          { headers:{"apikey":SUPA_KEY,"Authorization":`Bearer ${SUPA_KEY}`} }
        );
        if(!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        return data?.[0] || null;
      } catch(e) {
        console.error(`buscarPacientePorCpf tentativa ${i+1} falhou: ${e.message}`);
        if(i<2) await new Promise(r=>setTimeout(r,1000));
      }
    }
    return null;
  } catch(e) {
    console.error('Erro buscarPacientePorCpf:', e.message);
    return null;
  }
}

async function buscarFaqs() {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/farmabot_faqs?order=ordem.asc`,
      { headers:{"apikey":SUPA_KEY,"Authorization":`Bearer ${SUPA_KEY}`} });
    const data = await res.json();
    return data?.length ? data : FAQ;
  } catch { return FAQ; }
}

async function buscarPendenciaAberta(numero) {
  try {
    const num11 = numero.replace(/\D/g,'').slice(-11);
    const res = await fetch(
      `${SUPA_URL}/rest/v1/farmabot_conversas?numero=eq.${num11}&pendente=eq.true&order=hora.desc&limit=1`,
      { headers:{"apikey":SUPA_KEY,"Authorization":`Bearer ${SUPA_KEY}`} }
    );
    const data = await res.json();
    return data?.[0] || null;
  } catch { return null; }
}

async function salvarPendencia(pacienteNome, numero, mensagem, nomeUbs) {
  try {
    const num11 = numero.replace(/\D/g,'').slice(-11);
    const hora = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
    await fetch(`${SUPA_URL}/rest/v1/farmabot_conversas`,{
      method:'POST',
      headers:{
        "apikey":SUPA_KEY,
        "Authorization":`Bearer ${SUPA_KEY}`,
        "Content-Type":"application/json",
        "Prefer":"resolution=merge-duplicates"
      },
      body:JSON.stringify({
        id:`wa_${Date.now()}`,
        paciente: pacienteNome || num11,
        numero: num11,
        unidade: nomeUbs || null,
        msgs:[
          {tipo:'paciente',texto:mensagem,hora},
          {tipo:'bot',texto:'Mensagem encaminhada ao farmacêutico. ⏳',hora}
        ],
        pendente:true,
        hora
      })
    });
  } catch(e){console.error('Erro pendência:',e.message);}
}

// ── Enviar mensagem via Meta Cloud API ────────────────────────────────────────
// phoneNumberId: de qual número da UBS a resposta deve sair (cai no padrão se não informado)
async function enviar(numero, texto, phoneNumberId) {
  try {
    const idParaEnviar = phoneNumberId || META_PHONE_NUMBER_ID_PADRAO;
    const num11 = numero.replace(/\D/g,'').slice(-11);
    const res = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${idParaEnviar}/messages`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${META_TOKEN}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: `55${num11}`,
          type: 'text',
          text: { body: texto }
        })
      }
    );
    const data = await res.json();
    console.log(`📤 Resposta Meta (via ${idParaEnviar}): ${JSON.stringify(data)}`);
    if(data.error) {
      console.error('Erro ao enviar mensagem Meta:', JSON.stringify(data.error));
    } else {
      console.log(`✅ Mensagem enviada para ${num11}`);
    }
    return data;
  } catch(e) {
    console.error('Erro enviar:', e.message);
  }
}

// ── Processar mensagem ────────────────────────────────────────────────────────
// ubs: { nome_ubs, phone_number_id } — identifica de qual UBS veio a conversa
async function processar(numero, texto, ubs) {
  const t = texto.toLowerCase().trim();
  const phoneNumberId = ubs?.phone_number_id;
  const nomeUbs = ubs?.nome_ubs;

  // 1. Emergência
  if(GATILHOS_EMERGENCIA.some(g=>t.includes(g))) {
    await enviar(numero,'🚨 *ATENÇÃO!* Pelos sintomas que descreveu, ligue *AGORA* para o SAMU: *192*\n\nNão espere — sua saúde é prioridade!', phoneNumberId);
    return;
  }

  // 2. Reset
  if(GATILHOS_RESET.some(g=>t.includes(g))) {
    delete historicos[numero];
    delete aguardandoCpf[numero];
    delete pacientesIdentificados[numero];
    await enviar(numero,'👋 Olá! Bem-vindo(a) à FarmaBot da UBS de Trindade-GO.\n\nEstou aqui para ajudar com dúvidas sobre seus medicamentos. Como posso te ajudar hoje?', phoneNumberId);
    return;
  }

  // 3. Aguardando CPF
  if(aguardandoCpf[numero]) {
    const cpfDigitado = texto.replace(/\D/g,'');
    if(cpfDigitado.length === 11) {
      const pacienteCpf = await buscarPacientePorCpf(cpfDigitado);
      if(pacienteCpf) {
        pacientesIdentificados[numero] = pacienteCpf;
        delete aguardandoCpf[numero];
        await enviar(numero, `✅ Olá, *${pacienteCpf.nome.split(' ')[0]}*! Identifiquei seu cadastro.\n\nComo posso te ajudar com seus medicamentos hoje?`, phoneNumberId);
        return;
      } else {
        delete aguardandoCpf[numero];
        await enviar(numero, '⚠️ CPF não encontrado no nosso sistema. Continuarei sem identificação.\n\nComo posso ajudar?', phoneNumberId);
        return;
      }
    } else {
      delete aguardandoCpf[numero];
      await enviar(numero, 'CPF inválido. Continuarei sem identificação. Como posso ajudar?', phoneNumberId);
      return;
    }
  }

  // 4. Identifica paciente (cache → telefone direto)
  let paciente = pacientesIdentificados[numero] || null;
  if(!paciente) {
    paciente = await buscarPaciente(numero);
    if(paciente) pacientesIdentificados[numero] = paciente;
  }
  console.log(`📋 Paciente: ${paciente?.nome || 'não identificado'} | UBS: ${nomeUbs || '?'} | Numero: ${numero}`);

  // 5. Pendência aberta
  const pendenciaAberta = await buscarPendenciaAberta(numero);
  if(pendenciaAberta) {
    try {
      const hora = new Date().toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
      const msgsAtualizadas = [...(pendenciaAberta.msgs||[]), {tipo:'paciente',texto,hora}];
      await fetch(`${SUPA_URL}/rest/v1/farmabot_conversas?id=eq.${pendenciaAberta.id}`,{
        method:'PATCH',
        headers:{"apikey":SUPA_KEY,"Authorization":`Bearer ${SUPA_KEY}`,"Content-Type":"application/json"},
        body:JSON.stringify({msgs:msgsAtualizadas})
      });
    } catch(e){console.error('Erro atualizar pendência:',e.message);}
    const ehSaudacao = ['oi','olá','ola','bom dia','boa tarde','boa noite'].some(g=>t.includes(g));
    if(ehSaudacao) {
      await enviar(numero,'⏳ Sua mensagem anterior já está com o farmacêutico da sua UBS.\n\nAssim que ele responder, você receberá uma mensagem aqui. Para urgências: SAMU 192.', phoneNumberId);
    }
    return;
  }

  // 6. Estoque → farmacêutico
  if(GATILHOS_ESTOQUE.some(g=>t.includes(g))) {
    if(!paciente) {
      aguardandoCpf[numero] = true;
      await enviar(numero, '💊 Para verificar o medicamento, preciso identificar seu cadastro.\n\nPor favor, digite seu *CPF* (apenas números):', phoneNumberId);
      return;
    }
    await salvarPendencia(paciente?.nome, numero, texto, nomeUbs);
    await enviar(numero,'Sua dúvida sobre disponibilidade de medicamento foi encaminhada para o farmacêutico da sua UBS. ⏳\n\nEm breve você receberá uma resposta. Para emergências: SAMU 192.', phoneNumberId);
    return;
  }

  // 7. FAQ
  const faqs = await buscarFaqs();
  const faqMatch = faqs.find(f => (f.gatilhos||[]).some(g=>t.includes(g)));
  if(faqMatch) {
    await enviar(numero, faqMatch.resposta, phoneNumberId);
    return;
  }

  // 8. IA
  if(!historicos[numero]) historicos[numero]=[];
  historicos[numero].push({role:'user',content:texto});
  if(historicos[numero].length>10) historicos[numero]=historicos[numero].slice(-10);

  try {
    const ctx = paciente
      ? `\nPACIENTE: ${paciente.nome}, ${paciente.idade} anos. Condições: ${(paciente.condicoes||[]).join(', ')}. Medicamentos: ${(paciente.medicamentos||[]).map(m=>`${m.nome} (${m.dose})`).join('; ')}.`
      : '';
    const res = await fetch(`${SUPA_URL}/functions/v1/rapid-handler`,{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${SUPA_KEY}`,'apikey':SUPA_KEY},
      body:JSON.stringify({model:'claude-sonnet-4-6',max_tokens:500,system:SYSTEM+ctx,messages:historicos[numero]})
    });
    const d = await res.json();
    const resposta = d.content?.[0]?.text;
    if(!resposta) throw new Error('Sem resposta da IA');
    historicos[numero].push({role:'assistant',content:resposta});
    await enviar(numero, resposta, phoneNumberId);
  } catch(e) {
    console.error('Erro IA:',e.message);
    await enviar(numero,'Não consegui processar sua dúvida agora. Por favor, ligue para sua UBS ou compareça pessoalmente. Emergências: SAMU 192.', phoneNumberId);
  }
}

// ── Webhook Meta — Verificação (GET) ──────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if(mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado com sucesso!');
    res.status(200).send(challenge);
  } else {
    console.log('❌ Falha na verificação do webhook');
    res.sendStatus(403);
  }
});

// ── Webhook Meta — Recebimento de mensagens (POST) ────────────────────────────
app.post('/webhook', async (req, res) => {
  res.sendStatus(200); // responde imediatamente pra Meta não reenviar

  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const messages = value?.messages;
    const statuses = value?.statuses;
    const phoneNumberId = value?.metadata?.phone_number_id;
    const ubs = getUbsPorPhoneNumberId(phoneNumberId);

    // NOVO: mostra o status real de entrega de cada mensagem enviada
    if (statuses && statuses.length > 0) {
      for (const st of statuses) {
        console.log(`📊 Status: ${st.status} | Destinatário: ${st.recipient_id} | wamid: ${st.id}`);
        if (st.errors) {
          console.error(`❌ Motivo da falha:`, JSON.stringify(st.errors));
        }
      }
    }

    if(!messages || messages.length === 0) return;

    for(const msg of messages) {
      if(msg.type !== 'text') continue;
      const numero = msg.from; // já vem com código do país, ex: 5562985816375
      const texto = msg.text?.body || '';
      if(!texto.trim()) continue;

      console.log(`📩 De: ${numero} | UBS: ${ubs.nome_ubs} | Msg: ${texto}`);
      await processar(numero, texto, ubs);
    }
  } catch(e) {
    console.error('Erro processar webhook:', e.message);
  }
});

// ── Endpoints ─────────────────────────────────────────────────────────────────
app.get('/', (req,res) => res.json({
  status: '✅ FarmaBot SUS Online! (Meta Cloud API multi-UBS)',
  municipio: 'Trindade-GO — DAF',
  versao: '3.2.0-meta-multiubs',
  ubsAtivas: ubsCache.size,
  webhook: '/webhook'
}));

app.post('/enviar', async (req,res) => {
  const { numero, mensagem, phone_number_id } = req.body;
  try {
    const data = await enviar(numero, mensagem, phone_number_id);
    res.json({ ok: true, data });
  } catch(e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── Admin: gerenciar UBS ───────────────────────────────────────────────────────
function checkAdmin(req, res) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) {
    res.status(401).json({ erro: 'Não autorizado' });
    return false;
  }
  return true;
}

app.get('/admin/ubs', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({ total: ubsCache.size, ubs: Array.from(ubsCache.values()) });
});

app.post('/admin/ubs', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { nome_ubs, phone_number_id, numero_whatsapp, display_name } = req.body;
  if (!nome_ubs || !phone_number_id) {
    return res.status(400).json({ erro: 'nome_ubs e phone_number_id são obrigatórios' });
  }
  try {
    const r = await fetch(`${SUPA_URL}/rest/v1/farmabot_ubs`, {
      method: 'POST',
      headers: {
        "apikey": SUPA_KEY,
        "Authorization": `Bearer ${SUPA_KEY}`,
        "Content-Type": "application/json",
        "Prefer": "return=representation"
      },
      body: JSON.stringify({ nome_ubs, phone_number_id, numero_whatsapp, display_name, status: 'ativo' })
    });
    const data = await r.json();
    await carregarUbsCache();
    res.json({ ok: true, data });
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

app.post('/admin/recarregar-ubs', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  await carregarUbsCache();
  res.json({ ok: true, total: ubsCache.size });
});

app.listen(PORT, () => {
  console.log(`✅ FarmaBot SUS (Meta Cloud API) rodando na porta ${PORT}`);
  console.log(`📱 Webhook em /webhook`);
  console.log(`Município: Trindade-GO | DAF | v3.2.0-meta-multiubs`);
});
