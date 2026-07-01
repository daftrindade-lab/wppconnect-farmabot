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
const GATILHOS_QUEIXA = ['efeito colateral','reação','reacao','me fez mal','passou mal','enjoei','enjoo','tontura','coceira','alergia','inchaço','inchaco','vermelhidão','vermelhidao','dor de barriga','náusea','nausea','vomitei','vômito','vomito','dor de cabeça','dor de cabeca','fraqueza','mal estar','mal-estar','queixa','reclamação','reclamacao','não estou bem com o remédio','remédio me faz mal'];

// Estado do fluxo de queixas
const fluxoQueixa = {}; // numero -> { etapa, dados }

const SYSTEM = `Você é a FarmaBot, assistente farmacêutica virtual da Assistência Farmacêutica de Trindade-GO.
PERFIL: Idosos com HAS/DM, polimedicados, baixa escolaridade.
REGRAS: Linguagem simples e acolhedora. Máx 3 parágrafos curtos. Nunca altere doses. Não confirme disponibilidade de medicamentos (isso vai para o farmacêutico). Emergências: SAMU 192.`;

// ── Helpers Supabase ──────────────────────────────────────────────────────────
async function supaFetch(path, opts = {}) {
  const { headers: optsHeaders, ...restOpts } = opts;
  const res = await fetch(`${SUPA_URL}/rest/v1/${path}`, {
    ...restOpts,
    headers: {
      "apikey": SUPA_KEY,
      "Authorization": `Bearer ${SUPA_KEY}`,
      "Content-Type": "application/json",
      ...optsHeaders
    }
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

// ── Normalizar número ─────────────────────────────────────────────────────────
function normalizarNumero(numero) {
  const digits = numero.replace(/\D/g, '');
  return digits.startsWith('55') ? digits.slice(2) : digits;
}

// ── Pendências ────────────────────────────────────────────────────────────────
async function buscarPendenciaAberta(numero) {
  try {
    const num = normalizarNumero(numero);
    // Busca conversa PENDENTE pelo número exato
    const res = await supaFetch(`farmabot_conversas?numero=eq.${num}&pendente=eq.true&order=criado_em.desc&limit=1`);
    if (Array.isArray(res) && res[0]) return res[0];
    // Tenta variação com/sem 9
    const numAlt = num.length === 11 ? num.slice(0,2) + num.slice(3) : num.slice(0,2) + '9' + num.slice(2);
    const res2 = await supaFetch(`farmabot_conversas?numero=eq.${numAlt}&pendente=eq.true&order=criado_em.desc&limit=1`);
    if (Array.isArray(res2) && res2[0]) return res2[0];
    // Busca conversa das últimas 24h (mesmo resolvida) para continuar o diálogo
    const ontemISO = new Date(Date.now() - 24*60*60*1000).toISOString();
    const res3 = await supaFetch(`farmabot_conversas?numero=eq.${num}&criado_em=gte.${ontemISO}&order=criado_em.desc&limit=1`);
    if (Array.isArray(res3) && res3[0]) {
      // Reabre a conversa
      await fetch(`${SUPA_URL}/rest/v1/farmabot_conversas?id=eq.${res3[0].id}`, {
        method: 'PATCH',
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({ pendente: true })
      });
      return res3[0];
    }
    return null;
  } catch { return null; }
}

async function salvarPendencia(pacienteNome, numero, mensagem, ubsNome, farmaceuticoId) {
  try {
    const num = normalizarNumero(numero);
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    console.log(`💾 Salvando pendência: ${pacienteNome} | ${num} | ${ubsNome}`);
    const resultado = await supaFetch(`farmabot_conversas`, {
      method: 'POST',
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify({
        id: `wa_${Date.now()}`,
        paciente: pacienteNome || num,
        numero: num,
        unidade: ubsNome || null,
        farmaceutico_id: farmaceuticoId || null,
        msgs: [
          { tipo: 'paciente', texto: mensagem, hora },
          { tipo: 'bot', texto: 'Mensagem encaminhada ao farmacêutico da sua unidade. ⏳', hora }
        ],
        pendente: true,
        hora
      })
    });
    console.log(`💾 Resultado salvarPendencia:`, JSON.stringify(resultado).substring(0, 200));
  } catch (e) { console.error('❌ Erro salvarPendencia:', e.message); }
}

async function adicionarMsgPendencia(conversaId, texto, tipo) {
  try {
    const conv = await supaFetch(`farmabot_conversas?id=eq.${conversaId}&select=msgs`);
    const msgs = Array.isArray(conv) && conv[0] ? conv[0].msgs || [] : [];
    const hora = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    msgs.push({ tipo, texto, hora });
    const res = await fetch(`${SUPA_URL}/rest/v1/farmabot_conversas?id=eq.${conversaId}`, {
      method: 'PATCH',
      headers: {
        'apikey': SUPA_KEY,
        'Authorization': `Bearer ${SUPA_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({ msgs, pendente: true })
    });
    if (!res.ok) console.error('Erro PATCH conversa:', res.status);
  } catch (e) { console.error('Erro adicionarMsg:', e.message); }
}

// ── Enviar mensagem via Meta Cloud API ────────────────────────────────────────
async function enviar(numero, texto) {
  try {
    // Remove tudo que não é dígito
    const digits = numero.replace(/\D/g, '');
    // Remove código do país 55 se presente
    const semPais = digits.startsWith('55') ? digits.slice(2) : digits;
    // Usa o número como veio — sem forçar 11 dígitos
    // Isso preserva números sem o 9 (8 dígitos locais) que o WhatsApp já aceita
    const numFinal = `55${semPais}`;

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
          to: numFinal,
          type: 'text',
          text: { body: texto }
        })
      }
    );
    const data = await res.json();
    if (data.error) {
      console.error('❌ Erro Meta:', JSON.stringify(data.error));
    } else {
      console.log(`✅ Mensagem enviada para ${numFinal}`);
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

// ── Motor de alertas de renovação de receita ─────────────────────────────────
async function checarRenovacaoReceitas() {
  try {
    const hoje = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    const hojeStr = hoje.toLocaleDateString('en-CA');
    console.log(`📋 Checando renovação de receitas — ${hojeStr}`);

    const res = await fetch(`${SUPA_URL}/rest/v1/farmabot_pacientes?select=id,nome,telefone,ubs_nome,medicamentos`, {
      headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` }
    });
    const pacientes = await res.json();
    if (!Array.isArray(pacientes)) return;

    for (const paciente of pacientes) {
      const meds = paciente.medicamentos || [];
      const medsVencendo = meds.filter(m => {
        if (!m.data_prescricao) return false;
        const dp = new Date(m.data_prescricao);
        const dias = Math.floor((hoje - dp) / (1000 * 60 * 60 * 24));
        return dias >= 150 && dias <= 160;
      });
      if (!medsVencendo.length) continue;

      const primeiroNome = (paciente.nome || '').split(' ')[0];
      const listaMeds = medsVencendo.map(m => `• ${m.nome}`).join('\n');
      const dataVenc = new Date(medsVencendo[0].data_prescricao);
      dataVenc.setMonth(dataVenc.getMonth() + 6);
      const dataVencStr = dataVenc.toLocaleDateString('pt-BR');

      const msgPaciente =
        `📋 Olá, *${primeiroNome}*! Sua receita médica está próxima do vencimento.\n\n` +
        `Os seguintes medicamentos precisam de receita nova até *${dataVencStr}*:\n${listaMeds}\n\n` +
        `Por favor, agende uma consulta com seu médico com antecedência para não ficar sem medicamento. 💊`;

      await enviar(paciente.telefone, msgPaciente);

      // Salva alerta para o farmacêutico ver no painel
      await supaFetch('farmabot_alertas_renovacao', {
        method: 'POST',
        headers: { "Prefer": "resolution=ignore-duplicates" },
        body: JSON.stringify({
          paciente_id: paciente.id,
          paciente_nome: paciente.nome,
          ubs_nome: paciente.ubs_nome,
          medicamentos: medsVencendo.map(m => m.nome),
          data_alerta: hojeStr,
          status: 'pendente'
        })
      });
      console.log(`📋 Alerta renovação: ${paciente.nome} | ${medsVencendo.length} med(s)`);
    }
  } catch (e) { console.error('Erro renovação:', e.message); }
}

// Agenda para rodar todo dia às 8h (Brasília)
function agendarRenovacao() {
  const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const prox = new Date(agora);
  prox.setHours(8, 0, 0, 0);
  if (agora >= prox) prox.setDate(prox.getDate() + 1);
  const ms = prox - agora;
  setTimeout(() => {
    checarRenovacaoReceitas();
    setInterval(checarRenovacaoReceitas, 24 * 60 * 60 * 1000);
  }, ms);
  console.log(`📋 Renovação agendada para 08:00 (em ${Math.round(ms/60000)} min)`);
}
agendarRenovacao();

// ── Motor de educação em saúde semanal ───────────────────────────────────────
// Segunda-feira às 8h, alternando: semana ímpar = dica sobre condição, semana par = dica sobre medicamentos

const DICAS_CONDICAO = {
  'HAS': [
    '❤️ *Dica sobre Pressão Alta*\n\nReduzir o sal na alimentação é um dos passos mais importantes para controlar a pressão. Evite alimentos industrializados, embutidos e temperos prontos. Prefira temperos naturais como alho, cebola e ervas.',
    '❤️ *Dica sobre Pressão Alta*\n\nCaminhar 30 minutos por dia, 5 vezes por semana, ajuda a baixar a pressão naturalmente. Comece devagar e aumente o ritmo gradualmente. Consulte seu médico antes de iniciar exercícios.',
    '❤️ *Dica sobre Pressão Alta*\n\nMeça sua pressão regularmente e anote os valores. Leve esse registro às consultas — ajuda muito o médico a ajustar o tratamento. Pressão ideal: abaixo de 130x80 mmHg.',
  ],
  'DM': [
    '🩺 *Dica sobre Diabetes*\n\nEvite açúcar, refrigerantes e sucos industrializados. Prefira frutas inteiras (não suco), verduras e alimentos integrais. Coma em pequenas porções várias vezes ao dia.',
    '🩺 *Dica sobre Diabetes*\n\nCuide dos seus pés todos os dias: lave com água morna, seque bem entre os dedos e observe se tem feridas ou calosidades. Diabéticos têm mais dificuldade de cicatrizar.',
    '🩺 *Dica sobre Diabetes*\n\nFaça a glicemia em jejum regularmente. Valores normais: entre 70 e 100 mg/dL em jejum. Se estiver acima de 250 mg/dL com sintomas (sede excessiva, urina frequente), procure atendimento.',
  ],
  'DEFAULT': [
    '💊 *Dica de Saúde*\n\nTome seus remédios sempre no mesmo horário. Isso ajuda o corpo a manter o nível certo do medicamento no sangue e melhora muito o resultado do tratamento.',
    '💊 *Dica de Saúde*\n\nNunca pare de tomar os remédios sem falar com o médico, mesmo que esteja se sentindo bem. Muitas doenças crônicas não têm sintomas quando estão controladas — é o remédio fazendo efeito!',
    '💊 *Dica de Saúde*\n\nGuarde seus remédios em local fresco, seco e sem luz direta do sol. Evite guardar no banheiro ou cozinha — o calor e a umidade estragam os medicamentos.',
  ]
};

const DICAS_MEDICAMENTOS = [
  '💊 *Dica sobre seus remédios*\n\nSe esquecer de tomar uma dose, tome assim que lembrar — *a não ser que esteja quase na hora da próxima*. Nesse caso, pule a dose esquecida. Nunca tome duas doses de uma vez.',
  '💊 *Dica sobre seus remédios*\n\nAlguns remédios não podem ser partidos ou mastigados — como os de liberação prolongada. Sempre verifique com o farmacêutico se pode ou não partir o comprimido.',
  '💊 *Dica sobre seus remédios*\n\nAvise sempre seu médico e dentista sobre todos os remédios que está tomando, incluindo vitaminas e remédios caseiros. Alguns podem interagir entre si.',
  '💊 *Dica sobre seus remédios*\n\nNão tome remédios vencidos. Verifique a data de validade antes de usar e descarte medicamentos vencidos na farmácia — não jogue no lixo comum ou na pia.',
  '💊 *Dica sobre seus remédios*\n\nBeba bastante água ao tomar seus remédios (pelo menos meio copo). Isso ajuda na absorção e protege o estômago e os rins.',
];

function getDicaSemana(paciente) {
  const agora = new Date();
  const semanaAno = Math.ceil((agora - new Date(agora.getFullYear(), 0, 1)) / (7 * 24 * 60 * 60 * 1000));
  const ehSemanaImpar = semanaAno % 2 !== 0;

  if (ehSemanaImpar) {
    // Dica sobre condição do paciente
    const condicoes = (paciente.condicoes || []).map(c => c.toUpperCase());
    if (condicoes.some(c => c.includes('HAS') || c.includes('HIPERTENS'))) {
      const dicas = DICAS_CONDICAO['HAS'];
      return dicas[semanaAno % dicas.length];
    }
    if (condicoes.some(c => c.includes('DM') || c.includes('DIABET'))) {
      const dicas = DICAS_CONDICAO['DM'];
      return dicas[semanaAno % dicas.length];
    }
    const dicas = DICAS_CONDICAO['DEFAULT'];
    return dicas[semanaAno % dicas.length];
  } else {
    // Dica sobre medicamentos
    return DICAS_MEDICAMENTOS[semanaAno % DICAS_MEDICAMENTOS.length];
  }
}

async function enviarEducacaoSemanal() {
  try {
    const agora = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
    if (agora.getDay() !== 1) return; // Só segunda-feira (0=dom, 1=seg)
    console.log('📚 Enviando educação em saúde semanal...');

    const res = await fetch(`${SUPA_URL}/rest/v1/farmabot_pacientes?select=id,nome,telefone,condicoes,medicamentos`, {
      headers: { "apikey": SUPA_KEY, "Authorization": `Bearer ${SUPA_KEY}` }
    });
    const pacientes = await res.json();
    if (!Array.isArray(pacientes)) return;

    let enviados = 0;
    for (const paciente of pacientes) {
      if (!paciente.telefone) continue;
      const dica = getDicaSemana(paciente);
      const primeiroNome = (paciente.nome || '').split(' ')[0];
      const msg = `🌟 Olá, *${primeiroNome}*! Aqui está a dica de saúde desta semana:\n\n${dica}\n\n_Sua Assistência Farmacêutica de Trindade-GO_ 💚`;
      await enviar(paciente.telefone, msg);
      enviados++;
    }
    console.log(`📚 Educação semanal: ${enviados} mensagem(s) enviada(s)`);
  } catch(e) { console.error('Erro educação semanal:', e.message); }
}

// Checa todo dia às 8h se é segunda-feira
setInterval(enviarEducacaoSemanal, 24 * 60 * 60 * 1000);

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

async function processarFluxoQueixa(numero, texto, t, paciente) {
  const fluxo = fluxoQueixa[numero];

  if (fluxo.etapa === 'medicamento') {
    fluxo.dados.medicamento = t.includes('não sei') || t.includes('nao sei') ? null : texto;
    fluxo.etapa = 'gravidade';
    await enviar(numero,
      `Obrigada por me contar. Agora me diga: como você está se sentindo?\n\n` +
      `1️⃣ Leve — incomoda mas consigo fazer minhas atividades\n` +
      `2️⃣ Moderada — está atrapalhando minhas atividades\n` +
      `3️⃣ Grave — precisei ou preciso de atendimento médico\n\n` +
      `Responda com o número (1, 2 ou 3):`
    );
    return;
  }

  if (fluxo.etapa === 'gravidade') {
    let gravidade = 'moderada';
    if (t.includes('1') || t.includes('leve')) gravidade = 'leve';
    else if (t.includes('3') || t.includes('grave')) gravidade = 'grave';
    else if (t.includes('2') || t.includes('moderada')) gravidade = 'moderada';

    fluxo.dados.gravidade = gravidade;
    delete fluxoQueixa[numero];

    // Salva a queixa
    try {
      const res = await fetch(`${SUPA_URL}/rest/v1/farmabot_queixas`, {
        method: 'POST',
        headers: {
          'apikey': SUPA_KEY,
          'Authorization': `Bearer ${SUPA_KEY}`,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal'
        },
        body: JSON.stringify({
          paciente_id: paciente?.id || null,
          paciente_nome: paciente?.nome || numero,
          telefone: numero,
          ubs_nome: paciente?.ubs_nome || null,
          descricao: fluxo.dados.descricao,
          medicamento: fluxo.dados.medicamento,
          gravidade,
          status: 'pendente',
          data_registro: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
        })
      });
      if (!res.ok) console.error('Erro salvar queixa:', res.status);
      else console.log(`⚠️ Queixa registrada: ${paciente?.nome || numero} | ${gravidade}`);
    } catch(e) { console.error('Erro salvar queixa:', e.message); }

    if (gravidade === 'grave') {
      await enviar(numero,
        `🚨 Sua queixa foi registrada como *GRAVE* e encaminhada urgentemente para o farmacêutico da sua UBS.\n\n` +
        `Se precisar de atendimento imediato, ligue para o *SAMU: 192*.\n\nCuide-se! 💚`
      );
    } else {
      await enviar(numero,
        `✅ Sua queixa foi registrada e encaminhada para o farmacêutico da sua UBS.\n\n` +
        `Em breve você receberá orientações. Para urgências: SAMU *192* 🚑`
      );
    }
    return;
  }
}


async function processarMensagem(numero, texto, t, paciente) {

  // 1.5 Fluxo de queixa em andamento
  if (fluxoQueixa[numero]) {
    await processarFluxoQueixa(numero, texto, t, paciente);
    return;
  }

  // 1.6 Detecção automática de queixa
  if (GATILHOS_QUEIXA.some(g => t.includes(g))) {
    fluxoQueixa[numero] = { etapa: 'medicamento', dados: { descricao: texto } };
    await enviar(numero,
      `Entendo que você está passando por algum desconforto. Vou registrar sua queixa para o farmacêutico.\n\n` +
      `Qual medicamento você acha que está causando esse problema? (Se não souber, escreva "não sei")`
    );
    return;
  }
  const pendenciaAberta = await buscarPendenciaAberta(numero);
  const ehSaudacao = ['oi','olá','ola','bom dia','boa tarde','boa noite','hello','hey'].some(g => t.trim() === g || t.trim().startsWith(g + ' ') || t.trim().endsWith(' ' + g));

  if (pendenciaAberta && !ehSaudacao) {
    // Mensagem de conteúdo — adiciona à conversa pendente
    await adicionarMsgPendencia(pendenciaAberta.id, texto, 'paciente');
    await enviar(numero, '⏳ Sua mensagem foi adicionada ao atendimento em aberto com o farmacêutico da *' + (paciente.ubs_nome||'sua UBS') + '*.\n\nAssim que ele responder, você receberá uma mensagem aqui. Para urgências: SAMU 192.');
    return;
  }

  // Saudações respondem normalmente independente de pendência aberta
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
  const matchEstoque = GATILHOS_ESTOQUE.find(g => t.includes(g));
  // Detecta também perguntas com "tem + nome" genérico
  const perguntaEstoque = matchEstoque || (t.startsWith('tem ') && t.length > 6) || t.includes('tem esse') || t.includes('disponivel') || t.includes('disponível');
  console.log(`🔍 Texto: "${t}" | Match estoque: ${perguntaEstoque ? 'sim' : 'não'}`);
  if (perguntaEstoque) {
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

// ── Base de orientações fixas por medicamento ─────────────────────────────────
const ORIENTACOES_BASE = {
  'METFORMINA': ['Tome sempre junto com as refeições para evitar enjoo e dor de barriga.','Nunca pare de tomar sem orientação médica, mesmo se a glicemia melhorar.','Beba bastante água durante o dia.'],
  'GLIBENCLAMIDA': ['Tome 30 minutos antes do café da manhã.','Nunca pule refeições enquanto estiver usando esse remédio — pode causar fraqueza e tontura (hipoglicemia).','Se sentir tremores, suor frio ou tontura, coma algo doce imediatamente.'],
  'GLICLAZIDA': ['Tome junto com o café da manhã.','Mantenha horário fixo todos os dias.','Monitore a glicemia regularmente.'],
  'INSULINA': ['Aplique sempre no mesmo horário.','Guarde na geladeira (não no freezer). Fora da geladeira dura até 30 dias.','Alterne os locais de aplicação para evitar caroços na pele.','Nunca aplique insulina gelada — tire da geladeira 30 minutos antes.'],
  'CAPTOPRIL': ['Tome em jejum, 1 hora antes das refeições.','Pode causar tosse seca — se incomodar muito, avise o médico.','Levante-se devagar da cama para evitar tontura.'],
  'ENALAPRIL': ['Tome sempre no mesmo horário, com ou sem alimentos.','Pode causar tosse seca. Avise o médico se aparecer.','Evite sal em excesso na alimentação.'],
  'LOSARTANA': ['Pode ser tomada com ou sem alimentos.','Não use substitutos de sal (cloreto de potássio) sem autorização médica.','Levante-se devagar para evitar tontura.'],
  'ANLODIPINO': ['Pode ser tomado com ou sem alimentos.','Não tome suco de toranja (grapefruit) — interfere no medicamento.','Se sentir inchaço nos pés, avise o médico.'],
  'ATENOLOL': ['Tome sempre no mesmo horário.','Nunca pare de tomar de repente — pode ser perigoso para o coração.','Pode causar cansaço e pés frios no início.'],
  'CARVEDILOL': ['Tome junto com as refeições para melhor absorção.','Nunca interrompa sem orientação médica.','Meça a pressão e o pulso regularmente.'],
  'HIDROCLOROTIAZIDA': ['Tome pela manhã para não atrapalhar o sono.','Aumente o consumo de alimentos ricos em potássio (banana, laranja, feijão).','Beba bastante água durante o dia.'],
  'FUROSEMIDA': ['Tome pela manhã — causa aumento de urina.','Não tome à noite para não atrapalhar o sono.','Repor potássio com alimentação (banana, laranja, abacate).'],
  'ESPIRONOLACTONA': ['Tome junto com as refeições.','Evite alimentos muito ricos em potássio em excesso.','Pode causar tontura nas primeiras semanas.'],
  'SINVASTATINA': ['Tome à noite, antes de dormir — o efeito é melhor.','Não tome suco de toranja (grapefruit).','Se sentir dor muscular forte, avise o médico imediatamente.'],
  'ROSUVASTATINA': ['Pode ser tomada a qualquer hora do dia.','Não tome antiácidos 2 horas após tomar esse remédio.','Se sentir dor muscular forte, avise o médico.'],
  'OMEPRAZOL': ['Tome em jejum, 30 a 60 minutos antes do café da manhã.','Engolha inteiro — não mastigue nem abra a cápsula.','Use pelo tempo indicado pelo médico.'],
  'LEVOTIROXINA': ['Tome em jejum, 30 a 60 minutos antes do café da manhã.','Não tome junto com leite, cálcio ou ferro — atrapalha a absorção.','Mantenha horário fixo todos os dias.'],
  'PREDNISONA': ['Tome sempre junto com o café da manhã para proteger o estômago.','Nunca pare de tomar de repente — reduza a dose gradualmente com orientação médica.','Evite pessoas doentes — esse remédio reduz as defesas do organismo.'],
  'DIPIRONA': ['Pode ser tomada com ou sem alimentos.','Use apenas quando necessário para dor ou febre.','Respeite o intervalo mínimo de 6 horas entre as doses.'],
  'AMIODARONA': ['Tome junto com as refeições.','Evite exposição prolongada ao sol — use protetor solar.','Faça os exames de sangue (tireoide, fígado) regularmente conforme orientação médica.','Avise todos os médicos que trata que está usando esse remédio.'],
  'DIGOXINA': ['Tome sempre no mesmo horário, com ou sem alimentos.','Nunca tome dose dupla se esquecer uma dose.','Avise o médico se sentir náusea, visão amarelada ou batimentos irregulares.'],
  'CLOPIDOGREL': ['Tome com ou sem alimentos.','Avise o dentista e todos os médicos que você toma esse remédio antes de qualquer procedimento.','Se tiver corte que não para de sangrar, procure atendimento médico.'],
  'VARFARINA': ['Tome sempre no mesmo horário.','Mantenha alimentação regular — variações no consumo de verduras escuras (couve, espinafre) alteram o efeito.','Faça o exame de coagulação (INR) regularmente.','Avise todos os profissionais de saúde que usa esse remédio.'],
  'CLONAZEPAM': ['Tome no horário indicado — não aumente a dose por conta própria.','Não beba álcool enquanto estiver usando.','Não dirija ou opere máquinas — pode causar sonolência.','Não pare de tomar de repente — reduzir gradualmente com orientação médica.'],
  'DIAZEPAM': ['Não beba álcool.','Pode causar dependência — use apenas pelo tempo prescrito.','Não dirija enquanto estiver usando.'],
  'HALOPERIDOL': ['Tome no horário indicado.','Levante-se devagar para evitar tontura.','Pode causar rigidez muscular — avise o médico se ocorrer.'],
  'FLUOXETINA': ['Pode ser tomada com ou sem alimentos.','O efeito completo leva 2 a 4 semanas — não desista nas primeiras semanas.','Não pare de tomar de repente.'],
  'AMITRIPTILINA': ['Tome à noite — causa sonolência.','Não beba álcool.','Levante-se devagar da cama.'],
  'DOMPERIDONA': ['Tome 15 a 30 minutos antes das refeições.','Não use por mais de 7 dias sem orientação médica.'],
  'METOCLOPRAMIDA': ['Tome 30 minutos antes das refeições.','Use apenas pelo tempo prescrito — não use por mais de 5 dias.'],
  'FENOBARBITAL': ['Tome sempre no mesmo horário.','Nunca pare de tomar sem orientação — pode causar convulsões.','Não beba álcool.'],
  'CARBAMAZEPINA': ['Tome junto com as refeições.','Faça exames de sangue regularmente.','Pode reduzir o efeito de anticoncepcionais.'],
};

function buscarOrientacoesFixas(nomeMedicamento) {
  const nome = nomeMedicamento.toUpperCase();
  for (const [chave, orientacoes] of Object.entries(ORIENTACOES_BASE)) {
    if (nome.includes(chave)) return orientacoes;
  }
  return [];
}

// ── Endpoint: enviar orientações farmacêuticas ────────────────────────────────
// Body: { paciente_id, telefone, nome_paciente, medicamentos: [{nome, dose, horarios}], condicoes }
app.post('/orientacoes', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });

  const { paciente_id, telefone, nome_paciente, medicamentos, condicoes, mensagem_customizada } = req.body;
  if (!telefone) return res.status(400).json({ erro: 'telefone é obrigatório' });

  try {
    // Se farmacêutico editou e aprovou a mensagem, usa ela diretamente
    if (mensagem_customizada) {
      await enviar(telefone, mensagem_customizada);
      console.log(`📤 Orientações (customizadas) enviadas para ${telefone}`);
      return res.json({ ok: true });
    }

    if (!medicamentos?.length) return res.status(400).json({ erro: 'medicamentos são obrigatórios' });
    const primeiroNome = (nome_paciente || '').split(' ')[0];

    // 1. Monta orientações fixas para cada medicamento
    let blocoOrientacoes = '';
    for (const med of medicamentos) {
      const fixas = buscarOrientacoesFixas(med.nome);
      if (fixas.length) {
        blocoOrientacoes += `\n💊 *${med.nome}* (${med.dose||''})\n`;
        fixas.forEach(o => { blocoOrientacoes += `• ${o}\n`; });
      }
    }

    // 2. Complementa com IA (Groq) se houver condições do paciente
    let complementoIA = '';
    if (process.env.GROQ_KEY && condicoes?.length) {
      try {
        const prompt = `Gere orientações farmacêuticas CURTAS e SIMPLES (máx 3 por medicamento) para um paciente com ${condicoes.join(', ')}, usando os medicamentos: ${medicamentos.map(m=>m.nome).join(', ')}. Foco em interações com alimentação, horários e sinais de alerta. Linguagem simples para idosos de baixa escolaridade. Máx 150 palavras no total.`;
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.GROQ_KEY}` },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: prompt }],
            max_tokens: 300, temperature: 0.3
          })
        });
        const d = await r.json();
        const texto = d.choices?.[0]?.message?.content;
        if (texto) complementoIA = `\n\n🤖 *Orientação personalizada:*\n${texto}`;
      } catch(e) { console.error('IA orientações:', e.message); }
    }

    // 3. Monta mensagem final
    const horariosMeds = medicamentos.map(m => `• ${m.nome}: ${(m.horarios||[]).join(', ')}`).join('\n');
    const msg =
      `👋 Olá, *${primeiroNome}*! Aqui estão as orientações sobre seus medicamentos:\n` +
      `\n⏰ *Horários de hoje:*\n${horariosMeds}` +
      (blocoOrientacoes ? `\n\n📋 *Orientações importantes:*${blocoOrientacoes}` : '') +
      (complementoIA || '') +
      `\n\n❓ Qualquer dúvida, pode responder aqui. Sua saúde é nossa prioridade! 💚`;

    await enviar(telefone, msg);
    console.log(`📤 Orientações enviadas para ${nome_paciente}`);
    res.json({ ok: true, mensagem: 'Orientações enviadas com sucesso' });
  } catch (e) {
    console.error('Erro /orientacoes:', e.message);
    res.status(500).json({ erro: e.message });
  }
});


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

    // Não marca como resolvida automaticamente — farmacêutico decide quando resolver
    res.json({ ok: true, mensagem: 'Resposta enviada' });
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

// ── Registro de queixas/reações adversas ─────────────────────────────────────
app.post('/queixa', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });
  const { paciente_id, paciente_nome, telefone, ubs_nome, descricao, medicamento, gravidade } = req.body;
  if (!descricao) return res.status(400).json({ erro: 'descricao é obrigatória' });
  try {
    const data = await supaFetch('farmabot_queixas', {
      method: 'POST',
      headers: { "Prefer": "return=representation" },
      body: JSON.stringify({
        paciente_id: paciente_id || null,
        paciente_nome: paciente_nome || 'Não identificado',
        telefone: telefone || null,
        ubs_nome: ubs_nome || null,
        descricao,
        medicamento: medicamento || null,
        gravidade: gravidade || 'moderada',
        status: 'pendente',
        data_registro: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })
      })
    });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.get('/queixas', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });
  try {
    const { ubs, status } = req.query;
    let path = 'farmabot_queixas?order=data_registro.desc&limit=100';
    if (ubs) path += `&ubs_nome=eq.${encodeURIComponent(ubs)}`;
    if (status) path += `&status=eq.${status}`;
    const data = await supaFetch(path);
    res.json({ ok: true, queixas: data || [] });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.patch('/queixa/:id', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });
  try {
    await supaFetch(`farmabot_queixas?id=eq.${req.params.id}`, {
      method: 'PATCH',
      body: JSON.stringify(req.body)
    });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// ── Mapa de cobertura (gestor) ────────────────────────────────────────────────
app.get('/cobertura', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });
  try {
    const [pacientes, conversas, queixas, alertas] = await Promise.all([
      supaFetch('farmabot_pacientes?select=id,ubs_nome,medicamentos,condicoes'),
      supaFetch('farmabot_conversas?pendente=eq.true&select=id,unidade'),
      supaFetch('farmabot_queixas?status=eq.pendente&select=id,ubs_nome'),
      supaFetch('farmabot_alertas_renovacao?status=eq.pendente&select=id,ubs_nome'),
    ]);

    // Agrupa por UBS
    const mapa = {};
    const ubsList = await supaFetch('farmabot_ubs?select=nome_ubs&status=eq.ativo');
    (ubsList||[]).forEach(u => {
      mapa[u.nome_ubs] = { ubs: u.nome_ubs, pacientes: 0, beers: 0, renovacoes: 0, conversas: 0, queixas: 0 };
    });

    // Pacientes + Beers
    (Array.isArray(pacientes) ? pacientes : []).forEach(p => {
      if (!p.ubs_nome) return;
      if (!mapa[p.ubs_nome]) mapa[p.ubs_nome] = { ubs: p.ubs_nome, pacientes: 0, beers: 0, renovacoes: 0, conversas: 0, queixas: 0 };
      mapa[p.ubs_nome].pacientes++;
      const beers = (p.medicamentos||[]).filter(m => m.beers_alerta).length;
      mapa[p.ubs_nome].beers += beers;
    });

    // Conversas pendentes
    (Array.isArray(conversas) ? conversas : []).forEach(c => {
      if (c.unidade && mapa[c.unidade]) mapa[c.unidade].conversas++;
    });

    // Queixas pendentes
    (Array.isArray(queixas) ? queixas : []).forEach(q => {
      if (q.ubs_nome && mapa[q.ubs_nome]) mapa[q.ubs_nome].queixas++;
    });

    // Renovações pendentes
    (Array.isArray(alertas) ? alertas : []).forEach(a => {
      if (a.ubs_nome && mapa[a.ubs_nome]) mapa[a.ubs_nome].renovacoes++;
    });

    const resultado = Object.values(mapa).sort((a,b) => b.pacientes - a.pacientes);
    res.json({ ok: true, cobertura: resultado });
  } catch(e) { res.status(500).json({ erro: e.message }); }
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

// ── Endpoint: enviar dica de educação em saúde manualmente ───────────────────
app.post('/educacao/enviar', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });

  const { texto, categoria, ubs } = req.body;
  if (!texto) return res.status(400).json({ erro: 'texto é obrigatório' });

  try {
    // Busca pacientes elegíveis
    let path = `farmabot_pacientes?select=id,nome,telefone,condicoes`;
    if (ubs) path += `&ubs_nome=eq.${encodeURIComponent(ubs)}`;

    const pacientes = await supaFetch(path);
    if (!Array.isArray(pacientes)) return res.status(500).json({ erro: 'Erro ao buscar pacientes' });

    // Filtra por categoria se necessário
    const elegiveis = pacientes.filter(p => {
      if (!p.telefone) return false;
      if (categoria === 'HAS') return (p.condicoes||[]).some(c => c.toUpperCase().includes('HAS') || c.toUpperCase().includes('HIPERTENS'));
      if (categoria === 'DM') return (p.condicoes||[]).some(c => c.toUpperCase().includes('DM') || c.toUpperCase().includes('DIABET'));
      return true; // Medicamentos = todos
    });

    let enviados = 0;
    for (const p of elegiveis) {
      const primeiroNome = (p.nome || '').split(' ')[0];
      const msg = `🌟 Olá, *${primeiroNome}*! Aqui está a dica de saúde desta semana:\n\n${texto}\n\n_Sua Assistência Farmacêutica de Trindade-GO_ 💚`;
      await enviar(p.telefone, msg);
      enviados++;
    }

    console.log(`📚 Educação manual: ${enviados} mensagem(s) enviada(s) | categoria: ${categoria||'todas'}`);
    res.json({ ok: true, enviados });
  } catch(e) {
    console.error('Erro /educacao/enviar:', e.message);
    res.status(500).json({ erro: e.message });
  }
});


// GET /familia/:paciente_id — busca vínculos familiares
app.get('/familia/:paciente_id', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });
  try {
    const data = await supaFetch(`farmabot_familia?or=(paciente_id.eq.${req.params.paciente_id},familiar_id.eq.${req.params.paciente_id})&select=*`);
    res.json({ ok: true, vinculos: data || [] });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// POST /familia — cadastra vínculo familiar
app.post('/familia', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });
  const { paciente_id, familiar_id, relacao } = req.body;
  if (!paciente_id || !familiar_id) return res.status(400).json({ erro: 'paciente_id e familiar_id são obrigatórios' });
  try {
    const data = await supaFetch('farmabot_familia', {
      method: 'POST',
      headers: { "Prefer": "resolution=ignore-duplicates" },
      body: JSON.stringify({ paciente_id, familiar_id, relacao: relacao || 'familiar' })
    });
    res.json({ ok: true, data });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

// DELETE /familia/:id — remove vínculo
app.delete('/familia/:id', async (req, res) => {
  const token = req.headers['x-admin-token'];
  if (token !== ADMIN_TOKEN) return res.status(401).json({ erro: 'Não autorizado' });
  try {
    await supaFetch(`farmabot_familia?id=eq.${req.params.id}`, { method: 'DELETE' });
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ erro: e.message }); }
});

app.listen(PORT, () => {
  console.log(`✅ FarmaBot SUS v4.0.0 rodando na porta ${PORT}`);
  console.log(`📱 Número central: 62 9410-3358 (${META_PHONE_NUMBER_ID})`);
  console.log(`🔗 Webhook: /webhook`);
});
