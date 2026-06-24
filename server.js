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
const META_PHONE_NUMBER_ID = process.env.META_PHONE_NUMBER_ID || "1250492738136626"; // número central DAF
const META_VERIFY_TOKEN = process.env.META_VERIFY_TOKEN || "Farmaciaesp2026";
const META_API_VERSION = "v23.0";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "DAF1401";

// ── Estado em memória ─────────────────────────────────────────────────────────
const historicos = {};           // numero -> [{role, content}]
const pacientesIdentificados = {}; // numero -> paciente
const fluxoIdentificacao = {};   // numero -> { etapa, dadosParciais }

// ── Cache ─────────────────────────────────────────────────────────────────────
let pacientesCache = [];
let horariosPadraoCache = new Map();

async function carregarPacientesCache() {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/farmabot_pacientes?select=id,nome,telefone,cpf,ubs_nome,medicamentos,ubs_id`, {
      headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` }
    });
    const data = await res.json();
    if (Array.isArray(data)) {
      pacientesCache = data;
      console.log(`✅ Cache de pacientes: ${pacientesCache.length} paciente(s)`);
    }
  } catch (e) { console.error('Erro cache pacientes:', e.message); }
}

async function carregarHorariosPadraoCache() {
  try {
    const res = await fetch(`${SUPA_URL}/rest/v1/farmabot_horarios_padrao?select=*`, {
      headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` }
    });
    const data = await res.json();
    if (Array.isArray(data)) {
      const novo = new Map();
      data.forEach(r => novo.set(r.rotulo, r.horarios || []));
      horariosPadraoCache = novo;
      console.log(`✅ Horários-padrão: ${horariosPadraoCache.size} rótulo(s)`);
    }
  } catch (e) { console.error('Erro cache horários:', e.message); }
}

carregarPacientesCache();
carregarHorariosPadraoCache();
setInterval(carregarPacientesCache, 5 * 60 * 1000);
setInterval(carregarHorariosPadraoCache, 5 * 60 * 1000);

// ── FAQ ───────────────────────────────────────────────────────────────────────
const FAQ = [
  { gatilhos:["horário","horario","que horas","quando abr","funciona","abre"], resposta:"🕐 Nossa UBS funciona de segunda a sexta, das 7h às 17h. Para emergências, ligue para o SAMU: 192." },
  { gatilhos:["telefone","fone","contato","ligar"], resposta:"📞 Para falar com sua UBS, envie mensagem aqui mesmo ou compareça pessoalmente durante o horário de funcionamento (7h-17h, seg-sex)." },
  { gatilhos:["consulta","médico","medico","agendamento","agendar","marcar"], resposta:"📅 Para agendar consulta médica, compareça à recepção da UBS durante o horário de funcionamento (7h às 17h, seg a sex)." },
  { gatilhos:["endereço","endereco","onde fica","localização","localizacao"], resposta:"📍 Estamos em Trindade-GO. Para o endereço exato da sua UBS, verifique o cartão da unidade ou consulte a Prefeitura de Trindade." },
  { gatilhos:["obrigad","brigad","valeu","muito bem","ótimo","otimo","perfeito"], resposta:"😊 Fico feliz em ajudar! Cuidar da sua saúde é nossa missão. Qualquer dúvida, estou aqui!" },
  { gatilhos:["esqueci","esqueceu","perdi a dose","perdi dose"], resposta:"💊 Se esqueceu uma dose, tome assim que lembrar — *a não ser que esteja próximo do horário da próxima dose*. Nesse caso, pule a dose esquecida e continue normalmente.\n\n⚠️ Nunca tome duas doses de uma vez. Em caso de dúvida, consulte o farmacêutico da sua UBS." },
  { gatilhos:["efeito","colateral","reação","enjoo","tontura","mal estar"], resposta:"Se estiver sentindo mal-estar com algum medicamento, *não pare de tomar por conta própria*. Procure a UBS para orientação. Para sintomas graves, ligue SAMU: 192." },
  { gatilhos:["pressão","hipertensão","hipertensao"], resposta:"💓 Para controlar a pressão arterial: tome os remédios nos horários certos, reduza o sal, evite estresse, caminhe pelo menos 30 min/dia e meça a pressão regularmente." },
  { gatilhos:["diabetes","glicose","açúcar no sangue","acucar"], resposta:"🩺 Para controlar o diabetes: tome os remédios certinho, controle a alimentação, evite açúcar e faça exercícios. Se sentir tontura ou fraqueza, pode ser hipoglicemia — coma algo doce e procure ajuda." },
  { gatilhos:["oi","olá","ola","bom dia","boa tarde","boa noite","salve","ei ","hello","opa"], resposta:null }, // resposta dinâmica abaixo
];

const GATILHOS_ESTOQUE = ['tem esse','tem o remédio','tem remedio','disponível','disponivel','acabou','faltou','buscar remédio','retirar','pegar remédio','estoque','medicamento disponível','tem metformina','tem losartana','tem insulina','tem dipirona','tem o medicamento','tem esse remédio','tem esse remedio','tem ','remédio disponível','remedio disponivel','buscar o remédio'];
const GATILHOS_RESET = ['reiniciar','recomeçar','comecar de novo','começar de novo','menu','início','inicio','voltar'];
const GATILHOS_EMERGENCIA = ['dor no peito','falta de ar','desmaio','pressão muito alta','convulsão','infarto','avc','sangramento excessivo','inconsciente'];

const SYSTEM = `Você é a FarmaBot, assistente farmacêutica virtual da Assistência Farmacêutica de Trindade-GO.
PERFIL: Idosos com HAS/DM, polimedicados, baixa escolaridade.
REGRAS: Linguagem simples e acolhedora. Máx 3 parágrafos curtos. Nunca altere doses. Não confirme disponibilidade de medicamentos (isso vai para o farmacêutico). Emergências: SAMU 192.`;

// ── Helpers Supabase ──────────────────────────────────────────────────────────
async function supaFetch(path, opts = {}) {
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    headers: {
      "apikey": SUPA_KEY,
      "Authorization": `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      ...opts.headers
    },
    ...opts
  });
  return res.json();
}

// ── Identificar paciente por telefone ────────────────────────────────────────
async function buscarPacientePorTelefone(telefone) {
  try {
    const digits = telefone.replace(/\D/g, '');
    const semPais = digits.replace(/^55/, '');
    const variacoes = new Set([digits, semPais]);

    if (semPais.length === 10) {
      const ddd = semPais.slice(0, 2), resto = semPais.slice(2);
      variacoes.add(`${ddd}9${resto}`);
      variacoes.add(`55${ddd}9${resto}`);
    }
    if (semPais.length === 11) {
      const ddd = semPais.slice(0, 2), resto = semPais.slice(3);
      variacoes.add(`${ddd}${resto}`);
      variacoes.add(`55${ddd}${resto}`);
    }

    const orFilter = Array.from(variacoes).map(v => `telefone.eq.${v}`).join(',');
    const res = await supaFetch(`farmabot_pacientes?or=(${orFilter})&limit=1`);
    return Array.isArray(res) ? res[0] || null : null;
  } catch (e) {
    console.error('Erro buscarPacientePorTelefone:', e.message);
    return null;
  }
}

// ── Identificar paciente por CPF ─────────────────────────────────────────────
async function buscarPacientePorCpf(cpf) {
  try {
    const cpfLimpo = cpf.replace(/\D/g, '');
    if (cpfLimpo.length < 11) return null;
    const res = await supaFetch(`farmabot_pacientes?cpf=eq.${cpfLimpo}&limit=1`);
    return Array.isArray(res) ? res[0] || null : null;
  } catch (e) { return null; }
}

// ── Buscar farmacêutico da UBS ────────────────────────────────────────────────
async function buscarFarmaceuticoDaUbs(ubsNome) {
  try {
    const res = await supaFetch(`farmabot_usuarios?ubs=eq.${encodeURIComponent(ubsNome)}&perfil=eq.farmaceutico&ativo=eq.true&limit=1`);
    return Array.isArray(res) ? res[0] || null : null;
  } catch (e) { return null; }
}

// ── Pendências ────────────────────────────────────────────────────────────────
async function buscarPendenciaAberta(numero) {
  try {
    const num11 = numero.replace(/\D/g, '').slice(-11);
    const res = await supaFetch(`farmabot_conversas?numero=eq.${num11}&pendente=eq.true&order=hora.desc&limit=1`);
    return Array.isArray(res) ? res[0] || null : null;
  } catch { return null; }
}

async function salvarPendencia(pacienteNome, numero, mensagem, ubsNome, farmaceuticoId) {
  try {
    const num11 = numero.replace(/\D/g, '').slice(-11);
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    await supaFetch(`farmabot_conversas`, {
      method: 'POST',
      headers: { "Prefer": "resolution=merge-duplicates" },
      body: JSON.stringify({
        id: `wa_${Date.now()}`,
        paciente: pacienteNome || num11,
        numero: num11,
        unidade: ubsNome || null,
        farmaceutico_id: farmaceuticoId || null,
        msgs: [
          { tipo: 'paciente', texto: mensagem, hora },
          { tipo: 'bot', texto: '⏳ Mensagem encaminhada ao farmacêutico da sua unidade.', hora }
        ],
        pendente: true,
        hora
      })
    });
  } catch (e) { console.error('Erro salvarPendencia:', e.message); }
}

async function adicionarMsgPendencia(conversaId, texto, tipo) {
  try {
    const conv = await supaFetch(`farmabot_conversas?id=eq.${conversaId}&select=msgs`);
    const msgs = conv[0]?.msgs || [];
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    msgs.push({ tipo, texto, hora });
    await supaFetch(`farmabot_conversas?id=eq.${conversaId}`, {
      method: 'PATCH',
      body: JSON.stringify({ msgs })
    });
  } catch (e) { console.error('Erro adicionarMsg:', e.message); }
}

// ── Enviar mensagem via Meta Cloud API ────────────────────────────────────────
async function enviar(numero, texto) {
  try {
    const num11 = numero.replace(/\D/g, '').slice(-11);
    const res = await fetch(
      `https://graph.facebook.com/${META_API_VERSION}/${META_PHONE_NUMBER_ID}/messages`,
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
    if (data.error) {
      console.error('❌ Erro Meta:', JSON.stringify(data.error));
    } else {
      console.log(`✅ Mensagem enviada para ${num11}`);
    }
    return data;
  } catch (e) {
    console.error('Erro enviar:', e.message);
  }
}

// ── Motor de lembretes ────────────────────────────────────────────────────────
function resolverHorarios(rotulo) {
  if (/^\d{2}:\d{2}$/.test(rotulo)) return [rotulo];
  return horariosPadraoCache.get(rotulo) || [];
}

function horaAtualSP() {
  return new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
}

function dataAtualSP() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

async function jaFoiEnviado(pacienteId, medicamento, horario, data) {
  try {
    const res = await supaFetch(
      `farmabot_lembretes_enviados?paciente_id=eq.${pacienteId}&medicamento=eq.${encodeURIComponent(medicamento)}&horario=eq.${encodeURIComponent(horario)}&data=eq.${data}&select=id&limit=1`
    );
    return Array.isArray(res) && res.length > 0;
  } catch { return false; }
}

async function marcarEnviado(pacienteId, medicamento, horario, data) {
  try {
    await supaFetch(`farmabot_lembretes_enviados`, {
      method: 'POST',
      headers: { "Prefer": "resolution=ignore-duplicates" },
      body: JSON.stringify({ paciente_id: pacienteId, medicamento, horario, data })
    });
  } catch (e) { console.error('Erro marcarEnviado:', e.message); }
}

async function checarLembretes() {
  const agora = horaAtualSP();
  const hoje = dataAtualSP();
  console.log(`🕐 Lembretes: ${agora} | ${pacientesCache.length} paciente(s)`);

  for (const paciente of pacientesCache) {
    const medicamentos = paciente.medicamentos || [];
    for (const med of medicamentos) {
      const rotulos = med.horarios || [];
      for (const rotulo of rotulos) {
        const horariosResolvidos = resolverHorarios(rotulo);
        if (!horariosResolvidos.includes(agora)) continue;

        const jaEnviado = await jaFoiEnviado(paciente.id, med.nome, rotulo, hoje);
        if (jaEnviado) continue;

        const primeiroNome = (paciente.nome || '').split(' ')[0];
        const msg = `💊 Olá, *${primeiroNome}*! Está na hora de tomar:\n\n*${med.nome}* — ${med.dose}\n\nApós tomar, não precisa responder nada. Qualquer dúvida, é só chamar aqui! 😊`;

        await enviar(paciente.telefone, msg);
        await marcarEnviado(paciente.id, med.nome, rotulo, hoje);
        console.log(`💊 Lembrete: ${paciente.nome} | ${med.nome} | ${agora}`);
      }
    }
  }
}

setInterval(checarLembretes, 60 * 1000);

// ── Processar mensagem ────────────────────────────────────────────────────────
async function processar(numero, texto) {
  const t = texto.toLowerCase().trim();

  // 1. Emergência
  if (GATILHOS_EMERGENCIA.some(g => t.includes(g))) {
    await enviar(numero, '🚨 *ATENÇÃO!* Pelos sintomas que descreveu, ligue *AGORA* para o SAMU: *192*\n\nNão espere — sua saúde é prioridade!');
    return;
  }

  // 2. Reset
  if (GATILHOS_RESET.some(g => t.includes(g))) {
    delete historicos[numero];
    delete fluxoIdentificacao[numero];
    delete pacientesIdentificados[numero];
    await enviar(numero, '👋 Olá! Bem-vindo(a) à Assistência Farmacêutica de Trindade-GO.\n\nEstou aqui para ajudar com dúvidas sobre seus medicamentos. Como posso te ajudar hoje?');
    return;
  }

  // 3. Fluxo de identificação em andamento
  if (fluxoIdentificacao[numero]) {
    await processarFluxoIdentificacao(numero, texto, t);
    return;
  }

  // 4. Tentativa de identificação por telefone
  let paciente = pacientesIdentificados[numero] || null;
  if (!paciente) {
    paciente = await buscarPacientePorTelefone(numero);
    if (paciente) {
      pacientesIdentificados[numero] = paciente;
      console.log(`✅ Paciente identificado por telefone: ${paciente.nome} | UBS: ${paciente.ubs_nome}`);
    }
  }

  // 5. Não identificado → iniciar fluxo de identificação
  if (!paciente) {
    // Verifica se é saudação simples — responde antes de pedir dados
    const ehSaudacao = ['oi','olá','ola','bom dia','boa tarde','boa noite'].some(g => t.includes(g));
    if (ehSaudacao) {
      await enviar(numero, '👋 Olá! Bem-vindo(a) à Assistência Farmacêutica de Trindade-GO.\n\nPara te ajudar melhor, preciso identificar seu cadastro. Por favor, me informe seu *nome completo*:');
    } else {
      await enviar(numero, '👋 Olá! Para te ajudar preciso identificar seu cadastro.\n\nPor favor, me informe seu *nome completo*:');
    }
    fluxoIdentificacao[numero] = { etapa: 'nome', dadosParciais: {} };
    return;
  }

  // 6. Paciente identificado — processar mensagem normalmente
  await processarMensagem(numero, texto, t, paciente);
}

// ── Fluxo de identificação manual ────────────────────────────────────────────
async function processarFluxoIdentificacao(numero, texto, t) {
  const fluxo = fluxoIdentificacao[numero];

  if (fluxo.etapa === 'nome') {
    if (texto.trim().split(' ').length < 2) {
      await enviar(numero, 'Por favor, informe seu *nome completo* (nome e sobrenome):');
      return;
    }
    fluxo.dadosParciais.nome = texto.trim();
    fluxo.etapa = 'cpf';
    await enviar(numero, `Obrigada, *${texto.trim().split(' ')[0]}*! Agora me informe seu *CPF* (apenas os números):`);
    return;
  }

  if (fluxo.etapa === 'cpf') {
    const cpfLimpo = texto.replace(/\D/g, '');
    if (cpfLimpo.length !== 11) {
      await enviar(numero, 'CPF inválido. Por favor, informe os *11 dígitos* do seu CPF (apenas números):');
      return;
    }

    // Tenta encontrar por CPF
    const pacienteCpf = await buscarPacientePorCpf(cpfLimpo);
    if (pacienteCpf) {
      pacientesIdentificados[numero] = pacienteCpf;
      delete fluxoIdentificacao[numero];
      console.log(`✅ Paciente identificado por CPF: ${pacienteCpf.nome}`);
      await enviar(numero, `✅ Olá, *${pacienteCpf.nome.split(' ')[0]}*! Encontrei seu cadastro na ${pacienteCpf.ubs_nome}.\n\nComo posso te ajudar hoje?`);
      return;
    }

    // CPF não encontrado → pedir UBS
    fluxo.dadosParciais.cpf = cpfLimpo;
    fluxo.etapa = 'ubs';
    await enviar(numero, 'Não encontrei seu cadastro pelo CPF. Pode me dizer o nome da sua *UBS* (Unidade de Saúde)?');
    return;
  }

  if (fluxo.etapa === 'ubs') {
    // Não encontrado no sistema — salva para o farmacêutico verificar
    const dadosParciais = fluxo.dadosParciais;
    delete fluxoIdentificacao[numero];

    await salvarPendencia(
      dadosParciais.nome || numero,
      numero,
      `⚠️ PACIENTE NÃO CADASTRADO\nNome: ${dadosParciais.nome || '—'}\nCPF: ${dadosParciais.cpf || '—'}\nUBS informada: ${texto.trim()}\nMensagem original: (primeiro contato)`,
      texto.trim(),
      null
    );

    await enviar(numero,
      `Obrigada, *${(dadosParciais.nome || '').split(' ')[0]}*! ` +
      `Sua solicitação foi encaminhada para o farmacêutico da ${texto.trim()}.\n\n` +
      `Em breve você receberá uma resposta. Para urgências: SAMU *192* 🚑`
    );
    return;
  }
}

// ── Processar mensagem com paciente identificado ──────────────────────────────
async function processarMensagem(numero, texto, t, paciente) {

  // 1. Pendência aberta com farmacêutico
  const pendenciaAberta = await buscarPendenciaAberta(numero);
  if (pendenciaAberta) {
    await adicionarMsgPendencia(pendenciaAberta.id, texto, 'paciente');
    const ehSaudacao = ['oi','olá','ola','bom dia','boa tarde','boa noite'].some(g => t.includes(g));
    if (ehSaudacao) {
      await enviar(numero, '⏳ Sua mensagem anterior já está com o farmacêutico da sua UBS.\n\nAssim que ele responder, você receberá uma mensagem aqui. Para urgências: SAMU 192.');
    }
    return;
  }

  // 2. Saudação com paciente identificado
  const ehSaudacao = ['oi','olá','ola','bom dia','boa tarde','boa noite'].some(g => t.includes(g));
  if (ehSaudacao) {
    const primeiroNome = paciente.nome.split(' ')[0];
    await enviar(numero,
      `👋 Olá, *${primeiroNome}*! Bem-vindo(a) de volta!\n\n` +
      `Você está cadastrado(a) na *${paciente.ubs_nome}*.\n\n` +
      `Como posso te ajudar hoje?`
    );
    return;
  }

  // 3. Dúvida de estoque → farmacêutico
  if (GATILHOS_ESTOQUE.some(g => t.includes(g))) {
    const farmaceutico = await buscarFarmaceuticoDaUbs(paciente.ubs_nome);
    await salvarPendencia(paciente.nome, numero, texto, paciente.ubs_nome, farmaceutico?.id || null);
    await enviar(numero,
      `Sua dúvida sobre medicamento foi encaminhada para o farmacêutico da *${paciente.ubs_nome}*. ⏳\n\n` +
      `Em breve você receberá uma resposta. Para emergências: SAMU 192.`
    );
    return;
  }

  // 4. FAQ
  const faqMatch = FAQ.find(f => f.gatilhos && f.resposta && f.gatilhos.some(g => t.includes(g)));
  if (faqMatch) {
    await enviar(numero, faqMatch.resposta);
    return;
  }

  // 5. IA (Claude via Supabase Edge Function)
  if (!historicos[numero]) historicos[numero] = [];
  historicos[numero].push({ role: 'user', content: texto });
  if (historicos[numero].length > 10) historicos[numero] = historicos[numero].slice(-10);

  try {
    const ctx = `\nPACIENTE: ${paciente.nome}, ${paciente.idade || '?'} anos. ` +
      `UBS: ${paciente.ubs_nome}. ` +
      `Condições: ${(paciente.condicoes || []).join(', ') || 'não informado'}. ` +
      `Medicamentos: ${(paciente.medicamentos || []).map(m => `${m.nome} (${m.dose})`).join('; ') || 'não informado'}.`;

    const res = await fetch(`${SUPA_URL}/functions/v1/rapid-handler`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SUPA_KEY}`,
        'apikey': SUPA_KEY
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 500,
        system: SYSTEM + ctx,
        messages: historicos[numero]
      })
    });
    const d = await res.json();
    const resposta = d.content?.[0]?.text;
    if (!resposta) throw new Error('Sem resposta da IA');
    historicos[numero].push({ role: 'assistant', content: resposta });
    await enviar(numero, resposta);
  } catch (e) {
    console.error('Erro IA:', e.message);
    // Escala para farmacêutico se IA falhar
    const farmaceutico = await buscarFarmaceuticoDaUbs(paciente.ubs_nome);
    await salvarPendencia(paciente.nome, numero, texto, paciente.ubs_nome, farmaceutico?.id || null);
    await enviar(numero,
      'Não consegui responder sua dúvida agora. ' +
      `Encaminhei para o farmacêutico da *${paciente.ubs_nome}*. ⏳\n\n` +
      'Para emergências: SAMU 192.'
    );
  }
}

// ── Webhook Meta ──────────────────────────────────────────────────────────────
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === META_VERIFY_TOKEN) {
    console.log('✅ Webhook verificado!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const messages = req.body.entry?.[0]?.changes?.[0]?.value?.messages;
    if (!messages?.length) return;

    for (const msg of messages) {
      if (msg.type !== 'text') continue;
      const numero = msg.from;
      const texto = msg.text?.body || '';
      if (!texto.trim()) continue;
      console.log(`📩 De: ${numero} | Msg: ${texto}`);
      await processar(numero, texto);
    }
  } catch (e) { console.error('Erro webhook:', e.message); }
});

// ── Endpoint: farmacêutico responde ao paciente ───────────────────────────────
// Chamado pelo painel do farmacêutico
// Body: { conversa_id, numero_paciente, mensagem, nome_farmaceutico, nome_ubs }
app.post('/responder', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });

  const { conversa_id, numero_paciente, mensagem, nome_farmaceutico, nome_ubs } = req.body;
  if (!conversa_id || !numero_paciente || !mensagem) {
    return res.status(400).json({ erro: 'conversa_id, numero_paciente e mensagem são obrigatórios' });
  }

  try {
    // Assina a mensagem com nome do farmacêutico e UBS
    const textoAssinado = `👩‍⚕️ *${nome_farmaceutico || 'Farmacêutico(a)'}* — ${nome_ubs || 'Assistência Farmacêutica Trindade'}\n\n${mensagem}`;

    // Envia via WhatsApp
    const resultadoEnvio = await enviar(numero_paciente, textoAssinado);
    if (resultadoEnvio?.error) {
      return res.status(500).json({ erro: 'Falha ao enviar mensagem WhatsApp', detalhe: resultadoEnvio.error });
    }

    // Salva a resposta no histórico da conversa
    await adicionarMsgPendencia(conversa_id, textoAssinado, 'farmaceutico');

    // Marca conversa como resolvida
    await supaFetch(`farmabot_conversas?id=eq.${conversa_id}`, {
      method: 'PATCH',
      body: JSON.stringify({ pendente: false })
    });

    // Recarrega cache de pacientes (caso tenha sido atualizado)
    await carregarPacientesCache();

    res.json({ ok: true, mensagem: 'Resposta enviada e conversa resolvida' });
  } catch (e) {
    console.error('Erro /responder:', e.message);
    res.status(500).json({ erro: e.message });
  }
});

// ── Proxy Claude ──────────────────────────────────────────────────────────────
app.post('/api/claude', async (req, res) => {
  const CLAUDE_KEY = process.env.CLAUDE_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ erro: 'CLAUDE_KEY não configurada' });
  try {
    const { model, max_tokens, system, messages } = req.body;
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: model||'claude-sonnet-4-6', max_tokens: max_tokens||1000, system: system||'', messages: messages||[] })
    });
    const d = await r.json();
    res.json(d);
  } catch (e) {
    res.status(500).json({ erro: e.message });
  }
});

// ── Proxy Groq (análise clínica IA) ──────────────────────────────────────────
app.post('/api/gemini', async (req, res) => {
  const GROQ_KEY = process.env.GROQ_KEY;
  if (!GROQ_KEY) return res.status(500).json({ erro: 'GROQ_KEY não configurada' });
  try {
    const { prompt } = req.body;
    if (!prompt) return res.status(400).json({ erro: 'prompt é obrigatório' });
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${GROQ_KEY}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: 'Você é um farmacêutico clínico especialista em farmácia hospitalar e geriatria. Analise prescrições de forma objetiva e prática para farmacêuticos do SUS.' },
          { role: 'user', content: prompt }
        ],
        max_tokens: 1000,
        temperature: 0.3
      })
    });
    const d = await r.json();
    const texto = d.choices?.[0]?.message?.content;
    if (!texto) throw new Error(JSON.stringify(d));
    res.json({ ok: true, texto });
  } catch (e) {
    console.error('Erro /api/gemini (Groq):', e.message);
    res.status(500).json({ erro: e.message });
  }
});


function checkAdmin(req, res) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== ADMIN_TOKEN) { res.status(401).json({ erro: 'Não autorizado' }); return false; }
  return true;
}

app.get('/admin/ubs', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const data = await supaFetch('farmabot_ubs?select=*&status=eq.ativo');
    res.json({ total: Array.isArray(data) ? data.length : 0, ubs: data || [] });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/admin/ubs', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { nome_ubs, phone_number_id, numero_whatsapp, display_name } = req.body;
  if (!nome_ubs) return res.status(400).json({ erro: 'nome_ubs é obrigatório' });
  try {
    const data = await supaFetch('farmabot_ubs', {
      method: 'POST',
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify({
        nome_ubs,
        phone_number_id: phone_number_id || META_PHONE_NUMBER_ID, // usa o central se não informar
        numero_whatsapp: numero_whatsapp || '62 9410-3358',
        display_name: display_name || 'Assistência Farmacêutica Trindade',
        status: 'ativo'
      })
    });
    res.json({ ok: true, data });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});

app.post('/admin/recarregar', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  await carregarPacientesCache();
  await carregarHorariosPadraoCache();
  res.json({ ok: true, pacientes: pacientesCache.length, horarios: horariosPadraoCache.size });
});

// ── Status ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({
  status: '✅ FarmaBot SUS Online',
  versao: '4.0.0-numero-central',
  municipio: 'Trindade-GO — DAF',
  numero_central: '62 9410-3358',
  pacientesMonitorados: pacientesCache.length,
  horariosPadrao: horariosPadraoCache.size,
  webhook: '/webhook',
  endpoints: ['POST /responder', 'GET /admin/ubs', 'POST /admin/ubs', 'POST /admin/recarregar']
}));

app.listen(PORT, () => {
  console.log(`✅ FarmaBot SUS v4.0.0 rodando na porta ${PORT}`);
  console.log(`📱 Número central: 62 9410-3358 (${META_PHONE_NUMBER_ID})`);
  console.log(`🔗 Webhook: /webhook`);
});
