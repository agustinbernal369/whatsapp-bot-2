const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage,
  downloadContentFromMessage
} = require("@whiskeysockets/baileys");
const pino = require("pino");
const qrcodeTerminal = require("qrcode-terminal");
const QRCode = require("qrcode");
const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");

process.on("uncaughtException", (err) => {
  console.error("[CRITICAL ERROR] Excepción no capturada:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[CRITICAL ERROR] Promesa rechazada no controlada:", reason);
});

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin2026";
const rulesPath = path.join(__dirname, "rules.json");
const productsPath = path.join(__dirname, "products.json");
const userStatePath = path.join(__dirname, "userState.json");
const followupsPath = path.join(__dirname, "followups.json");
const configPath = path.join(__dirname, "config.json");
const verifiedOpsPath = path.join(__dirname, "verifiedOperations.json");
const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
  try {
    fs.mkdirSync(uploadsDir, { recursive: true });
  } catch (e) {
    console.error("[BOT] Error creando carpeta uploads:", e);
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      let content = fs.readFileSync(filePath, "utf8");
      if (content.charCodeAt(0) === 0xFEFF) {
        content = content.slice(1);
      }
      return JSON.parse(content);
    }
  } catch (e) {
    console.error(`[BOT ERROR] Error leyendo ${path.basename(filePath)}:`, e.message);
  }
  return fallback;
}

// Configuración general del Bot (Gemini API Key, etc.)
let botConfig = {
  geminiApiKey: process.env.GEMINI_API_KEY || "",
  geminiModel: "gemini-flash-lite-latest",
  financePin: "1234"
};
function loadConfig() {
  botConfig = { ...botConfig, ...readJsonSafe(configPath, {}) };
  if (!botConfig.financePin) botConfig.financePin = "1234";
}
function saveConfig() {
  try {
    fs.writeFileSync(configPath, JSON.stringify(botConfig, null, 2), "utf8");
  } catch (e) {
    console.error("[BOT] Error guardando config.json:", e);
  }
}
loadConfig();

// Antifraude: Números de Operación ya verificados
let verifiedOperations = new Set();
function loadVerifiedOperations() {
  const arr = readJsonSafe(verifiedOpsPath, []);
  if (Array.isArray(arr)) verifiedOperations = new Set(arr);
}
function saveVerifiedOperations() {
  try {
    fs.writeFileSync(verifiedOpsPath, JSON.stringify(Array.from(verifiedOperations), null, 2), "utf8");
  } catch (e) {
    console.error("[BOT] Error guardando verifiedOperations.json:", e);
  }
}
loadVerifiedOperations();

// Registro de Ventas e Ingresos (Panel de Finanzas)
const salesPath = path.join(__dirname, "sales.json");
let sales = [];
function loadSales() {
  const loaded = readJsonSafe(salesPath, null);
  if (Array.isArray(loaded)) {
    sales = loaded;
  }
}
function saveSales() {
  try {
    fs.writeFileSync(salesPath, JSON.stringify(sales, null, 2), "utf8");
  } catch (e) {
    console.error("[BOT] Error guardando sales.json:", e);
  }
}
loadSales();

// 1. Gestión de Productos
let products = [
  { id: "grafismo", name: "Grafismo Fonético", icon: "📚" },
  { id: "budines", name: "Recetario de Budines", icon: "🧁" }
];
function loadProducts() {
  const loaded = readJsonSafe(productsPath, null);
  if (Array.isArray(loaded) && loaded.length > 0) {
    products = loaded;
  }
}
loadProducts();

// 2. Gestión de Reglas
let rules = [];
function loadRules() {
  const loaded = readJsonSafe(rulesPath, null);
  if (Array.isArray(loaded)) {
    rules = loaded;
    // Garantizar campos por defecto para compatibilidad
    rules.forEach((r) => {
      if (!r.productId) r.productId = "grafismo";
      if (r.enabled === undefined) r.enabled = true;
      if (!r.receiptCheck) {
        r.receiptCheck = {
          enabled: false,
          expectedAmount: 0,
          expectedHolder: "",
          expectedAlias: "",
          expectedCuil: "",
          maxAgeHours: 6,
          rejectMessage: ""
        };
      } else {
        if (r.receiptCheck.enabled === undefined) r.receiptCheck.enabled = false;
        if (r.receiptCheck.expectedAmount === undefined) r.receiptCheck.expectedAmount = 0;
        if (r.receiptCheck.expectedHolder === undefined) r.receiptCheck.expectedHolder = "";
        if (r.receiptCheck.expectedAlias === undefined) r.receiptCheck.expectedAlias = "";
        if (r.receiptCheck.expectedCuil === undefined) r.receiptCheck.expectedCuil = "";
        if (r.receiptCheck.maxAgeHours === undefined) r.receiptCheck.maxAgeHours = 6;
        if (r.receiptCheck.rejectMessage === undefined) r.receiptCheck.rejectMessage = "";
      }
      if (r.onlyOnce === undefined) r.onlyOnce = false;
      if (r.requiredRuleId === undefined) r.requiredRuleId = null;
      if (r.nextRuleId === undefined) r.nextRuleId = null;
      if (r.nextRuleDelaySeconds === undefined) r.nextRuleDelaySeconds = 2;
      if (!r.followUps && r.followUp) {
        r.followUps = [ r.followUp ];
      }
      if (!Array.isArray(r.followUps) || r.followUps.length === 0) {
        r.followUps = [{
          stepIndex: 0,
          enabled: false,
          delayHours: 3,
          delayMinutes: 0,
          cancelRuleIds: [],
          responses: []
        }];
      }
      r.followUps.forEach((fu, idx) => {
        fu.stepIndex = idx;
        if (fu.delayHours === undefined) fu.delayHours = idx === 0 ? 3 : 24;
        if (fu.delayMinutes === undefined) fu.delayMinutes = 0;
        if (!Array.isArray(fu.cancelRuleIds)) fu.cancelRuleIds = [];
        if (!Array.isArray(fu.responses)) fu.responses = [];
      });
      r.followUp = r.followUps[0];
    });
    console.log(`[BOT] ${rules.length} reglas cargadas con éxito.`);
  }
}
loadRules();

// 3. Memoria por Cliente (Contexto de Producto)
let userState = {};
function loadUserState() {
  userState = readJsonSafe(userStatePath, {});
}
function saveUserState() {
  try {
    fs.writeFileSync(userStatePath, JSON.stringify(userState, null, 2), "utf8");
  } catch (e) {
    console.error("[BOT] Error guardando userState:", e);
  }
}
loadUserState();

// 4. Seguimientos Automáticos Programados (Remarketing)
let followUps = {};
function loadFollowUps() {
  followUps = readJsonSafe(followupsPath, {});
}
function saveFollowUps() {
  try {
    fs.writeFileSync(followupsPath, JSON.stringify(followUps, null, 2), "utf8");
  } catch (e) {
    console.error("[BOT] Error guardando followUps:", e);
  }
}
loadFollowUps();

const processedMessages = new Set();
let currentQR = null;
let isConnected = false;
let currentSocket = null;

// Búfer en memoria de logs recientes (últimos 100) para diagnóstico en tiempo real
const recentLogs = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function pushLog(type, args) {
  try {
    const text = args.map(a => (typeof a === "object" ? JSON.stringify(a) : String(a))).join(" ");
    const time = new Date().toLocaleTimeString("es-AR", { hour12: false });
    recentLogs.push(`[${time}] [${type}] ${text}`);
    if (recentLogs.length > 100) recentLogs.shift();
  } catch (e) {}
}

console.log = function (...args) {
  pushLog("INFO", args);
  originalLog.apply(console, args);
};
console.warn = function (...args) {
  pushLog("WARN", args);
  originalWarn.apply(console, args);
};
console.error = function (...args) {
  pushLog("ERROR", args);
  originalError.apply(console, args);
};

// Mapeos de identidad WhatsApp: LID <-> Teléfono (@s.whatsapp.net) y almacén de reintentos
const recentIncoming = [];
const lidToPnMap = new Map();
const pnToLidMap = new Map();
const messageStore = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Helper seguro para presencia (WhatsApp a menudo rechaza presence en LIDs o conexiones móviles)
async function safePresence(sock, presence, jid) {
  try {
    if (sock && typeof sock.sendPresenceUpdate === "function" && jid) {
      await sock.sendPresenceUpdate(presence, jid);
    }
  } catch (e) {
    // Presencia cosmética ignorada en caso de fallo para no interrumpir el envío
  }
}

// Resolver el mejor JID para enviar mensaje (priorizando @s.whatsapp.net si está disponible)
async function getBestSendJids(sock, jid) {
  if (!jid) return { primary: jid, fallback: null };
  if (jid.endsWith("@s.whatsapp.net")) {
    const lid = pnToLidMap.get(jid) || null;
    return { primary: jid, fallback: lid };
  }
  if (jid.endsWith("@lid")) {
    let pn = lidToPnMap.get(jid) || null;
    if (!pn && sock?.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const resolved = await sock.signalRepository.lidMapping.getPNForLID(jid);
        if (resolved) {
          pn = resolved.includes("@") ? resolved : `${resolved}@s.whatsapp.net`;
          lidToPnMap.set(jid, pn);
          pnToLidMap.set(pn, jid);
        }
      } catch (e) {}
    }
    if (pn) {
      return { primary: pn, fallback: jid };
    }
    return { primary: jid, fallback: null };
  }
  return { primary: jid, fallback: null };
}

// Envío a prueba de fallos con reintento automático en JID alternativo
async function safeSendMessage(sock, jid, content) {
  if (!sock || typeof sock.sendMessage !== "function") {
    throw new Error("Socket de WhatsApp no disponible para enviar mensaje");
  }
  const { primary, fallback } = await getBestSendJids(sock, jid);
  try {
    return await sock.sendMessage(primary, content);
  } catch (err1) {
    console.warn(`[BOT ENVÍO WARN] Falló envío a ${primary} (${err1.message})`);
    if (fallback && fallback !== primary) {
      console.log(`[BOT ENVÍO] Reintentando envío a JID alternativo: ${fallback}...`);
      return await sock.sendMessage(fallback, content);
    }
    throw err1;
  }
}

function getFfmpegPath() {
  try {
    const { execSync } = require("child_process");
    execSync("ffmpeg -version", { stdio: "ignore" });
    return "ffmpeg";
  } catch (e) {}
  try {
    const ffmpegInstaller = require("@ffmpeg-installer/ffmpeg");
    if (ffmpegInstaller && ffmpegInstaller.path && fs.existsSync(ffmpegInstaller.path)) {
      return ffmpegInstaller.path;
    }
  } catch (e) {}
  return "ffmpeg";
}

// Conversor universal de audios a Opus OGG nativo de WhatsApp (para notas de voz perfectas)
function convertToOpusOgg(inputPath) {
  try {
    if (!fs.existsSync(inputPath)) return inputPath;
    const ext = path.extname(inputPath).toLowerCase();
    if (ext === ".ogg" || ext === ".opus") return inputPath;

    const outputPath = inputPath.replace(/\.[^.]+$/, ".ogg");
    const { execFileSync } = require("child_process");
    const ffmpegBin = getFfmpegPath();
    execFileSync(ffmpegBin, ["-y", "-i", inputPath, "-c:a", "libopus", "-b:a", "32k", "-vbr", "on", outputPath], {
      stdio: "ignore",
      timeout: 20000
    });
    if (fs.existsSync(outputPath)) {
      console.log(`[BOT AUDIO] Audio convertido con éxito a Opus OGG: ${outputPath}`);
      return outputPath;
    }
  } catch (err) {
    console.warn(`[BOT AUDIO] Conversión con ffmpeg falló (${err.message}). Usando archivo original.`);
  }
  return inputPath;
}


function normalizeText(str) {
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();
}

function cleanForMatch(str) {
  if (!str) return "";
  return str
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // eliminar acentos y tildes
    .replace(/[^\w\s]/gi, " ")       // reemplazar signos de puntuación, emojis y símbolos por espacio
    .replace(/\s+/g, " ")            // convertir múltiples espacios o saltos de línea a un solo espacio
    .trim();
}

function extractMessage(msg) {
  let m = msg.message;
  if (!m) return { text: "", hasImage: false, hasAudio: false, audioMime: "" };
  if (m.ephemeralMessage) m = m.ephemeralMessage.message || m;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message || m;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message || m;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message || m;

  let text =
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.listResponseMessage?.singleSelectReply?.selectedRowId ||
    m.interactiveResponseMessage?.body?.text ||
    "";

  if (!text && m.interactiveMessage?.body?.text) {
    text = m.interactiveMessage.body.text;
  }

  const hasImage = Boolean(m.imageMessage) || 
                   (Boolean(m.documentMessage) && Boolean(m.documentMessage.mimetype?.startsWith("image/"))) ||
                   (Boolean(m.documentMessage) && m.documentMessage.mimetype === "application/pdf");
  const hasAudio = Boolean(m.audioMessage);
  const audioMime = m.audioMessage?.mimetype || "audio/ogg";
  const mediaMime = m.imageMessage?.mimetype || m.documentMessage?.mimetype || (m.audioMessage?.mimetype || "image/jpeg");
  return { text, hasImage, hasAudio, audioMime, mediaMime, unwrap: m };
}

// Descarga segura del buffer multimedia en memoria (sin escribir a disco)
async function getMediaBuffer(msg, sock) {
  try {
    if (typeof downloadMediaMessage === "function") {
      const buf = await downloadMediaMessage(
        msg,
        "buffer",
        {},
        {
          logger: pino({ level: "silent" }),
          reuploadRequest: sock?.updateMediaMessage
        }
      );
      if (buf && buf.length > 0) return buf;
    }
  } catch (err1) {
    console.warn("[BOT MEDIA] downloadMediaMessage falló, probando streaming con downloadContentFromMessage:", err1.message);
  }

  try {
    let m = msg.message;
    if (m?.ephemeralMessage) m = m.ephemeralMessage.message || m;
    if (m?.viewOnceMessage) m = m.viewOnceMessage.message || m;
    if (m?.viewOnceMessageV2) m = m.viewOnceMessageV2.message || m;
    if (m?.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message || m;

    const mediaObj = m?.imageMessage || m?.documentMessage || m?.audioMessage;
    const mediaType = m?.imageMessage ? "image" : (m?.audioMessage ? "audio" : "document");
    if (mediaObj && typeof downloadContentFromMessage === "function") {
      const stream = await downloadContentFromMessage(mediaObj, mediaType);
      let buffer = Buffer.from([]);
      for await (const chunk of stream) {
        buffer = Buffer.concat([buffer, chunk]);
      }
      if (buffer.length > 0) return buffer;
    }
  } catch (err2) {
    console.error("[BOT MEDIA] Error extrayendo buffer con downloadContentFromMessage:", err2.message);
  }
  return null;
}

// Helper: Parser y gestor de múltiples Gemini API Keys gratuitas (rotación automática)
const keyRateLimitedUntil = new Map();

function getGeminiApiKeys() {
  const combined = `${botConfig.geminiApiKey || ""} ${process.env.GEMINI_API_KEY || ""}`;
  const keys = combined
    .split(/[\n,;\s]+/)
    .map(k => k.trim())
    .filter(k => k.length > 5);
  return [...new Set(keys)];
}

function markKeyRateLimited(key, durationMs = 1000 * 60 * 30) {
  const masked = key.length > 10 ? `...${key.slice(-6)}` : "clave";
  console.warn(`[BOT GEMINI ROTACIÓN] ⚠️ Clave (${masked}) agotó cuota (429/403). Pausada temporalmente por 30m. Rotando automáticamente a la siguiente clave libre...`);
  keyRateLimitedUntil.set(key, Date.now() + durationMs);
}

// Detección y caché automática del modelo Gemini disponible
let cachedGeminiModel = null;
function getAvailableGeminiModel(apiKey) {
  if (cachedGeminiModel) return Promise.resolve(cachedGeminiModel);
  return new Promise((resolve) => {
    if (!apiKey) return resolve("gemini-3-flash-preview");
    const options = {
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: `/v1beta/models?key=${apiKey}`,
      method: "GET",
      timeout: 8000
    };
    const req = https.request(options, (res) => {
      let rawData = "";
      res.on("data", (c) => (rawData += c));
      res.on("end", () => {
        try {
          if (res.statusCode === 200) {
            const parsed = JSON.parse(rawData);
            if (Array.isArray(parsed.models)) {
              const usable = parsed.models.filter(
                (m) =>
                  Array.isArray(m.supportedGenerationMethods) &&
                  m.supportedGenerationMethods.includes("generateContent")
              );
              const bestFlash =
                usable.find((m) => m.name.endsWith("/gemini-3.5-flash-lite") || m.name === "gemini-3.5-flash-lite") ||
                usable.find((m) => m.name.endsWith("/gemini-flash-lite-latest") || m.name === "gemini-flash-lite-latest") ||
                usable.find((m) => m.name.endsWith("/gemini-3.5-flash") || m.name === "gemini-3.5-flash") ||
                usable.find((m) => m.name.endsWith("/gemini-3-flash-preview") || m.name === "gemini-3-flash-preview") ||
                usable.find((m) => m.name.endsWith("/gemini-flash-latest") || m.name === "gemini-flash-latest") ||
                usable.find((m) => m.name.endsWith("/gemini-3.8-flash") || m.name === "gemini-3.8-flash") ||
                usable.find((m) => m.name.includes("flash")) ||
                usable[0];
              if (bestFlash) {
                const cleanName = bestFlash.name.replace(/^models\//, "");
                cachedGeminiModel = cleanName;
                console.log(`[BOT GEMINI] Modelo compatible detectado automáticamente: ${cleanName}`);
                return resolve(cleanName);
              }
            }
          }
        } catch (e) {}
        cachedGeminiModel = "gemini-3.5-flash-lite";
        resolve("gemini-3.5-flash-lite");
      });
    });
    req.on("error", () => {
      cachedGeminiModel = "gemini-3.5-flash-lite";
      resolve("gemini-3.5-flash-lite");
    });
    req.on("timeout", () => {
      req.destroy();
      cachedGeminiModel = "gemini-3.5-flash-lite";
      resolve("gemini-3.5-flash-lite");
    });
    req.end();
  });
}

// Llamada individual a Google Gemini Vision con timeout de 35s y extracción tolerante
function queryGeminiVisionSingle(apiKey, imageBuffer, mimeType, modelName) {
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error("API Key de Gemini no configurada"));
    if (!imageBuffer || imageBuffer.length === 0) return reject(new Error("Buffer de imagen vacío"));

    const postData = JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: `Sos un asistente contable experto en verificar comprobantes de transferencias bancarias y billeteras virtuales de Argentina (Mercado Pago, Cuenta DNI, Ualá, Banco Nación / BNA+, Santander, Galicia, BBVA, Macro, Brubank, Modo, etc.).
Analizá minuciosamente esta imagen o comprobante y devolvé ÚNICAMENTE un JSON válido (sin formato markdown ni texto adicional) con la siguiente estructura exacta:
{
  "esComprobante": true,
  "monto": 4800,
  "destinatario": "Nombre y apellido del receptor o titular de destino que recibe el dinero tal como figura",
  "alias_cbu": "Alias o CBU/CVU de destino si se ve",
  "cuit_cuil": "CUIT o CUIL de 11 dígitos de la cuenta de destino o receptor (NUNCA del remitente u origen)",
  "fecha": "YYYY-MM-DD",
  "hora": "HH:mm",
  "numeroOperacion": "Código de operación, ID de transferencia o número de comprobante único"
}

Reglas estrictas:
1. Si la imagen NO es un comprobante de pago o transferencia (ej: una selfie, meme, captura de chat sin datos bancarios o comprobante ilegible), devolvé {"esComprobante": false}.
2. "monto": debe ser un número (ej: 4800 o 2500.50). Si dice "$ 4.800,00" o "4.800", extraelo como número 4800.
3. "destinatario": extraé con exactitud el nombre del titular o cuenta que RECIBE el dinero. Si sólo figuran iniciales (ej: 'M B' en Banco Nación / BNA+) o está abreviado, extraelo tal cual figura.
4. "cuit_cuil": buscá el CUIT o CUIL del RECEPTOR de destino (11 dígitos, ej: "27-25904495-8" o "27259044958"). Si no figura el del receptor, poné null.
5. "fecha": convertila al formato YYYY-MM-DD (ej: "08 de octubre 2026" -> "2026-10-08"). Si no tiene año, asumí el año en curso.
6. "hora": formato de 24 horas "HH:mm" (ej: "15:03"). Si el comprobante NO indica la hora, poné null.
7. "numeroOperacion": extraé el ID, número de transacción o comprobante. Si no figura, poné null.
8. "alias_cbu": extraé el Alias o CBU/CVU de la cuenta de destino si figura en el comprobante (ej: 'Ruta.Crecimiento'). Si no figura, poné null.`
            },
            {
              inline_data: {
                mime_type: mimeType,
                data: imageBuffer.toString("base64")
              }
            }
          ]
        }
      ],
      generationConfig: {
        temperature: 0.1,
        response_mime_type: "application/json"
      }
    });

    const options = {
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: `/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },
      timeout: 20000
    };

    const req = https.request(options, (res) => {
      let rawData = "";
      res.on("data", (chunk) => { rawData += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`Google API HTTP ${res.statusCode}: ${rawData.substring(0, 150)}`));
          }
          const parsed = JSON.parse(rawData);
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          let candidateText = "";
          for (const p of parts) {
            if (p.text && !p.thought) {
              candidateText += p.text;
            }
          }
          if (!candidateText && parts[0]?.text) {
            candidateText = parts[0].text;
          }
          if (!candidateText) {
            return reject(new Error("Respuesta vacía de Gemini"));
          }
          let cleanJson = candidateText.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
          const firstBrace = cleanJson.indexOf("{");
          const lastBrace = cleanJson.lastIndexOf("}");
          if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
            cleanJson = cleanJson.substring(firstBrace, lastBrace + 1);
          }
          const result = JSON.parse(cleanJson);
          resolve(result);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error(`Timeout esperando respuesta de Google Gemini (${modelName}) (20s)`));
    });

    req.write(postData);
    req.end();
  });
}

// Wrapper con Soporte de Múltiples Claves (Rotación Automática Silenciosa) y Fallback de Modelos 2026 (100% Gratuito)
async function queryGeminiVision(param1, param2, param3) {
  let imageBuffer = param1 instanceof Buffer ? param1 : (param2 instanceof Buffer ? param2 : null);
  let mimeType = typeof param2 === "string" ? param2 : (typeof param3 === "string" ? param3 : "image/jpeg");

  if (!imageBuffer) {
    throw new Error("Buffer de imagen no válido para verificación");
  }

  const allKeys = getGeminiApiKeys();
  if (allKeys.length === 0) {
    throw new Error("No hay ninguna API Key de Gemini configurada.");
  }

  // Modelos activos en 2026 ordenados por velocidad y disponibilidad
  const candidateModels = [
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
    botConfig.geminiModel,
    "gemini-3-flash-preview",
    "gemini-flash-latest",
    "gemini-3.8-flash"
  ].filter(Boolean);
  const uniqueModels = [...new Set(candidateModels)];

  let lastError = null;
  const now = Date.now();

  // Ordenar claves: poner primero las que NO están pausadas por cuota agotada
  const sortedKeys = [...allKeys].sort((a, b) => {
    const aLimited = (keyRateLimitedUntil.get(a) || 0) > now ? 1 : 0;
    const bLimited = (keyRateLimitedUntil.get(b) || 0) > now ? 1 : 0;
    return aLimited - bLimited;
  });

  for (let kIdx = 0; kIdx < sortedKeys.length; kIdx++) {
    const key = sortedKeys[kIdx];
    const masked = key.length > 10 ? `...${key.slice(-6)}` : `Clave #${kIdx + 1}`;

    for (let mIdx = 0; mIdx < uniqueModels.length; mIdx++) {
      const model = uniqueModels[mIdx];
      try {
        console.log(`[BOT RECEIPT] Verificando comprobante con Clave #${kIdx + 1}/${sortedKeys.length} (${masked}) en modelo "${model}"...`);
        const result = await queryGeminiVisionSingle(key, imageBuffer, mimeType, model);
        if (result && typeof result === "object") {
          console.log(`[BOT RECEIPT] ¡Lectura exitosa con Clave #${kIdx + 1} (${masked}) en modelo "${model}"!`);
          return result;
        }
      } catch (err) {
        lastError = err;
        const msg = String(err.message || "");
        console.warn(`[BOT RECEIPT AVISO] Falló Clave #${kIdx + 1} (${masked}) con "${model}" (${msg}).`);

        if (msg.includes("403") || msg.includes("API_KEY_INVALID")) {
          markKeyRateLimited(key, 1000 * 60 * 60);
          break;
        }
        if (mIdx === uniqueModels.length - 1 && (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota"))) {
          markKeyRateLimited(key);
        }
        await sleep(300);
      }
    }
  }

  throw lastError || new Error("No se pudo verificar el comprobante con ninguna de las claves/modelos configurados");
}

// Consulta a Google Gemini para Asistente de IA (Texto + Audio de WhatsApp)
// Llamada individual a Google Gemini Chat
function queryGeminiChatSingle(apiKey, systemInstruction, userText, audioBuffer, audioMime, history, modelName) {
  return new Promise((resolve, reject) => {
    if (!apiKey) return reject(new Error("API Key de Gemini no configurada"));

    const contents = [];

    // Agregar hasta los últimos 6 mensajes del historial para contexto conversacional
    if (Array.isArray(history)) {
      const recentHistory = history.slice(-6);
      for (const item of recentHistory) {
        if (item.role && item.text) {
          contents.push({
            role: item.role === "assistant" ? "model" : "user",
            parts: [{ text: item.text }]
          });
        }
      }
    }

    // Mensaje actual del usuario
    const userParts = [];
    if (userText && userText.trim().length > 0) {
      userParts.push({ text: userText.trim() });
    }
    if (audioBuffer && audioBuffer.length > 0) {
      let cleanMime = "audio/ogg";
      if (audioMime && audioMime.includes("mp4")) cleanMime = "audio/mp4";
      userParts.push({
        inline_data: {
          mime_type: cleanMime,
          data: audioBuffer.toString("base64")
        }
      });
      if (userParts.length === 1) {
        userParts.unshift({ text: "El usuario te envió una nota de voz de WhatsApp. Escuchala atentamente y respondé a lo que dice o consulta:" });
      }
    }

    if (userParts.length === 0) {
      return reject(new Error("No hay contenido de texto ni audio para procesar"));
    }

    contents.push({
      role: "user",
      parts: userParts
    });

    const promptText = (systemInstruction && systemInstruction.trim().length > 0)
      ? systemInstruction.trim()
      : "Sos un asistente de atención y ventas en WhatsApp. Respondé amablemente, de forma directa, humana y concisa.";

    const payload = {
      system_instruction: {
        parts: [
          {
            text: `${promptText}\n\nREGLAS DE FORMATO Y ESTILO:\n1. Respondé directo al grano de forma clara y amable (máximo 2 párrafos cortos).\n2. Usá un tono natural de WhatsApp (usá emojis con moderación si es adecuado).\n3. Si el usuario te envía un audio, respondé directamente a lo que preguntó en el audio como si lo hubieras escuchado con atención.`
          }
        ]
      },
      contents,
      generationConfig: {
        temperature: 0.7,
        maxOutputTokens: 2048
      }
    };

    const postData = JSON.stringify(payload);

    const options = {
      hostname: "generativelanguage.googleapis.com",
      port: 443,
      path: `/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData)
      },
      timeout: 25000
    };

    const req = https.request(options, (res) => {
      let rawData = "";
      res.on("data", (chunk) => { rawData += chunk; });
      res.on("end", () => {
        try {
          if (res.statusCode !== 200) {
            return reject(new Error(`Google API HTTP ${res.statusCode}: ${rawData.substring(0, 150)}`));
          }
          const parsed = JSON.parse(rawData);
          const parts = parsed.candidates?.[0]?.content?.parts || [];
          let candidateText = "";
          for (const p of parts) {
            if (p.text && !p.thought) {
              candidateText += p.text;
            }
          }
          if (!candidateText && parts[0]?.text) {
            candidateText = parts[0].text;
          }
          if (!candidateText) {
            return reject(new Error("Respuesta vacía de Gemini"));
          }
          resolve(candidateText.trim());
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", (e) => reject(e));
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Timeout esperando respuesta de Google Gemini (25s)"));
    });

    req.write(postData);
    req.end();
  });
}

// Wrapper con Soporte de Múltiples Claves (Rotación Automática Silenciosa) y Fallback Multimodelo 2026 para el Asistente de IA (100% Gratuito)
async function queryGeminiChat(param1, param2, param3, param4, param5, param6) {
  let systemInstruction, userText, audioBuffer, audioMime, history;
  if (typeof param1 === "string" && (param1.startsWith("AIzaSy") || param1.startsWith("AQ.") || param1.length > 30) && typeof param2 === "string") {
    systemInstruction = param2;
    userText = param3;
    audioBuffer = param4;
    audioMime = param5 || "audio/ogg";
    history = param6 || [];
  } else {
    systemInstruction = param1;
    userText = param2;
    audioBuffer = param3;
    audioMime = param4 || "audio/ogg";
    history = param5 || [];
  }

  const allKeys = getGeminiApiKeys();
  if (allKeys.length === 0) {
    throw new Error("No hay ninguna API Key de Gemini configurada.");
  }

  const candidateModels = [
    "gemini-3.5-flash-lite",
    "gemini-flash-lite-latest",
    "gemini-3.5-flash",
    botConfig.geminiModel,
    "gemini-3-flash-preview",
    "gemini-flash-latest",
    "gemini-3.8-flash"
  ].filter(Boolean);
  const uniqueModels = [...new Set(candidateModels)];

  let lastError = null;
  const now = Date.now();

  const sortedKeys = [...allKeys].sort((a, b) => {
    const aLimited = (keyRateLimitedUntil.get(a) || 0) > now ? 1 : 0;
    const bLimited = (keyRateLimitedUntil.get(b) || 0) > now ? 1 : 0;
    return aLimited - bLimited;
  });

  for (let kIdx = 0; kIdx < sortedKeys.length; kIdx++) {
    const key = sortedKeys[kIdx];
    const masked = key.length > 10 ? `...${key.slice(-6)}` : `Clave #${kIdx + 1}`;

    for (let mIdx = 0; mIdx < uniqueModels.length; mIdx++) {
      const model = uniqueModels[mIdx];
      try {
        console.log(`[BOT AI] Consultando asistente con Clave #${kIdx + 1}/${sortedKeys.length} (${masked}) en modelo "${model}"...`);
        const result = await queryGeminiChatSingle(key, systemInstruction, userText, audioBuffer, audioMime, history, model);
        if (result && result.trim()) {
          return result.trim();
        }
      } catch (err) {
        lastError = err;
        const msg = String(err.message || "");
        console.warn(`[BOT AI AVISO] Falló Clave #${kIdx + 1} (${masked}) con "${model}" (${msg}).`);

        if (msg.includes("403") || msg.includes("API_KEY_INVALID")) {
          markKeyRateLimited(key, 1000 * 60 * 60);
          break;
        }
        if (mIdx === uniqueModels.length - 1 && (msg.includes("429") || msg.includes("RESOURCE_EXHAUSTED") || msg.includes("quota"))) {
          markKeyRateLimited(key);
        }
        await sleep(300);
      }
    }
  }

  throw lastError || new Error("No se pudo obtener respuesta del asistente con ninguna de las claves/modelos disponibles");
}

// Función auxiliar para parsear importes en pesos argentinos (ej: 4800, 4.800, 4.800,00)
function parseReceiptAmount(val) {
  if (typeof val === "number") return val;
  if (!val) return 0;
  let str = String(val).replace(/[^0-9.,]/g, "").trim();
  if (str.includes(".") && str.includes(",")) {
    str = str.replace(/\./g, "").replace(",", ".");
  } else if (str.includes(".") && !str.includes(",")) {
    const parts = str.split(".");
    if (parts.length === 2 && parts[1].length === 3) {
      str = parts[0] + parts[1];
    } else if (parts.length > 2) {
      str = parts.join("");
    }
  } else if (str.includes(",")) {
    str = str.replace(",", ".");
  }
  return parseFloat(str) || 0;
}

// Validación contable y filtros de seguridad antifraude
function validateReceiptData(geminiResult, rcConfig) {
  const defaultReject = rcConfig.rejectMessage || "X";

  if (!geminiResult || !geminiResult.esComprobante) {
    return {
      valid: false,
      reason: "not_receipt",
      userMessage: defaultReject
    };
  }

  // 1. Chequeo de Monto
  const expectedAmount = Number(rcConfig.expectedAmount) || 0;
  if (expectedAmount > 0) {
    const extractedAmount = parseReceiptAmount(geminiResult.monto);
    // Margen de tolerancia de $1 por centavos o redondeos
    if (extractedAmount < (expectedAmount - 1)) {
      return {
        valid: false,
        reason: "insufficient_amount",
        userMessage: defaultReject
      };
    }
  }

  // Extraer texto unificado del titular/destinatario desde cualquier clave posible devuelta por la IA
  const rawHolder = [
    geminiResult.destinatario,
    geminiResult.destinario,
    geminiResult.titular,
    geminiResult.receptor,
    geminiResult.nombre,
    geminiResult.alias_cbu,
    geminiResult.cuenta_destino
  ].filter(Boolean).join(" ");
  const actualHolder = normalizeText(rawHolder);

  // 2. Chequeo de Identidad del Destinatario (Titular, CUIT/CUIL y Alias/CBU)
  // A) Nombre / Titular esperado
  let matchesHolder = false;
  let matchesInitials = false;
  if (rcConfig.expectedHolder && rcConfig.expectedHolder.trim()) {
    const expected = normalizeText(rcConfig.expectedHolder);
    const expectedWords = expected.split(" ").filter(w => w.length > 2);
    const matchesAllWords = expectedWords.length > 0 && expectedWords.every(w => actualHolder.includes(w));
    const matchesSomeWords = expectedWords.length > 0 && expectedWords.some(w => actualHolder.includes(w));
    matchesHolder = matchesAllWords || actualHolder.includes(expected) || matchesSomeWords;

    // Chequeo de iniciales para bancos que enmascaran el nombre (ej: BNA+ muestra "M B" para "MARISSA BALDERRAMA")
    const wordsForInitials = expected.split(" ").filter(w => w.length > 1);
    if (wordsForInitials.length >= 2) {
      const expectedInitials = wordsForInitials.map(w => w[0]).join(""); // ej: "mb"
      const holderLettersOnly = actualHolder.replace(/[^a-z]/g, "");
      if (holderLettersOnly.startsWith(expectedInitials) || holderLettersOnly === expectedInitials) {
        matchesInitials = true;
      }
    }
  } else {
    matchesHolder = true;
  }

  // B) Chequeo de CUIT / CUIL (Si está configurado)
  let matchesCuil = false;
  let cleanExpectedCuil = "";
  if (rcConfig.expectedCuil && rcConfig.expectedCuil.trim()) {
    cleanExpectedCuil = rcConfig.expectedCuil.replace(/\D/g, "");
    if (cleanExpectedCuil.length >= 10) {
      let extractedCuil = (geminiResult.cuit_cuil ? String(geminiResult.cuit_cuil) : "").replace(/\D/g, "");
      // Fallback: Si no vino directo en cuit_cuil, buscar si los dígitos aparecen en algún otro campo o JSON
      if (!extractedCuil || extractedCuil.length < 10) {
        const allDigits = `${rawHolder} ${geminiResult.numeroOperacion || ""} ${JSON.stringify(geminiResult)}`.replace(/\D/g, "");
        if (allDigits.includes(cleanExpectedCuil)) {
          extractedCuil = cleanExpectedCuil;
        }
      }

      if (extractedCuil && extractedCuil.length >= 10) {
        if (extractedCuil === cleanExpectedCuil || extractedCuil.includes(cleanExpectedCuil) || cleanExpectedCuil.includes(extractedCuil)) {
          matchesCuil = true;
        }
      }
    }
  }

  // C) Chequeo de Alias / CBU / CVU (Si está configurado)
  let matchesAlias = false;
  if (rcConfig.expectedAlias && rcConfig.expectedAlias.trim()) {
    const rawAliases = rcConfig.expectedAlias.split(/[,;\s]+/).map(a => normalizeText(a)).filter(a => a.length >= 3);
    const rawAliasText = normalizeText(`${geminiResult.alias_cbu || ""} ${geminiResult.cuenta_destino || ""} ${rawHolder}`);
    const rawDigits = rawAliasText.replace(/\D/g, "");

    for (const expA of rawAliases) {
      if (rawAliasText.includes(expA)) {
        matchesAlias = true;
        break;
      }
      const expDigits = expA.replace(/\D/g, "");
      if (expDigits.length >= 10 && rawDigits.includes(expDigits)) {
        matchesAlias = true;
        break;
      }
    }
  }

  // D) Evaluación unificada del Destinatario:
  // Es válido si coincide el nombre O el CUIT O el Alias O las iniciales acompañadas de CUIT/Alias
  const hasIdentityConfig = Boolean((rcConfig.expectedHolder && rcConfig.expectedHolder.trim()) || (cleanExpectedCuil.length >= 10) || (rcConfig.expectedAlias && rcConfig.expectedAlias.trim()));
  const recipientAuthorized = !hasIdentityConfig || matchesHolder || matchesCuil || matchesAlias || (matchesInitials && (cleanExpectedCuil.length < 10 || matchesCuil));

  if (!recipientAuthorized) {
    console.log(`[BOT RECEIPT REJECT] Destinatario no autorizado. Holder: "${actualHolder}", CUIT extraído: "${geminiResult.cuit_cuil}", Alias: "${geminiResult.alias_cbu}". Esperado: Holder="${rcConfig.expectedHolder}", CUIT="${cleanExpectedCuil}", Alias="${rcConfig.expectedAlias}"`);
    return {
      valid: false,
      reason: "wrong_holder",
      userMessage: defaultReject
    };
  }

  if (!matchesHolder && (matchesCuil || matchesAlias || matchesInitials)) {
    console.log(`[BOT RECEIPT APROBADO] Comprobante validado por identificador unívoco (CUIT: ${matchesCuil}, Alias: ${matchesAlias}, Iniciales: ${matchesInitials}). Banco con datos enmascarados reconocido con éxito.`);
  }

  // 4. Chequeo Antifraude: Número de Operación Duplicado
  const opId = geminiResult.numeroOperacion ? String(geminiResult.numeroOperacion).trim() : null;
  if (opId && opId.length >= 4) {
    if (verifiedOperations.has(opId)) {
      return {
        valid: false,
        reason: "duplicate_receipt",
        userMessage: defaultReject
      };
    }
  }

  // 5. Chequeo Antifraude: Antigüedad máxima (mínimo 48hs para evitar rechazos injustos de transferencias previas)
  const maxHours = Math.max(Number(rcConfig.maxAgeHours) || 48, 48);
  const now = new Date();

  if (geminiResult.fecha) {
    try {
      const parts = String(geminiResult.fecha).split(/[-/]/).map(Number);
      if (parts.length === 3 && parts[0] > 0 && parts[1] > 0 && parts[2] > 0) {
        const year = parts[0] > 1000 ? parts[0] : parts[2];
        const month = parts[0] > 1000 ? parts[1] : parts[1];
        const day = parts[0] > 1000 ? parts[2] : parts[0];

        let receiptDate = null;
        if (geminiResult.hora && String(geminiResult.hora).includes(":")) {
          const [hours, minutes] = String(geminiResult.hora).split(":").map(Number);
          const pad = (n) => String(n).padStart(2, "0");
          receiptDate = new Date(`${year}-${pad(month)}-${pad(day)}T${pad(hours)}:${pad(minutes)}:00-03:00`);
        } else {
          receiptDate = new Date(year, month - 1, day, 12, 0, 0);
        }

        if (receiptDate && !isNaN(receiptDate.getTime())) {
          const diffMs = now.getTime() - receiptDate.getTime();
          const diffHours = diffMs / (1000 * 60 * 60);
          if (diffHours > maxHours) {
            return {
              valid: false,
              reason: "expired",
              userMessage: defaultReject
            };
          }
        }
      }
    } catch (errDate) {
      console.warn("[BOT] Error parseando fecha:", errDate.message);
    }
  }

  return { valid: true, opId, details: geminiResult };
}

function serveStaticFile(res, filePath) {
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    return res.end("Archivo no encontrado");
  }
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".mp4": "video/mp4",
    ".pdf": "application/pdf",
    ".ogg": "audio/ogg",
    ".opus": "audio/ogg",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".json": "application/json",
    ".txt": "text/plain",
    ".html": "text/html; charset=utf-8",
    ".css": "text/css",
    ".js": "application/javascript"
  };
  const contentType = mimeMap[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(filePath).pipe(res);
}

// Motor central de envío de respuestas de una regla (o lista de respuestas)
async function executeRuleResponses(sock, remoteJid, ruleOrResponses, ruleName = "") {
  const responses = Array.isArray(ruleOrResponses) ? ruleOrResponses : (ruleOrResponses?.responses || []);
  const name = ruleName || (Array.isArray(ruleOrResponses) ? "Respuesta" : (ruleOrResponses?.name || "Respuesta"));
  if (!Array.isArray(responses) || responses.length === 0) return;
  console.log(`[BOT] Despachando respuestas para "${name}" a ${remoteJid}...`);

  for (const resp of responses) {
    try {
      // Demora en segundos configurada para esta casilla individual (default 2 segundos)
      const delaySec = resp.delaySeconds !== undefined && !isNaN(Number(resp.delaySeconds)) ? Number(resp.delaySeconds) : 2;
      const delayMs = Math.max(0, delaySec) * 1000;

      if (resp.type === "text") {
        if (!resp.content || !resp.content.trim()) continue;
        await safePresence(sock, "composing", remoteJid);
        if (delayMs > 0) await sleep(delayMs);
        await safeSendMessage(sock, remoteJid, { text: resp.content });
        console.log(`[BOT] Enviado texto (${delaySec}s): "${resp.content.substring(0, 30)}..."`);
        await safePresence(sock, "paused", remoteJid);
        await sleep(800);
      } else if (resp.type === "image") {
        if (!resp.path) continue;
        const fileFullPath = path.resolve(__dirname, resp.path);
        if (fs.existsSync(fileFullPath)) {
          await safePresence(sock, "composing", remoteJid);
          if (delayMs > 0) await sleep(delayMs);
          let buffer = fs.readFileSync(fileFullPath);
          await safeSendMessage(sock, remoteJid, {
            image: buffer,
            caption: resp.caption || ""
          });
          buffer = null;
          console.log(`[BOT] Enviada imagen: ${resp.path}`);
          await safePresence(sock, "paused", remoteJid);
          await sleep(800);
        } else {
          console.warn(`[BOT AVISO] Imagen no encontrada en disco: ${fileFullPath}`);
        }
      } else if (resp.type === "video") {
        if (!resp.path) continue;
        const fileFullPath = path.resolve(__dirname, resp.path);
        if (fs.existsSync(fileFullPath)) {
          await safePresence(sock, "composing", remoteJid);
          if (delayMs > 0) await sleep(delayMs);
          let buffer = fs.readFileSync(fileFullPath);
          const sizeMb = (buffer.length / (1024 * 1024)).toFixed(1);

          // Si el video supera 16 MB, enviarlo como archivo de video MP4 (WhatsApp soporta hasta 100 MB)
          if (buffer.length > 16 * 1024 * 1024) {
            console.log(`[BOT] Video pesado (${sizeMb} MB). Enviando como archivo multimedia para compatibilidad...`);
            await safeSendMessage(sock, remoteJid, {
              document: buffer,
              mimetype: "video/mp4",
              fileName: resp.fileName || path.basename(fileFullPath),
              caption: resp.caption || ""
            });
          } else {
            await safeSendMessage(sock, remoteJid, {
              video: buffer,
              caption: resp.caption || "",
              mimetype: "video/mp4"
            });
          }
          buffer = null;
          if (typeof global.gc === "function") global.gc();
          console.log(`[BOT] Enviado video (${sizeMb} MB): ${resp.path}`);
          await safePresence(sock, "paused", remoteJid);
          await sleep(800);
        } else {
          console.warn(`[BOT AVISO] Video no encontrado en disco: ${fileFullPath}`);
        }
      } else if (resp.type === "document") {
        if (!resp.path) continue;
        const fileFullPath = path.resolve(__dirname, resp.path);
        if (fs.existsSync(fileFullPath)) {
          await safePresence(sock, "composing", remoteJid);
          if (delayMs > 0) await sleep(delayMs);
          let buffer = fs.readFileSync(fileFullPath);
          const ext = path.extname(fileFullPath).toLowerCase();
          const defaultMime = ext === ".pdf" ? "application/pdf" : "application/octet-stream";
          await safeSendMessage(sock, remoteJid, {
            document: buffer,
            mimetype: resp.mimetype || defaultMime,
            fileName: resp.fileName || path.basename(fileFullPath),
            caption: resp.caption || ""
          });
          buffer = null;
          if (typeof global.gc === "function") global.gc();
          console.log(`[BOT] Enviado documento: ${resp.path}`);
          await safePresence(sock, "paused", remoteJid);
          await sleep(800);
        } else {
          console.warn(`[BOT AVISO] Documento no encontrado en disco: ${fileFullPath}`);
        }
      } else if (resp.type === "audio") {
        if (!resp.path) continue;
        let fileFullPath = path.resolve(__dirname, resp.path);
        if (fs.existsSync(fileFullPath)) {
          // Si no es OGG, intentar convertirlo a Opus OGG para notas de voz humanas nativas
          const convertedPath = convertToOpusOgg(fileFullPath);
          if (fs.existsSync(convertedPath)) {
            fileFullPath = convertedPath;
          }

          const ext = path.extname(fileFullPath).toLowerCase();
          const isOgg = ext === ".ogg" || ext === ".opus";
          let audioMime = "audio/ogg; codecs=opus";
          let usePtt = resp.ptt !== false;
          if (!isOgg) {
            if (ext === ".mp3") audioMime = "audio/mpeg";
            else if (ext === ".aac") audioMime = "audio/aac";
            else if (ext === ".m4a") audioMime = "audio/mp4";
            else if (ext === ".wav") audioMime = "audio/wav";
            // Las notas de voz (PTT) con ondas en WhatsApp exigen formato OGG Opus nativo.
            // Si el archivo no es OGG, enviarlo con ptt: false para que WhatsApp no rechace el envío.
            usePtt = false;
          }

          if (usePtt) {
            console.log(`[BOT] Grabando nota de voz en vivo...`);
            await safePresence(sock, "recording", remoteJid);
            await sleep(3500);
          } else {
            await safePresence(sock, "composing", remoteJid);
            if (delayMs > 0) await sleep(delayMs);
          }
          let buffer = fs.readFileSync(fileFullPath);
          try {
            await safeSendMessage(sock, remoteJid, {
              audio: buffer,
              mimetype: audioMime,
              ptt: usePtt
            });
            console.log(`[BOT] Enviado audio (${usePtt ? "PTT nota de voz" : "archivo"}, mime: ${audioMime}): ${fileFullPath}`);
          } catch (audioErr) {
            console.warn(`[BOT AVISO] Falló envío directo de audio (${audioErr.message}). Reintentando como documento...`);
            await safeSendMessage(sock, remoteJid, {
              document: buffer,
              mimetype: audioMime,
              fileName: path.basename(fileFullPath)
            });
            console.log(`[BOT] Enviado audio como documento alternativo.`);
          }
          buffer = null;
          await safePresence(sock, "paused", remoteJid);
          await sleep(800);
        } else {
          console.warn(`[BOT AVISO] Audio no encontrado en disco: ${fileFullPath}`);
        }
      }
    } catch (stepErr) {
      console.error(`[BOT ERROR] Error enviando paso (${resp.type}):`, stepErr.message);
    }
  }
  console.log(`[BOT] Secuencia completada para ${remoteJid}.`);

  // Disparar regla encadenada automática si está configurada
  if (ruleOrResponses && typeof ruleOrResponses === "object" && !Array.isArray(ruleOrResponses) && ruleOrResponses.nextRuleId) {
    const nextId = ruleOrResponses.nextRuleId;
    const delaySec = Math.max(0, Number(ruleOrResponses.nextRuleDelaySeconds) || 0);
    const targetRule = rules.find((r) => r.id === nextId && r.enabled !== false);
    if (targetRule) {
      console.log(`[BOT] Regla encadenada programada: "${targetRule.name}" en ${delaySec}s para ${remoteJid}...`);
      setTimeout(async () => {
        try {
          console.log(`[BOT] Disparando regla encadenada "${targetRule.name}" para ${remoteJid}...`);
          if (!userState[remoteJid]) userState[remoteJid] = {};
          if (!Array.isArray(userState[remoteJid].triggeredRules)) userState[remoteJid].triggeredRules = [];
          if (!userState[remoteJid].triggeredRules.includes(targetRule.id)) {
            userState[remoteJid].triggeredRules.push(targetRule.id);
          }
          userState[remoteJid].lastRuleId = targetRule.id;
          saveUserState();

          handleFollowUpTriggers(remoteJid, targetRule);
          await executeRuleResponses(sock, remoteJid, targetRule, targetRule.name);
        } catch (chainErr) {
          console.error(`[BOT ERROR] Error ejecutando regla encadenada ${nextId}:`, chainErr.message);
        }
      }, delaySec * 1000);
    }
  }
}

// Programador y Cancelador de Seguimientos (Remarketing)
function handleFollowUpTriggers(remoteJid, triggeredRule) {
  if (!triggeredRule) return;

  // 1. Cancelar seguimientos pendientes si esta regla fue configurada para cancelarlos
  for (const [key, fu] of Object.entries(followUps)) {
    if (fu.remoteJid === remoteJid && fu.status === "pending") {
      let cancelIds = Array.isArray(fu.cancelRuleIds) ? [...fu.cancelRuleIds] : [];
      const fuRule = rules.find((r) => r.id === fu.ruleId);
      if (fuRule) {
        if (Array.isArray(fuRule.followUps)) {
          for (const step of fuRule.followUps) {
            if (Array.isArray(step.cancelRuleIds)) cancelIds = cancelIds.concat(step.cancelRuleIds);
          }
        }
        if (Array.isArray(fuRule.followUp?.cancelRuleIds)) {
          cancelIds = cancelIds.concat(fuRule.followUp.cancelRuleIds);
        }
        if (Array.isArray(fuRule.followUpConfig?.cancelRuleIds)) {
          cancelIds = cancelIds.concat(fuRule.followUpConfig.cancelRuleIds);
        }
      }
      if (cancelIds.includes(triggeredRule.id)) {
        fu.status = "cancelled";
        console.log(`[BOT REMARKETING] Seguimiento cancelado para ${remoteJid} porque activó "${triggeredRule.name}"`);
      }
    }
  }

  // 2. Si esta regla ya tenía seguimientos previos pendientes para este cliente, cancelarlos
  for (const [key, fu] of Object.entries(followUps)) {
    if (fu.remoteJid === remoteJid && fu.ruleId === triggeredRule.id && fu.status === "pending") {
      fu.status = "cancelled";
    }
  }

  // 3. Iniciar el Seguimiento #1 de esta regla (si está activo y tiene casillas)
  const steps = Array.isArray(triggeredRule.followUps) && triggeredRule.followUps.length > 0
    ? triggeredRule.followUps
    : (triggeredRule.followUp ? [triggeredRule.followUp] : []);

  if (steps.length > 0 && steps[0].enabled !== false && Array.isArray(steps[0].responses) && steps[0].responses.length > 0) {
    const step0 = steps[0];
    const hours = step0.delayHours !== undefined ? Number(step0.delayHours) : 3;
    const minutes = step0.delayMinutes !== undefined ? Number(step0.delayMinutes) : 0;
    const totalMinutes = Math.max(1, (hours * 60) + minutes);
    const delayMs = totalMinutes * 60 * 1000;
    const selfKey = `${remoteJid}_${triggeredRule.id}_0`;

    followUps[selfKey] = {
      remoteJid,
      ruleId: triggeredRule.id,
      stepIndex: 0,
      productId: triggeredRule.productId,
      scheduledTime: Date.now() + delayMs,
      cancelRuleIds: step0.cancelRuleIds || [],
      isIntegrated: true,
      status: "pending"
    };
    console.log(`[BOT REMARKETING] Seguimiento #1 integrado programado para ${remoteJid} en ${hours}h ${minutes}m (${totalMinutes} min totales) (Regla: "${triggeredRule.name}")`);
  }

  // 4. (Compatibilidad) Iniciar seguimiento si alguna regla antigua independiente está escuchando a esta regla
  const matchingLegacyRules = rules.filter(
    (r) => r.isFollowUp && r.enabled !== false && r.followUpConfig?.triggerRuleId === triggeredRule.id
  );

  for (const fuRule of matchingLegacyRules) {
    const hours = fuRule.followUpConfig?.delayHours !== undefined ? Number(fuRule.followUpConfig.delayHours) : 3;
    const minutes = fuRule.followUpConfig?.delayMinutes !== undefined ? Number(fuRule.followUpConfig.delayMinutes) : 0;
    const totalMinutes = Math.max(1, (hours * 60) + minutes);
    const delayMs = totalMinutes * 60 * 1000;
    const key = `${remoteJid}_${fuRule.id}`;

    followUps[key] = {
      remoteJid,
      ruleId: fuRule.id,
      stepIndex: 0,
      productId: fuRule.productId,
      scheduledTime: Date.now() + delayMs,
      cancelRuleIds: fuRule.followUpConfig?.cancelRuleIds || [],
      isIntegrated: false,
      status: "pending"
    };
    console.log(`[BOT REMARKETING] Seguimiento independiente programado para ${remoteJid} en ${hours}h ${minutes}m (Regla: "${fuRule.name}")`);
  }
  saveFollowUps();
}

// Bucle en segundo plano para verificar y despachar seguimientos cumplidos
setInterval(async () => {
  if (!currentSocket || !isConnected) return;
  const now = Date.now();
  let changed = false;

  for (const [key, fu] of Object.entries(followUps)) {
    if (fu.status === "pending" && now >= fu.scheduledTime) {
      fu.status = "completed";
      changed = true;

      const fuRule = rules.find((r) => r.id === fu.ruleId);
      if (fuRule && fuRule.enabled !== false) {
        const fuProd = products.find(p => p.id === (fuRule.productId || "grafismo"));
        if (fuProd && fuProd.enabled === false) {
          console.log(`[BOT REMARKETING] Omitiendo seguimiento para ${fu.remoteJid} porque el producto "${fuProd.name}" está apagado.`);
          continue;
        }

        console.log(`[BOT REMARKETING] ⏰ ¡Tiempo cumplido! Enviando seguimiento a ${fu.remoteJid} (Regla: "${fuRule.name}")`);

        const stepIdx = fu.stepIndex !== undefined ? fu.stepIndex : 0;
        const steps = Array.isArray(fuRule.followUps) && fuRule.followUps.length > 0
          ? fuRule.followUps
          : (fuRule.followUp ? [fuRule.followUp] : []);

        if (fu.isIntegrated && steps[stepIdx] && Array.isArray(steps[stepIdx].responses) && steps[stepIdx].responses.length > 0) {
          await executeRuleResponses(currentSocket, fu.remoteJid, steps[stepIdx].responses, `${fuRule.name} (Seguimiento #${stepIdx + 1})`);
        } else if (fu.isIntegrated && fuRule.followUp && Array.isArray(fuRule.followUp.responses) && fuRule.followUp.responses.length > 0) {
          await executeRuleResponses(currentSocket, fu.remoteJid, fuRule.followUp.responses, `${fuRule.name} (Seguimiento)`);
        } else if (!fu.isIntegrated) {
          await executeRuleResponses(currentSocket, fu.remoteJid, fuRule.responses, fuRule.name);
        }

        // Encadenamiento al siguiente paso (si existe en followUps)
        if (fu.isIntegrated && steps.length > stepIdx + 1) {
          const nextStepIdx = stepIdx + 1;
          const nextStep = steps[nextStepIdx];
          if (nextStep && nextStep.enabled !== false && Array.isArray(nextStep.responses) && nextStep.responses.length > 0) {
            const hours = nextStep.delayHours !== undefined ? Number(nextStep.delayHours) : 24;
            const minutes = nextStep.delayMinutes !== undefined ? Number(nextStep.delayMinutes) : 0;
            const totalMinutes = Math.max(1, (hours * 60) + minutes);
            const delayMs = totalMinutes * 60 * 1000;
            const nextKey = `${fu.remoteJid}_${fuRule.id}_${nextStepIdx}`;

            let cancelRuleIds = Array.isArray(nextStep.cancelRuleIds) && nextStep.cancelRuleIds.length > 0
              ? nextStep.cancelRuleIds
              : (steps[0].cancelRuleIds || []);

            followUps[nextKey] = {
              remoteJid: fu.remoteJid,
              ruleId: fuRule.id,
              stepIndex: nextStepIdx,
              productId: fuRule.productId,
              scheduledTime: Date.now() + delayMs,
              cancelRuleIds: cancelRuleIds,
              isIntegrated: true,
              status: "pending"
            };
            console.log(`[BOT REMARKETING] 🔴 Seguimiento #${nextStepIdx + 1} programado para ${fu.remoteJid} en ${hours}h ${minutes}m (${totalMinutes} min totales) (Regla: "${fuRule.name}")`);
          }
        }
      }
    }
  }

  if (changed) saveFollowUps();
}, 20000);

// Servidor Web con Panel Constructor Multi-Producto y Streaming de Archivos
const server = http.createServer(async (req, res) => {
  const url = req.url.split("?")[0];

  // Servir archivos multimedia de la carpeta uploads
  if (url.startsWith("/uploads/")) {
    const filename = path.basename(url);
    const filePath = path.join(uploadsDir, filename);
    return serveStaticFile(res, filePath);
  }

  // Compatibilidad hacia atrás
  if (url === "/grafismo_foto.png") {
    return serveStaticFile(res, path.join(__dirname, "grafismo_foto.png"));
  }
  if (url === "/audio_vianda.ogg") {
    return serveStaticFile(res, path.join(__dirname, "audio_vianda.ogg"));
  }

  // Panel Web de Finanzas y Recaudación (Página Independiente)
  if (url === "/finanzas" || url === "/ingresos" || url === "/ventas") {
    return serveStaticFile(res, path.join(__dirname, "finanzas.html"));
  }

  // API Finanzas: Autenticación con PIN
  if (url === "/api/finanzas/auth" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const pin = String(body.pin || "").trim();
        const expectedPin = String(botConfig.financePin || "1234").trim();
        if (pin === expectedPin) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: true }));
        } else {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: "PIN incorrecto" }));
        }
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Finanzas: Obtener ventas, KPIs y productos (Protegido por PIN)
  if (url === "/api/finanzas/data" && req.method === "GET") {
    const pin = String(req.headers["x-finance-pin"] || "").trim();
    const expectedPin = String(botConfig.financePin || "1234").trim();
    if (pin !== expectedPin) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, error: "No autorizado" }));
    }

    const now = new Date();
    const todayStr = now.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });
    const yest = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const yestStr = yest.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" });

    const todaySales = sales.filter(s => s.date === todayStr);
    const yesterdaySales = sales.filter(s => s.date === yestStr);
    const todayTotal = todaySales.reduce((a, b) => a + Number(b.amount || 0), 0);
    const yesterdayTotal = yesterdaySales.reduce((a, b) => a + Number(b.amount || 0), 0);
    const allTimeTotal = sales.reduce((a, b) => a + Number(b.amount || 0), 0);
    const avgTicket = sales.length > 0 ? (allTimeTotal / sales.length) : 0;

    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      success: true,
      sales,
      summary: {
        todayTotal,
        todayCount: todaySales.length,
        yesterdayTotal,
        yesterdayCount: yesterdaySales.length,
        allTimeTotal,
        allTimeCount: sales.length,
        avgTicket
      },
      products
    }));
  }

  // API Finanzas: Cambiar PIN
  if (url === "/api/finanzas/change-pin" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const currentPin = String(body.currentPin || "").trim();
        const newPin = String(body.newPin || "").trim();
        const expectedPin = String(botConfig.financePin || "1234").trim();
        if (currentPin !== expectedPin) {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: "El PIN actual es incorrecto" }));
        }
        if (!newPin || newPin.length < 3) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: "El nuevo PIN debe tener al menos 3 caracteres" }));
        }
        botConfig.financePin = newPin;
        saveConfig();
        console.log(`[BOT FINANZAS] PIN de acceso actualizado con éxito.`);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Finanzas: Registrar Venta Manual
  if (url === "/api/finanzas/add-sale" && req.method === "POST") {
    const pin = String(req.headers["x-finance-pin"] || "").trim();
    const expectedPin = String(botConfig.financePin || "1234").trim();
    if (pin !== expectedPin) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, error: "No autorizado" }));
    }
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const now = new Date();
        const manualSale = {
          id: "manual_" + Date.now(),
          timestamp: Date.now(),
          date: now.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
          time: now.toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }),
          phone: (body.phone || "").replace(/[^0-9]/g, "") || "Manual",
          clientName: body.clientName || "Venta Manual",
          amount: Number(body.amount) || 0,
          operationId: body.operationId || ("MANUAL_" + Math.random().toString(36).slice(2, 8).toUpperCase()),
          productId: "manual",
          productName: body.productName || "Venta Directa",
          ruleName: "Ingreso Manual",
          ruleId: "manual",
          status: "Aprobado ✅",
          originMessage: "Carga manual de panel",
          adTag: "Manual",
          saleType: "Directa ⚡",
          leadTimeMinutes: 0
        };
        sales.unshift(manualSale);
        saveSales();
        console.log(`[BOT FINANZAS] Venta manual registrada: $${manualSale.amount} (${manualSale.productName})`);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: true, sale: manualSale }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // API Finanzas: Eliminar Venta
  if (url === "/api/finanzas/delete-sale" && req.method === "POST") {
    const pin = String(req.headers["x-finance-pin"] || "").trim();
    const expectedPin = String(botConfig.financePin || "1234").trim();
    if (pin !== expectedPin) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, error: "No autorizado" }));
    }
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        sales = sales.filter(s => s.id !== body.id);
        saveSales();
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint API: Obtener reglas, productos y seguimientos en tiempo real
  if (url === "/api/data" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ rules, products, followUps, isConnected, botConfig, userState }));
  }

  // Endpoint API: Diagnóstico y monitoreo en vivo de mensajes, logs y estado
  if (url === "/api/debug" && req.method === "GET") {
    const mem = process.memoryUsage();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      isConnected,
      botUser: currentSocket?.user || null,
      memory: {
        rssMb: (mem.rss / (1024 * 1024)).toFixed(1) + " MB",
        heapUsedMb: (mem.heapUsed / (1024 * 1024)).toFixed(1) + " MB",
        heapTotalMb: (mem.heapTotal / (1024 * 1024)).toFixed(1) + " MB",
        gcAvailable: typeof global.gc === "function"
      },
      recentIncoming,
      recentLogs: recentLogs.slice(-50),
      userState,
      followUps,
      rulesCount: rules.length,
      productsCount: products.length
    }, null, 2));
  }

  // Endpoint API: Forzar liberación inmediata de memoria RAM (Garbage Collector)
  if (url === "/api/clean-memory" && (req.method === "POST" || req.method === "GET")) {
    const before = process.memoryUsage();
    if (typeof global.gc === "function") global.gc();
    const after = process.memoryUsage();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({
      success: true,
      message: "Memoria RAM liberada con éxito",
      freedMb: ((before.rss - after.rss) / (1024 * 1024)).toFixed(2) + " MB",
      currentRssMb: (after.rss / (1024 * 1024)).toFixed(1) + " MB",
      currentHeapMb: (after.heapUsed / (1024 * 1024)).toFixed(1) + " MB",
      gcAvailable: typeof global.gc === "function"
    }));
  }

  // Endpoint API: Envío de mensaje de prueba directo para verificar entrega en WhatsApp
  if (url === "/api/test-send" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        let targetNumber = (body.number || "").replace(/[^0-9]/g, "");
        const messageText = body.text || "¡Hola! Este es un mensaje de prueba desde tu bot de WhatsApp 🤖✅";
        if (!targetNumber) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: "Debes ingresar un número de teléfono con código de país (ej: 54911xxxxxxxx)" }));
        }
        if (!currentSocket || !isConnected) {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: "El bot no está conectado a WhatsApp en este momento." }));
        }

        const targetJid = targetNumber.includes("@") ? targetNumber : `${targetNumber}@s.whatsapp.net`;
        console.log(`[TEST MANUAL] Enviando mensaje de prueba a ${targetJid}: "${messageText}"`);
        await safeSendMessage(currentSocket, targetJid, { text: messageText });
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: true, message: `Mensaje enviado correctamente a ${targetJid}` }));
      } catch (err) {
        console.error(`[TEST MANUAL ERROR]:`, err.message);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint API: Despacho manual de regla a un número o lote de números (Textos + Video + Audio + Seguimientos)
  if (url === "/api/dispatch-rule" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const rawNumbers = Array.isArray(body.numbers) ? body.numbers : [body.number];
        const ruleId = body.ruleId || "rule_1791194494159_0";
        const includeAudioNow = body.includeAudioNow !== false; // Default true: incluir audio
        const capDelay = body.capDelaySec ? Math.max(1, Number(body.capDelaySec)) : 4; // Limitar demoras largas a 4s

        const targetNumbers = rawNumbers
          .map(n => String(n || "").replace(/[^0-9]/g, ""))
          .filter(n => n.length >= 10);

        if (targetNumbers.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: "Debes enviar al menos un número de teléfono válido" }));
        }

        if (!currentSocket || !isConnected) {
          res.writeHead(503, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: "El bot no está conectado a WhatsApp en este momento." }));
        }

        const targetRule = rules.find(r => r.id === ruleId);
        if (!targetRule) {
          res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: `Regla ${ruleId} no encontrada` }));
        }

        const isBatch = targetNumbers.length > 1;
        if (isBatch) {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({
            success: true,
            message: `Despacho de regla "${targetRule.name}" iniciado en segundo plano para ${targetNumbers.length} números`,
            total: targetNumbers.length
          }));
        }

        const processSingleNumber = async (num) => {
          let cleanNum = num;
          if (cleanNum.startsWith("549") && cleanNum.length > 13) {
            cleanNum = cleanNum.slice(0, 13);
          }
          const targetJid = `${cleanNum}@s.whatsapp.net`;
          console.log(`[DISPATCH MANUAL] Iniciando despacho para ${targetJid} (Regla: "${targetRule.name}")...`);

          if (!userState[targetJid]) userState[targetJid] = {};
          userState[targetJid].activeProduct = targetRule.productId || "cerrajeria";
          userState[targetJid].lastRuleId = targetRule.id;
          userState[targetJid].updatedAt = Date.now();
          saveUserState();

          let responsesToSend = (targetRule.responses || []).map(r => {
            const copy = { ...r };
            if (capDelay && copy.delaySeconds > capDelay) {
              copy.delaySeconds = capDelay;
            }
            return copy;
          });

          // 1. Textos + Video
          await executeRuleResponses(currentSocket, targetJid, responsesToSend, targetRule.name);

          // 2. Audio de regalo extra (nota de voz PTT)
          const firstFu = (targetRule.followUps && targetRule.followUps[0]) || targetRule.followUp;
          if (includeAudioNow && firstFu && Array.isArray(firstFu.responses) && firstFu.responses.length > 0) {
            await sleep(3000);
            await executeRuleResponses(currentSocket, targetJid, firstFu.responses, `${targetRule.name} (Audio Regalo Extra)`);
            console.log(`[DISPATCH MANUAL] Audio de regalo extra enviado a ${targetJid}`);

            // Programar el seguimiento #2 (dudas herramientas, 45 min)
            if (targetRule.followUps && targetRule.followUps.length > 1) {
              const step1 = targetRule.followUps[1];
              if (step1.enabled !== false && Array.isArray(step1.responses) && step1.responses.length > 0) {
                const hours = step1.delayHours !== undefined ? Number(step1.delayHours) : 0;
                const minutes = step1.delayMinutes !== undefined ? Number(step1.delayMinutes) : 45;
                const totalMinutes = Math.max(1, (hours * 60) + minutes);
                const delayMs = totalMinutes * 60 * 1000;
                const nextKey = `${targetJid}_${targetRule.id}_1`;
                followUps[nextKey] = {
                  remoteJid: targetJid,
                  ruleId: targetRule.id,
                  stepIndex: 1,
                  productId: targetRule.productId,
                  scheduledTime: Date.now() + delayMs,
                  cancelRuleIds: step1.cancelRuleIds || [],
                  isIntegrated: true,
                  status: "pending"
                };
                saveFollowUps();
                console.log(`[DISPATCH MANUAL] Seguimiento #2 (dudas herramientas) programado para ${targetJid} en ${totalMinutes} min`);
              }
            }
          } else {
            handleFollowUpTriggers(targetJid, targetRule);
          }
        };

        if (isBatch) {
          (async () => {
            for (let i = 0; i < targetNumbers.length; i++) {
              try {
                await processSingleNumber(targetNumbers[i]);
                console.log(`[DISPATCH MANUAL] Contacto [${i + 1}/${targetNumbers.length}] completado.`);
                if (i < targetNumbers.length - 1) {
                  const pauseBetweenContacts = 7000 + Math.floor(Math.random() * 5000); // 7-12s
                  console.log(`[DISPATCH MANUAL] Pausa de seguridad: ${Math.round(pauseBetweenContacts / 1000)}s...`);
                  await sleep(pauseBetweenContacts);
                }
              } catch (singleErr) {
                console.error(`[DISPATCH MANUAL ERROR] Error procesando ${targetNumbers[i]}:`, singleErr.message);
              }
            }
            console.log(`[DISPATCH MANUAL] ✅ Despacho por lotes completado para los ${targetNumbers.length} contactos.`);
          })();
        } else {
          await processSingleNumber(targetNumbers[0]);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: true, message: `Regla enviada con éxito a ${targetNumbers[0]}` }));
        }
      } catch (err) {
        console.error(`[DISPATCH MANUAL ERROR]:`, err.message);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: err.message }));
        }
      }
    });
    return;
  }

  // Endpoint API: Probar clave(s) de Google Gemini (soporta múltiples separadas por coma/espacio)
  if (url === "/api/test-gemini" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const rawKeyInput = String(body.apiKey || botConfig.geminiApiKey || "").trim();
        const testKeys = rawKeyInput.split(/[\n,;\s]+/).map(k => k.trim()).filter(k => k.length > 5);

        if (testKeys.length === 0) {
          res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: "Debes ingresar al menos una clave API de Google Gemini" }));
        }

        botConfig.geminiApiKey = rawKeyInput;
        saveConfig();

        const results = [];
        let anySuccess = false;

        for (let i = 0; i < testKeys.length; i++) {
          const k = testKeys[i];
          const masked = `...${k.slice(-6)}`;
          try {
            const detectedModel = await getAvailableGeminiModel(k);
            results.push(`Clave #${i + 1} (${masked}): Conectada ✅ (${detectedModel})`);
            anySuccess = true;
          } catch (err) {
            results.push(`Clave #${i + 1} (${masked}): Error ⚠️ (${err.message.slice(0, 40)})`);
          }
        }

        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({
          success: anySuccess,
          count: testKeys.length,
          message: results.join(" | ")
        }));
      } catch (err) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });
    return;
  }

  // Endpoint API: Forzar ejecución inmediata de un seguimiento pendiente (para pruebas)
  if (url === "/api/trigger-followup" && req.method === "POST") {
    const chunks = [];
    req.on("data", chunk => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        const key = body.key;
        if (key && followUps[key]) {
          followUps[key].scheduledTime = Date.now() - 1000;
          saveFollowUps();
          console.log(`[ADMIN TEST] Seguimiento adelantado manualmente: ${key}`);
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: true, message: "Seguimiento adelantado. Se enviará en segundos." }));
        }
        res.writeHead(404, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, error: "Seguimiento no encontrado" }));
      } catch (e) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Endpoint API: Limpiar historial de seguimientos
  if (url === "/api/clear-followups" && req.method === "POST") {
    followUps = {};
    saveFollowUps();
    console.log(`[ADMIN TEST] Historial de seguimientos vaciado`);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ success: true }));
  }

  // Endpoint API: Subir archivo en streaming directo a disco (0 consumo de RAM)
  if (url === "/api/upload" && req.method === "POST") {
    const pass = req.headers["x-password"];
    if (pass !== ADMIN_PASSWORD) {
      res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ success: false, error: "Contraseña incorrecta" }));
    }

    const rawFilename = req.headers["x-filename"];
    const origName = rawFilename ? decodeURIComponent(rawFilename) : "archivo";
    const ext = path.extname(origName) || ".bin";
    const rawBase = path.basename(origName, ext);
    const cleanBase = rawBase.replace(/[^a-zA-Z0-9_-]/g, "_").substring(0, 30);
    const filename = `${Date.now()}_${cleanBase}${ext}`;
    const savePath = path.join(uploadsDir, filename);

    const writeStream = fs.createWriteStream(savePath);
    req.pipe(writeStream);

    writeStream.on("finish", () => {
      console.log(`[BOT UPLOAD] Archivo guardado en disco: ${savePath}`);
      let finalFilename = filename;
      const audioExts = [".aac", ".mp3", ".wav", ".m4a"];
      if (audioExts.includes(ext.toLowerCase())) {
        const conv = convertToOpusOgg(savePath);
        if (conv !== savePath && fs.existsSync(conv)) {
          finalFilename = path.basename(conv);
          console.log(`[BOT UPLOAD] Archivo convertido en subida: ${finalFilename}`);
        }
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({
        success: true,
        path: `./uploads/${finalFilename}`,
        fileName: origName
      }));
    });

    writeStream.on("error", (err) => {
      console.error("[BOT UPLOAD ERROR]:", err);
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ success: false, error: err.message }));
    });
    return;
  }

  // Endpoint API: Guardar reglas y productos
  if (url === "/api/save" && req.method === "POST") {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", async () => {
      try {
        const bodyStr = Buffer.concat(chunks).toString("utf8");
        const payload = JSON.parse(bodyStr);

        if (payload.password !== ADMIN_PASSWORD) {
          res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
          return res.end(JSON.stringify({ success: false, error: "Contraseña incorrecta" }));
        }

        if (Array.isArray(payload.rules)) {
          fs.writeFileSync(rulesPath, JSON.stringify(payload.rules, null, 2), "utf8");
          rules = payload.rules;
        }

        if (Array.isArray(payload.products)) {
          fs.writeFileSync(productsPath, JSON.stringify(payload.products, null, 2), "utf8");
          products = payload.products;
        }

        if (payload.config && typeof payload.config === "object") {
          if (payload.config.geminiApiKey !== undefined) {
            botConfig.geminiApiKey = payload.config.geminiApiKey.trim();
            saveConfig();
            console.log(`[ADMIN] Gemini API Key guardada.`);
          }
        }

        console.log(`[ADMIN] ¡Datos guardados! ${rules.length} reglas y ${products.length} productos.`);
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: true, count: rules.length }));
      } catch (e) {
        console.error("[ADMIN ERROR] Error guardando datos:", e);
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        return res.end(JSON.stringify({ success: false, error: e.message }));
      }
    });
    return;
  }

  // Panel de Administración Dinámico
  if (url === "/admin") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Panel de Control - WhatsApp Bot</title>
        <style>
          :root {
            --wa-green: #25D366;
            --wa-dark: #075E54;
            --wa-teal: #128C7E;
            --wa-bg: #f0f2f5;
            --card-bg: #ffffff;
            --border: #e2e8f0;
            --text-dark: #1e293b;
            --text-muted: #64748b;
          }
          * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
          body { background: var(--wa-bg); color: var(--text-dark); padding-bottom: 120px; }
          
          header {
            background: linear-gradient(135deg, var(--wa-dark), var(--wa-teal));
            color: white;
            padding: 14px 20px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            box-shadow: 0 2px 10px rgba(0,0,0,0.15);
            position: sticky;
            top: 0;
            z-index: 100;
          }
          .header-title h1 { font-size: 17px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
          .header-title p { font-size: 11px; opacity: 0.85; }
          .status-badge {
            display: inline-flex;
            align-items: center;
            gap: 6px;
            background: rgba(255,255,255,0.2);
            padding: 4px 10px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: 600;
          }
          .status-dot { width: 8px; height: 8px; border-radius: 50%; background: ${isConnected ? "#4ade80" : "#fbbf24"}; }

          .container { max-width: 800px; margin: 20px auto; padding: 0 16px; }

          /* Tabs de Productos con deslizador horizontal que NUNCA se achican */
          .product-tabs-container {
            display: flex;
            align-items: center;
            gap: 8px;
            overflow-x: auto;
            overflow-y: hidden;
            white-space: nowrap;
            padding: 4px 4px 12px 4px;
            margin-bottom: 12px;
            scroll-behavior: smooth;
            -webkit-overflow-scrolling: touch;
          }
          .product-tabs-container::-webkit-scrollbar {
            height: 6px;
          }
          .product-tabs-container::-webkit-scrollbar-track {
            background: #e2e8f0;
            border-radius: 10px;
          }
          .product-tabs-container::-webkit-scrollbar-thumb {
            background: #94a3b8;
            border-radius: 10px;
          }
          .product-tabs-container::-webkit-scrollbar-thumb:hover {
            background: #64748b;
          }
          .tab-group-item {
            display: inline-flex;
            align-items: center;
            flex-shrink: 0;
            border-radius: 10px;
            overflow: hidden;
            box-shadow: 0 1px 3px rgba(0,0,0,0.06);
            transition: all 0.2s;
            border: 1px solid var(--border);
          }
          .tab-group-item.active {
            border-color: var(--wa-teal);
            box-shadow: 0 3px 10px rgba(18, 140, 126, 0.35);
          }
          .product-tab {
            background: white;
            border: none;
            padding: 9px 15px;
            font-size: 13px;
            font-weight: bold;
            color: #334155;
            cursor: pointer;
            white-space: nowrap;
            flex-shrink: 0;
            display: flex;
            align-items: center;
            gap: 6px;
            transition: background 0.15s;
          }
          .product-tab:hover { background: #f8fafc; }
          .product-tab.active {
            background: var(--wa-teal);
            color: white;
          }
          .tab-action-btn {
            height: 38px;
            border: none;
            padding: 0 8px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 12px;
            transition: all 0.15s;
            flex-shrink: 0;
          }
          .tab-dup-btn {
            background: #f1f5f9;
            color: #4f46e5;
            border-left: 1px solid var(--border);
          }
          .tab-dup-btn:hover {
            background: #e0e7ff;
            color: #4338ca;
          }
          .tab-group-item.active .tab-dup-btn {
            background: #0f766e;
            color: #ccfbf1;
            border-left: 1px solid rgba(255,255,255,0.25);
          }
          .tab-group-item.active .tab-dup-btn:hover {
            background: #115e59;
            color: white;
          }
          .tab-del-btn {
            background: #fee2e2;
            color: #dc2626;
            border-left: 1px solid #fecaca;
            font-weight: bold;
          }
          .tab-del-btn:hover {
            background: #fca5a5;
            color: #991b1b;
          }
          .tab-group-item.active .tab-del-btn {
            background: #e11d48;
            color: white;
            border-left: 1px solid rgba(255,255,255,0.25);
          }
          .tab-group-item.active .tab-del-btn:hover {
            background: #be123c;
          }
          .nav-scroll-btn {
            background: white;
            border: 1px solid #cbd5e1;
            border-radius: 6px;
            width: 28px;
            height: 28px;
            font-size: 11px;
            font-weight: bold;
            color: #475569;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.15s;
          }
          .nav-scroll-btn:hover {
            background: #f1f5f9;
            color: #0f172a;
            border-color: #94a3b8;
          }
          .btn-add-product {
            background: #f1f5f9;
            border: 1px dashed #94a3b8;
            color: #475569;
            padding: 9px 14px;
            border-radius: 10px;
            font-size: 13px;
            font-weight: bold;
            cursor: pointer;
            white-space: nowrap;
            flex-shrink: 0;
          }

          /* Password Gate */
          #authModal {
            background: white;
            max-width: 400px;
            margin: 60px auto;
            padding: 30px;
            border-radius: 16px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.1);
            text-align: center;
          }
          #authModal input {
            width: 100%;
            padding: 14px;
            font-size: 16px;
            border: 2px solid var(--border);
            border-radius: 10px;
            margin: 15px 0;
            outline: none;
            text-align: center;
          }
          #authModal button {
            width: 100%;
            padding: 14px;
            background: var(--wa-teal);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
          }

          /* Rule Card */
          .rule-card {
            background: var(--card-bg);
            border-radius: 14px;
            border: 1px solid var(--border);
            margin-bottom: 24px;
            box-shadow: 0 3px 12px rgba(0,0,0,0.05);
            overflow: hidden;
            transition: opacity 0.2s;
          }
          .rule-card.disabled { opacity: 0.65; border-left: 4px solid #94a3b8; }
          .rule-card.enabled { border-left: 4px solid var(--wa-green); }

          .rule-header {
            background: #fafafa;
            border-bottom: 1px solid var(--border);
            padding: 12px 16px;
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
            flex-wrap: wrap;
          }
          .rule-header-left { display: flex; align-items: center; gap: 10px; flex: 1; }
          
          /* Switch ON / OFF */
          .switch-btn {
            padding: 6px 12px;
            border-radius: 20px;
            font-size: 12px;
            font-weight: bold;
            border: none;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 4px;
          }
          .switch-on { background: #dcfce7; color: #15803d; }
          .switch-off { background: #fee2e2; color: #b91c1c; }

          .rule-title-input {
            font-size: 15px;
            font-weight: bold;
            color: var(--wa-dark);
            border: 1px solid transparent;
            background: transparent;
            padding: 4px 8px;
            border-radius: 6px;
            flex: 1;
          }
          .rule-title-input:focus { border-color: var(--wa-teal); background: white; outline: none; }
          
          .btn-delete-rule {
            background: #fee2e2;
            color: #dc2626;
            border: none;
            padding: 6px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: bold;
            cursor: pointer;
          }
          .rule-body { padding: 16px; }

          /* Modo Seguimiento */
          .followup-box {
            background: #faf5ff;
            border: 1.5px solid #d8b4fe;
            border-radius: 10px;
            padding: 14px;
            margin-bottom: 14px;
          }
          .followup-title { font-size: 13px; font-weight: bold; color: #6b21a8; margin-bottom: 10px; display: flex; align-items: center; gap: 6px; }
          .followup-row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin-bottom: 10px; }
          .followup-row label { font-size: 13px; font-weight: 600; color: #334155; }
          .followup-row input[type="number"] { width: 65px; padding: 6px; border: 1px solid #c084fc; border-radius: 6px; font-size: 14px; text-align: center; }
          .followup-row select { padding: 6px 10px; border: 1px solid #c084fc; border-radius: 6px; font-size: 13px; max-width: 100%; }

          .form-group { margin-bottom: 14px; }
          .form-group label { display: block; font-size: 13px; font-weight: bold; color: var(--text-muted); margin-bottom: 6px; }
          .form-group input[type="text"] {
            width: 100%;
            padding: 9px 12px;
            font-size: 14px;
            border: 1px solid var(--border);
            border-radius: 8px;
            outline: none;
          }
          .form-group input[type="text"]:focus { border-color: var(--wa-teal); }
          .help-text { font-size: 11px; color: var(--text-muted); margin-top: 4px; }

          /* Casillas / Actions */
          .casillas-title {
            font-size: 12px;
            font-weight: bold;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            color: var(--wa-teal);
            margin: 16px 0 10px 0;
          }
          .casilla-item {
            background: #f8fafc;
            border: 1px solid #e2e8f0;
            border-radius: 10px;
            padding: 12px 14px;
            margin-bottom: 12px;
          }

          /* Estilos Violeta para Reglas y Casillas de Seguimiento */
          .rule-card.followup-card {
            border-left: 6px solid #8b5cf6 !important;
            background: #fdfcfe;
          }
          .rule-card.followup-card .rule-header {
            background: #f5f0ff;
            border-bottom: 1px solid #e9d5ff;
          }
          .casilla-item.casilla-followup {
            background: #faf5ff !important;
            border: 2px solid #a855f7 !important;
            box-shadow: 0 3px 12px rgba(168, 85, 247, 0.12) !important;
          }
          .badge-followup-tag {
            background: #7c3aed;
            color: #ffffff;
            font-size: 11px;
            font-weight: 800;
            padding: 3px 9px;
            border-radius: 6px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            letter-spacing: 0.3px;
            box-shadow: 0 1px 3px rgba(124, 58, 237, 0.3);
          }
          .casilla-followup .delay-control {
            border-color: #d8b4fe !important;
            background: #f3e8ff !important;
            color: #6b21a8 !important;
          }
          .casilla-followup .delay-control input {
            border-color: #c084fc !important;
            color: #6b21a8 !important;
            background: #ffffff !important;
          }
          .casilla-followup textarea.casilla-textarea {
            border-color: #d8b4fe !important;
            background: #ffffff !important;
          }
          .casilla-followup textarea.casilla-textarea:focus {
            border-color: #7c3aed !important;
            box-shadow: 0 0 0 3px rgba(124, 58, 237, 0.18) !important;
          }
          .casilla-followup .file-upload-label {
            background: #ffffff !important;
            border: 1.5px dashed #8b5cf6 !important;
            color: #7c3aed !important;
          }
          .casilla-followup .file-upload-label:hover {
            background: #f5f3ff !important;
          }

          /* Estilos ROJOS para Seguimientos Adicionales (#2, #3, etc.) */
          .followup-card-section.followup-red {
            margin-top: 16px;
            border: 2px solid #f87171 !important;
            background: #fef2f2 !important;
            border-radius: 12px;
            padding: 16px;
          }
          .badge-followup-red {
            background: #dc2626 !important;
            color: #ffffff !important;
            font-size: 11px;
            font-weight: 800;
            padding: 3px 9px;
            border-radius: 6px;
            display: inline-flex;
            align-items: center;
            gap: 4px;
            letter-spacing: 0.3px;
            box-shadow: 0 1px 3px rgba(220, 38, 38, 0.3);
          }
          .casilla-item.casilla-followup-red {
            background: #fff5f5 !important;
            border: 2px solid #ef4444 !important;
            box-shadow: 0 3px 12px rgba(239, 68, 68, 0.12) !important;
          }
          .casilla-followup-red .delay-control {
            border-color: #fca5a5 !important;
            background: #fee2e2 !important;
            color: #991b1b !important;
          }
          .casilla-followup-red .delay-control input {
            border-color: #f87171 !important;
            color: #991b1b !important;
            background: #ffffff !important;
          }
          .casilla-followup-red textarea.casilla-textarea {
            border-color: #fca5a5 !important;
            background: #ffffff !important;
          }
          .casilla-followup-red textarea.casilla-textarea:focus {
            border-color: #dc2626 !important;
            box-shadow: 0 0 0 3px rgba(220, 38, 38, 0.18) !important;
          }
          .casilla-followup-red .file-upload-label {
            background: #ffffff !important;
            border: 1.5px dashed #ef4444 !important;
            color: #dc2626 !important;
          }
          .casilla-followup-red .file-upload-label:hover {
            background: #fef2f2 !important;
          }
          .btn-add-fu-red {
            display: block;
            width: 100%;
            margin-top: 14px;
            padding: 12px 20px;
            background: linear-gradient(135deg, #ef4444, #dc2626);
            color: white;
            border: none;
            border-radius: 10px;
            font-size: 13px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 3px 10px rgba(220, 38, 38, 0.25);
            transition: all 0.2s ease;
          }
          .btn-add-fu-red:hover {
            background: linear-gradient(135deg, #dc2626, #b91c1c);
            transform: translateY(-1px);
            box-shadow: 0 5px 14px rgba(220, 38, 38, 0.35);
          }
          .btn-del-fu-step {
            background: #fee2e2;
            color: #991b1b;
            border: 1px solid #fca5a5;
            padding: 4px 10px;
            border-radius: 6px;
            font-size: 11px;
            font-weight: bold;
            cursor: pointer;
          }
          .btn-del-fu-step:hover {
            background: #fecaca;
            color: #7f1d1d;
          }
          .b-red-aud { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
          .b-red-pdf { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
          .b-red-vid { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
          .b-red-img { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
          .b-red-txt { background: #fee2e2; color: #991b1b; border: 1px solid #fca5a5; }
          .casilla-top {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            flex-wrap: wrap;
            gap: 8px;
          }
          .type-badge {
            display: inline-flex;
            align-items: center;
            gap: 5px;
            font-size: 11px;
            font-weight: bold;
            padding: 3px 8px;
            border-radius: 6px;
            text-transform: uppercase;
          }
          .badge-text { background: #e0f2fe; color: #0284c7; }
          .badge-image { background: #f3e8ff; color: #7e22ce; }
          .badge-video { background: #fee2e2; color: #b91c1c; }
          .badge-document { background: #ffedd5; color: #c2410c; }
          .badge-audio { background: #dcfce7; color: #15803d; }

          .casilla-controls { display: flex; align-items: center; gap: 6px; }
          .delay-control {
            display: inline-flex;
            align-items: center;
            gap: 4px;
            font-size: 12px;
            font-weight: 600;
            color: #475569;
            background: white;
            padding: 3px 8px;
            border-radius: 6px;
            border: 1px solid var(--border);
          }
          .delay-control input {
            width: 38px;
            text-align: center;
            border: 1px solid #cbd5e1;
            border-radius: 4px;
            padding: 2px;
            font-weight: bold;
          }

          .btn-ctrl {
            background: white;
            border: 1px solid var(--border);
            padding: 4px 8px;
            border-radius: 6px;
            font-size: 12px;
            cursor: pointer;
          }
          .btn-ctrl:hover { background: #f1f5f9; }
          .btn-ctrl-delete { color: #ef4444; }

          textarea.casilla-textarea {
            width: 100%;
            min-height: 120px;
            padding: 10px;
            font-size: 14px;
            border: 1px solid var(--border);
            border-radius: 8px;
            outline: none;
            resize: vertical !important;
            line-height: 1.4;
          }
          textarea.casilla-textarea:focus { border-color: var(--wa-teal); }

          .media-preview-box { margin: 8px 0; }
          .media-preview-box img, .media-preview-box video {
            max-width: 100%;
            max-height: 150px;
            border-radius: 8px;
            border: 1px solid var(--border);
            display: block;
          }
          .media-preview-box audio { width: 100%; }

          .file-upload-row { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
          .file-upload-label {
            background: white;
            border: 1px dashed var(--wa-teal);
            color: var(--wa-teal);
            padding: 7px 12px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 6px;
          }
          .file-upload-label:hover { background: #f0fdf4; }
          .file-upload-input { display: none; }
          .file-status-tag { font-size: 11px; color: #16a34a; font-weight: bold; }

          /* Add Casilla Toolbar */
          .add-casilla-box {
            background: #ffffff;
            border: 2px dashed #cbd5e1;
            border-radius: 10px;
            padding: 10px;
            text-align: center;
            margin-top: 14px;
          }
          .add-casilla-label { font-size: 11px; font-weight: bold; color: var(--text-muted); margin-bottom: 6px; display: block; }
          .add-buttons-row { display: flex; flex-wrap: wrap; gap: 6px; justify-content: center; }
          .btn-add-type {
            border: 1px solid var(--border);
            background: white;
            padding: 6px 10px;
            border-radius: 8px;
            font-size: 12px;
            font-weight: 600;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            gap: 4px;
          }
          .btn-add-type.b-txt { color: #0284c7; border-color: #bae6fd; }
          .btn-add-type.b-img { color: #7e22ce; border-color: #e9d5ff; }
          .btn-add-type.b-vid { color: #b91c1c; border-color: #fecaca; }
          .btn-add-type.b-pdf { color: #c2410c; border-color: #fed7aa; }
          .btn-add-type.b-aud { color: #15803d; border-color: #bbf7d0; }

          .btn-new-rule {
            width: 100%;
            background: white;
            border: 2px dashed var(--wa-teal);
            color: var(--wa-teal);
            padding: 14px;
            border-radius: 12px;
            font-size: 14px;
            font-weight: bold;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
            margin-bottom: 30px;
          }
          .btn-new-rule:hover { background: #f0fdf4; }

          /* Sticky Footer */
          .sticky-footer {
            position: fixed;
            bottom: 0;
            left: 0;
            right: 0;
            background: white;
            border-top: 1px solid var(--border);
            padding: 14px 20px;
            display: flex;
            justify-content: center;
            box-shadow: 0 -4px 15px rgba(0,0,0,0.08);
            z-index: 100;
          }
          .btn-save-all {
            width: 100%;
            max-width: 600px;
            background: var(--wa-green);
            color: white;
            border: none;
            padding: 16px;
            border-radius: 12px;
            font-size: 16px;
            font-weight: bold;
            cursor: pointer;
            box-shadow: 0 4px 14px rgba(37, 211, 102, 0.4);
            display: flex;
            align-items: center;
            justify-content: center;
            gap: 8px;
          }
          .btn-save-all:active { transform: scale(0.99); }
          .btn-save-all:disabled { background: #94a3b8; cursor: not-allowed; }

          #toastAlert {
            display: none;
            position: fixed;
            top: 70px;
            left: 50%;
            transform: translateX(-50%);
            padding: 12px 24px;
            border-radius: 10px;
            font-size: 14px;
            font-weight: bold;
            color: white;
            box-shadow: 0 4px 15px rgba(0,0,0,0.25);
            z-index: 1000;
            text-align: center;
            max-width: 90%;
          }
          .toast-success { background: #16a34a; }
          .toast-error { background: #dc2626; }
          .toast-info { background: #0284c7; }
        </style>
      </head>
      <body>
        <div id="toastAlert"></div>

        <header>
          <div class="header-title">
            <h1>⚙️ Constructor Multi-Producto WhatsApp</h1>
            <p>Embudos independientes, seguimiento automático y demoras en segundos</p>
          </div>
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">
            <a href="/finanzas" target="_blank" style="background:#10b981;color:white;text-decoration:none;padding:8px 16px;border-radius:10px;font-weight:bold;font-size:13px;display:inline-flex;align-items:center;gap:6px;box-shadow:0 2px 6px rgba(16,185,129,0.3);">💰 Ver Finanzas & Ingresos</a>
            <div class="status-badge">
              <span class="status-dot"></span>
              <span>${isConnected ? "Bot Activo" : "Sin Conexión"}</span>
            </div>
          </div>
        </header>

        <!-- Pantalla de Login -->
        <div id="authModal">
          <h2 style="color:var(--wa-dark);margin-bottom:8px;">Panel de Administración</h2>
          <p style="font-size:14px;color:var(--text-muted);">Ingresa tu contraseña para editar el bot</p>
          <input type="password" id="passInput" placeholder="Contraseña (admin2026)" />
          <button onclick="checkAuth()">Ingresar al Panel</button>
        </div>

        <!-- Constructor Principal -->
        <div class="container" id="mainPanel" style="display:none;">
          <!-- Barra de Configuración de IA (Google Gemini Vision - 100% Gratis) -->
          <!-- Barra de Configuración de IA (Google Gemini Vision - Múltiples Claves Gratuitas con Rotación) -->
          <div id="aiConfigBox" style="background:#f0fdf4;border:2px solid #86efac;border-radius:12px;padding:16px;margin-bottom:20px;box-shadow:0 3px 12px rgba(34,197,94,0.12);">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:20px;">🤖</span>
                <span style="font-size:15px;font-weight:bold;color:#166534;">Inteligencia Artificial (Google Gemini Vision - Múltiples Claves Gratuitas)</span>
              </div>
              <a href="https://aistudio.google.com/app/apikey" target="_blank" style="font-size:12px;color:#15803d;font-weight:bold;text-decoration:underline;">🔑 Crear Claves Gratis en Google AI Studio ↗</a>
            </div>
            <p style="font-size:13px;color:#374151;margin-bottom:8px;">
              Pega aquí 1 o más claves gratuitas de Google (separadas por coma o salto de línea). El bot <strong>rotará automáticamente</strong> a la siguiente clave si una se agota o satura:
            </p>
            <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-start;">
              <textarea id="geminiApiKeyInput" rows="2" placeholder="Pega tus Gemini API Keys (ej: Clave1, Clave2, Clave3...)" style="flex:1;min-width:260px;padding:9px 12px;border:1.5px solid #86efac;border-radius:8px;font-size:13px;font-family:monospace;background:white;resize:vertical;"></textarea>
              <button onclick="testGeminiKey()" style="padding:10px 18px;background:#15803d;color:white;border:none;border-radius:8px;font-weight:bold;font-size:13px;cursor:pointer;white-space:nowrap;">🧪 Probar Conexión</button>
            </div>
            <p id="geminiKeyStatus" style="font-size:12px;margin-top:6px;display:none;"></p>
          </div>

          <!-- Monitor de Seguimientos en Vivo -->
          <div id="followUpsMonitorBox" style="display:none;background:white;border:2px solid #8b5cf6;border-radius:12px;padding:16px;margin-bottom:20px;box-shadow:0 3px 12px rgba(139,92,246,0.15);">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
              <div style="display:flex;align-items:center;gap:8px;">
                <span style="font-size:18px;">📊</span>
                <span style="font-size:14px;font-weight:bold;color:#4c1d95;">Monitor de Seguimientos en Vivo (Programados)</span>
              </div>
              <button onclick="loadData()" style="padding:4px 10px;background:#f3e8ff;color:#7c3aed;border:1px solid #d8b4fe;border-radius:6px;font-size:12px;font-weight:bold;cursor:pointer;">🔄 Actualizar Estado</button>
            </div>
            <div id="followUpsMonitorList"></div>
          </div>
          <!-- Selector de Productos -->
          <div style="margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;">
            <div style="display:flex;align-items:center;gap:6px;">
              <span style="font-size:12px;font-weight:bold;color:var(--text-muted);text-transform:uppercase;">Selecciona el Producto a editar:</span>
              <span style="font-size:11px;color:#94a3b8;">(Desliza horizontalmente con la rueda del mouse o flechas ◀ ▶)</span>
            </div>
            <div style="display:flex;align-items:center;gap:6px;">
              <button class="nav-scroll-btn" onclick="scrollTabs(-220)" title="Desplazar pestañas a la izquierda">◀</button>
              <button class="nav-scroll-btn" onclick="scrollTabs(220)" title="Desplazar pestañas a la derecha">▶</button>
            </div>
          </div>
          <div class="product-tabs-container" id="productTabs"></div>

          <!-- Tarjeta de Configuración y Control del Producto -->
          <div id="aiProductCard" style="display:none;background:linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%);border:2px solid #3b82f6;border-radius:12px;padding:16px;margin-bottom:20px;box-shadow:0 3px 12px rgba(59,130,246,0.12);">
            <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;">
              <div style="display:flex;align-items:center;gap:10px;">
                <span id="aiProductIcon" style="font-size:26px;">🎁</span>
                <div>
                  <h3 id="aiProductTitle" style="margin:0;font-size:16px;color:#1e3a8a;font-weight:bold;">Control del Producto</h3>
                  <p style="margin:2px 0 0 0;font-size:12px;color:#475569;">Configuración general, encendido/apagado maestro y Asistente de IA.</p>
                </div>
              </div>

              <div style="display:inline-flex;align-items:center;gap:10px;flex-wrap:wrap;">
                <!-- Interruptor Maestro del Producto -->
                <label id="productMasterLabel" style="display:inline-flex;align-items:center;gap:8px;background:white;padding:8px 14px;border-radius:8px;border:2px solid #22c55e;cursor:pointer;font-weight:bold;font-size:13px;color:#15803d;box-shadow:0 1px 3px rgba(0,0,0,0.05);transition:all 0.2s;">
                  <input type="checkbox" id="productMasterCheckbox" onchange="toggleProductMasterEnabled(this.checked)" style="transform:scale(1.3);accent-color:#16a34a;" />
                  <span id="productMasterText">🟢 PRODUCTO ENCENDIDO</span>
                </label>

                <!-- Interruptor del Asistente de IA -->
                <label style="display:inline-flex;align-items:center;gap:8px;background:white;padding:8px 14px;border-radius:8px;border:1.5px solid #93c5fd;cursor:pointer;font-weight:bold;font-size:13px;color:#1e40af;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
                  <input type="checkbox" id="aiEnabledCheckbox" onchange="toggleAiProductEnabled(this.checked)" style="transform:scale(1.2);accent-color:#2563eb;" />
                  🧠 Asistente de IA
                </label>
              </div>
            </div>

            <!-- Aviso cuando el producto está apagado -->
            <div id="productDisabledBanner" style="display:none;margin-top:14px;background:#fef2f2;border:1.5px solid #f87171;color:#991b1b;padding:12px 14px;border-radius:8px;font-size:13px;font-weight:bold;display:flex;align-items:center;gap:8px;">
              <span style="font-size:18px;">🔴</span>
              <span><b>ESTE PRODUCTO ESTÁ APAGADO:</b> El bot ignorará por completo todas sus reglas, audios, fotos y su Asistente de IA. ¡No tienes que apagar regla por regla!</span>
            </div>

            <div id="aiPromptContainer" style="display:none;margin-top:14px;padding-top:12px;border-top:1px dashed #bfdbfe;">
              <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:8px;">
                <label style="font-size:12px;font-weight:bold;color:#1e3a8a;text-transform:uppercase;">
                  📝 Base de Datos e Instrucciones del Asistente (Prompt sin programar):
                </label>
                <div style="display:inline-flex;align-items:center;gap:6px;background:white;padding:5px 12px;border-radius:8px;border:1.5px solid #93c5fd;font-size:13px;color:#1e3a8a;font-weight:600;box-shadow:0 1px 3px rgba(0,0,0,0.04);">
                  <span>⏱️ Tiempo respondiendo:</span>
                  <input type="number" id="aiDelayInput" min="0" max="60" value="10" style="width:48px;padding:3px 6px;text-align:center;font-weight:bold;font-size:13px;border:1.5px solid #3b82f6;border-radius:6px;color:#1e3a8a;" />
                  <span>segundos</span>
                </div>
              </div>
              <textarea id="aiPromptInput" rows="8" placeholder="Escribe aquí las instrucciones en español. Ejemplo: Sos Sofía, asesora de ventas. El curso cuesta $4.900, incluye certificado. Respondé siempre en tono de 'vos', de forma concisa (máximo 2 párrafos). Si preguntan por los materiales deciles que se consiguen fácil. Si confirman que quieren comprar, pasales el alias..." style="width:100%;min-height:160px;box-sizing:border-box;padding:12px;border:1.5px solid #93c5fd;border-radius:8px;font-family:inherit;font-size:14px;line-height:1.5;resize:vertical !important;background:white;"></textarea>
              <div style="margin-top:8px;display:flex;align-items:center;gap:8px;font-size:12px;color:#1d4ed8;background:#dbeafe;padding:8px 12px;border-radius:6px;border:1px solid #bfdbfe;">
                <span>🎙️</span>
                <span><b>Comprensión de Audios de WhatsApp:</b> Si el cliente envía una nota de voz, la IA la escuchará con atención y le responderá por texto según estas instrucciones. ¡Totalmente gratis y sin programar!</span>
              </div>
            </div>
          </div>

          <div id="rulesContainer"></div>

          <button class="btn-new-rule" onclick="addNewRule()">
            ➕ AGREGAR NUEVA REGLA PARA ESTE PRODUCTO
          </button>
        </div>

        <div class="sticky-footer" id="footerBar" style="display:none;">
          <button class="btn-save-all" id="btnSave" onclick="saveAllChanges()">
            💾 GUARDAR TODOS LOS CAMBIOS
          </button>
        </div>

        <script>
          let rulesData = [];
          let productsData = [];
          let activeProductId = 'grafismo';
          let currentPass = localStorage.getItem('wa_bot_pass') || '';

          function showToast(msg, type = 'info', duration = 4000) {
            const t = document.getElementById('toastAlert');
            t.className = 'toast-' + type;
            t.innerText = msg;
            t.style.display = 'block';
            if (duration > 0) {
              setTimeout(() => { t.style.display = 'none'; }, duration);
            }
          }

          function checkAuth() {
            const val = document.getElementById('passInput').value;
            if (!val) { alert('Escribe la contraseña'); return; }
            currentPass = val;
            localStorage.setItem('wa_bot_pass', currentPass);
            loadData();
          }

          window.onload = function() {
            if (currentPass) {
              document.getElementById('passInput').value = currentPass;
              loadData();
            }
          };

          let liveFollowUps = {};
          let monitorInterval = null;

          function renderFollowUpsMonitor(fuData) {
            const box = document.getElementById('followUpsMonitorBox');
            const list = document.getElementById('followUpsMonitorList');
            if (!box || !list) return;
            if (!fuData || Object.keys(fuData).length === 0) {
              box.style.display = 'none';
              return;
            }
            const pendingEntries = Object.entries(fuData).filter(([k, fu]) => fu.status === 'pending');
            if (pendingEntries.length === 0) {
              box.style.display = 'none';
              return;
            }
            box.style.display = 'block';
            list.innerHTML = '';

            const now = Date.now();
            pendingEntries.forEach(([key, fu]) => {
              const diffSec = Math.max(0, Math.round((fu.scheduledTime - now) / 1000));
              const mins = Math.floor(diffSec / 60);
              const secs = diffSec % 60;
              const timeStr = mins > 0 ? (mins + ' min ' + secs + ' seg') : (secs + ' seg');

              const ruleObj = rulesData.find(r => r.id === fu.ruleId);
              const ruleName = ruleObj?.name || fu.ruleId;
              const stepNum = (fu.stepIndex !== undefined ? fu.stepIndex : 0) + 1;
              const phone = fu.remoteJid.replace('@s.whatsapp.net', '');
              const isRed = stepNum > 1;

              const item = document.createElement('div');
              item.style = 'display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;background:' + (isRed ? '#fef2f2' : '#faf5ff') + ';border:1px solid ' + (isRed ? '#fca5a5' : '#c084fc') + ';border-radius:8px;padding:10px 14px;margin-bottom:8px;font-size:13px;';
              item.innerHTML = \`
                <div>
                  <span style="font-weight:bold;color:#1e293b;">📱 Cliente: +\${phone}</span> &nbsp;|&nbsp;
                  <span style="color:\${isRed ? '#dc2626' : '#7c3aed'};font-weight:bold;">\${ruleName} (Seguimiento #\${stepNum})</span><br/>
                  <span style="color:#64748b;font-size:12px;">⏳ Envío automático en: <b style="color:#dc2626;font-size:13px;">\${timeStr}</b></span>
                </div>
                <div style="display:flex;gap:6px;">
                  <button onclick="triggerFollowUpNow('\${key}')" style="padding:6px 12px;background:#16a34a;color:white;border:none;border-radius:6px;font-weight:bold;font-size:12px;cursor:pointer;">🚀 Forzar Envío Ahora</button>
                </div>
              \`;
              list.appendChild(item);
            });
          }

          function triggerFollowUpNow(key) {
            if (confirm('¿Deseas forzar el envío de este seguimiento ahora mismo a WhatsApp?')) {
              fetch('/api/trigger-followup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key })
              })
              .then(r => r.json())
              .then(res => {
                showToast(res.message || 'Seguimiento adelantado', 'success');
                setTimeout(updateMonitorOnly, 1500);
              });
            }
          }

          // Solo actualiza el monitor de seguimientos pendientes en segundo plano SIN tocar los inputs ni las reglas
          function updateMonitorOnly() {
            fetch('/api/data')
              .then(r => r.json())
              .then(data => {
                liveFollowUps = data.followUps || {};
                renderFollowUpsMonitor(liveFollowUps);
              })
              .catch(() => {});
          }

          function loadData() {
            fetch('/api/data')
              .then(r => r.json())
              .then(data => {
                rulesData = data.rules || [];
                productsData = data.products || [];
                liveFollowUps = data.followUps || {};
                const savedProd = localStorage.getItem('lastActiveProductId');
                if (savedProd && productsData.some(p => p.id === savedProd)) {
                  activeProductId = savedProd;
                } else if (productsData.some(p => (p.name || '').toLowerCase().includes('cerrajer'))) {
                  activeProductId = productsData.find(p => (p.name || '').toLowerCase().includes('cerrajer')).id;
                } else if (productsData.length > 0) {
                  activeProductId = productsData[0].id;
                }
                localStorage.setItem('lastActiveProductId', activeProductId);
                document.getElementById('authModal').style.display = 'none';
                document.getElementById('mainPanel').style.display = 'block';
                document.getElementById('footerBar').style.display = 'flex';
                if (data.botConfig && data.botConfig.geminiApiKey) {
                  const keyEl = document.getElementById('geminiApiKeyInput');
                  if (keyEl && !keyEl.value) keyEl.value = data.botConfig.geminiApiKey;
                }
                renderProductTabs();
                renderRules();
                renderFollowUpsMonitor(liveFollowUps);

                if (!monitorInterval) {
                  // Solo refresca el monitor visual en vivo cada 4 segundos, NUNCA borra las reglas ni los inputs
                  monitorInterval = setInterval(updateMonitorOnly, 4000);
                }
              })
              .catch(err => {
                alert('Error al cargar datos: ' + err.message);
              });
          }

          function updateFollowUpDelay(rIdx, sIdx, field, val) {
            ensureRuleFollowUps(rIdx);
            if (!rulesData[rIdx].followUps[sIdx]) return;
            const num = Math.max(0, parseInt(val) || 0);
            if (field === 'hours') {
              rulesData[rIdx].followUps[sIdx].delayHours = num;
            } else if (field === 'mins') {
              rulesData[rIdx].followUps[sIdx].delayMinutes = num;
            }
            if (sIdx === 0) {
              rulesData[rIdx].followUp = rulesData[rIdx].followUps[0];
            }
          }

          function renderProductTabs() {
            const container = document.getElementById('productTabs');
            container.innerHTML = '';

            productsData.forEach((p, pIdx) => {
              const count = rulesData.filter(r => (r.productId || 'grafismo') === p.id).length;
              const isActive = p.id === activeProductId;
              const isProdEnabled = p.enabled !== false;

              const tabWrapper = document.createElement('div');
              tabWrapper.className = 'tab-group-item' + (isActive ? ' active' : '');
              tabWrapper.id = 'tab_item_' + p.id;
              if (!isProdEnabled) {
                tabWrapper.style.opacity = '0.7';
                tabWrapper.style.border = '1.5px dashed #f87171';
              }

              const tab = document.createElement('button');
              tab.className = 'product-tab' + (isActive ? ' active' : '');
              const statusBadge = isProdEnabled ? '' : ' <span style="font-size:11px;color:#ef4444;font-weight:bold;">🔴 [APAGADO]</span>';
              tab.innerHTML = (p.icon || '📦') + ' ' + p.name + ' (' + count + ')' + statusBadge;
              tab.onclick = () => {
                syncDOMToState();
                activeProductId = p.id;
                localStorage.setItem('lastActiveProductId', activeProductId);
                renderProductTabs();
                renderRules();
              };
              tabWrapper.appendChild(tab);

              // Botón rápido para duplicar esta pestaña como plantilla
              const dupTabBtn = document.createElement('button');
              dupTabBtn.className = 'tab-action-btn tab-dup-btn';
              dupTabBtn.innerHTML = '📋';
              dupTabBtn.title = 'Duplicar "' + p.name + '" con todas sus reglas y mensajes';
              dupTabBtn.onclick = (e) => {
                e.stopPropagation();
                duplicateProduct(p.id);
              };
              tabWrapper.appendChild(dupTabBtn);

              // Botón para eliminar cualquier producto (siempre que quede al menos uno)
              if (productsData.length > 1) {
                const delProdBtn = document.createElement('button');
                delProdBtn.className = 'tab-action-btn tab-del-btn';
                delProdBtn.innerHTML = '🗑️';
                delProdBtn.title = 'Eliminar producto "' + p.name + '" y sus ' + count + ' reglas';
                delProdBtn.onclick = (e) => {
                  e.stopPropagation();
                  deleteProduct(p.id);
                };
                tabWrapper.appendChild(delProdBtn);
              }

              container.appendChild(tabWrapper);
            });

            const btnRow = document.createElement('div');
            btnRow.style = 'display:inline-flex;gap:6px;align-items:center;flex-shrink:0;';

            const addBtn = document.createElement('button');
            addBtn.className = 'btn-add-product';
            addBtn.innerText = '➕ + Nuevo Producto';
            addBtn.onclick = () => {
              const name = prompt('Nombre del nuevo producto (ej: Curso de Labios):');
              if (name && name.trim()) {
                syncDOMToState();
                const id = 'prod_' + Date.now();
                productsData.push({ id, name: name.trim(), icon: '🎁', enabled: true, aiEnabled: false, aiDelaySeconds: 10, aiPrompt: '' });
                activeProductId = id;
                renderProductTabs();
                renderRules();
                showToast('✅ Producto "' + name.trim() + '" creado. Ya puedes agregarle reglas abajo.', 'success');
              }
            };
            btnRow.appendChild(addBtn);

            const dupActiveBtn = document.createElement('button');
            dupActiveBtn.style = 'padding:8px 14px;background:#f3e8ff;color:#7c3aed;border:1.5px dashed #c084fc;border-radius:10px;font-size:13px;font-weight:bold;cursor:pointer;display:inline-flex;align-items:center;gap:6px;flex-shrink:0;';
            dupActiveBtn.innerHTML = '📋 Duplicar Pestaña Actual';
            dupActiveBtn.title = 'Duplicar el producto actualmente seleccionado con todas sus reglas y mensajes';
            dupActiveBtn.onclick = () => {
              duplicateProduct(activeProductId);
            };
            btnRow.appendChild(dupActiveBtn);

            container.appendChild(btnRow);

            // Permitir deslizar horizontalmente con la rueda del mouse sin cerrar pestañas
            if (!container._wheelBound) {
              container._wheelBound = true;
              container.addEventListener('wheel', (e) => {
                if (e.deltaY !== 0) {
                  e.preventDefault();
                  container.scrollLeft += e.deltaY;
                }
              }, { passive: false });
            }

            // Mantener la pestaña activa siempre centrada en pantalla
            setTimeout(() => {
              const activeEl = document.getElementById('tab_item_' + activeProductId);
              if (activeEl) {
                activeEl.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
              }
            }, 60);

            renderAiProductCard();
          }

          function createCasillaObj(type) {
            let newObj = { type: type, delaySeconds: 2 };
            if (type === 'text') newObj.content = '';
            else if (type === 'image') { newObj.path = ''; newObj.caption = ''; }
            else if (type === 'video') { newObj.path = ''; newObj.caption = ''; }
            else if (type === 'document') { newObj.path = ''; newObj.fileName = ''; newObj.caption = ''; }
            else if (type === 'audio') { newObj.path = ''; newObj.ptt = true; }
            return newObj;
          }

          function renderCasillaHtml(resp, rIdx, cIdx, isFollowUp, stepIdx = 0) {
            const isRed = isFollowUp && stepIdx >= 1;
            const prefix = isFollowUp ? ('fuc_' + rIdx + '_' + stepIdx + '_' + cIdx) : ('c_' + rIdx + '_' + cIdx);
            const curDelay = resp.delaySeconds !== undefined ? resp.delaySeconds : 2;

            let badgeClass = 'badge-text';
            let typeName = '📝 TEXTO';
            if (resp.type === 'image') { badgeClass = 'badge-image'; typeName = '🖼️ FOTO'; }
            else if (resp.type === 'video') { badgeClass = 'badge-video'; typeName = '🎥 VIDEO'; }
            else if (resp.type === 'document') { badgeClass = 'badge-document'; typeName = '📄 PDF'; }
            else if (resp.type === 'audio') { badgeClass = 'badge-audio'; typeName = '🎙️ AUDIO'; }

            let followUpBadge = '';
            if (isFollowUp) {
              if (isRed) {
                followUpBadge = \`<span class="badge-followup-red">🔴 CASILLA DE SEGUIMIENTO #\${stepIdx + 1}</span>\`;
              } else {
                followUpBadge = '<span class="badge-followup-tag">🟣 CASILLA DE SEGUIMIENTO #1</span>';
              }
            }

            let casillaClass = 'casilla-item';
            if (isFollowUp) {
              casillaClass += isRed ? ' casilla-followup-red' : ' casilla-followup';
            }

            const moveFn = isFollowUp ? \`moveFollowUpCasilla(\${rIdx}, \${stepIdx}, \${cIdx}\` : \`moveCasilla(\${rIdx}, \${cIdx}\`;
            const delFn = isFollowUp ? \`deleteFollowUpCasilla(\${rIdx}, \${stepIdx}, \${cIdx})\` : \`deleteCasilla(\${rIdx}, \${cIdx})\`;

            let contentHtml = '';
            if (resp.type === 'text') {
              contentHtml = \`
                <textarea id="\${prefix}_content" class="casilla-textarea" placeholder="Escribe el mensaje aquí... Puedes usar *negrita* o emojis">\${resp.content || ''}</textarea>
              \`;
            } else if (resp.type === 'image') {
              const previewSrc = (resp.path && resp.path.startsWith('.')) ? resp.path.slice(1) : (resp.path || '');
              contentHtml = \`
                \${previewSrc ? \`<div class="media-preview-box"><img src="\${previewSrc}" alt="Foto actual" /></div>\` : ''}
                <div class="file-upload-row">
                  <label class="file-upload-label" for="\${prefix}_file">
                    📷 \${resp.path ? 'Cambiar Foto' : 'Subir Foto'}
                  </label>
                  <input type="file" id="\${prefix}_file" class="file-upload-input" accept="image/*" onchange="handleFileUpload(\${rIdx}, \${cIdx}, this, \${isFollowUp}, \${stepIdx})" />
                  <span id="\${prefix}_status" class="file-status-tag">\${resp.path ? '✓ Guardada' : ''}</span>
                </div>
                <div style="margin-top:8px;">
                  <input type="text" id="\${prefix}_caption" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px;" placeholder="Pie de foto opcional" value="\${resp.caption || ''}" />
                </div>
              \`;
            } else if (resp.type === 'video') {
              const previewSrc = (resp.path && resp.path.startsWith('.')) ? resp.path.slice(1) : (resp.path || '');
              contentHtml = \`
                \${previewSrc ? \`<div class="media-preview-box"><video src="\${previewSrc}" controls style="max-height:150px;"></video></div>\` : ''}
                <div class="file-upload-row">
                  <label class="file-upload-label" for="\${prefix}_file">
                    🎥 \${resp.path ? 'Cambiar Video' : 'Subir Video MP4'}
                  </label>
                  <input type="file" id="\${prefix}_file" class="file-upload-input" accept="video/mp4,video/*" onchange="handleFileUpload(\${rIdx}, \${cIdx}, this, \${isFollowUp}, \${stepIdx})" />
                  <span id="\${prefix}_status" class="file-status-tag">\${resp.path ? '✓ Guardado' : ''}</span>
                </div>
                <div style="margin-top:8px;">
                  <input type="text" id="\${prefix}_caption" style="width:100%;padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px;" placeholder="Pie de video opcional" value="\${resp.caption || ''}" />
                </div>
              \`;
            } else if (resp.type === 'document') {
              const fileHref = (resp.path && resp.path.startsWith('.')) ? resp.path.slice(1) : (resp.path || '');
              contentHtml = \`
                \${fileHref ? \`<div style="margin-bottom:8px;font-size:13px;">📄 Archivo: <a href="\${fileHref}" target="_blank" style="color:var(--wa-teal);font-weight:bold;">\${resp.fileName || 'Descargar PDF'}</a></div>\` : ''}
                <div class="file-upload-row">
                  <label class="file-upload-label" for="\${prefix}_file">
                    📄 \${resp.path ? 'Cambiar PDF' : 'Subir PDF'}
                  </label>
                  <input type="file" id="\${prefix}_file" class="file-upload-input" accept=".pdf,application/pdf" onchange="handleFileUpload(\${rIdx}, \${cIdx}, this, \${isFollowUp}, \${stepIdx})" />
                  <span id="\${prefix}_status" class="file-status-tag">\${resp.path ? '✓ Guardado' : ''}</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px;">
                  <input type="text" id="\${prefix}_fileName" style="padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px;" placeholder="Nombre visible (ej: Pack.pdf)" value="\${resp.fileName || ''}" />
                  <input type="text" id="\${prefix}_caption" style="padding:8px;border:1px solid var(--border);border-radius:6px;font-size:13px;" placeholder="Texto descriptivo opcional" value="\${resp.caption || ''}" />
                </div>
              \`;
            } else if (resp.type === 'audio') {
              const previewSrc = (resp.path && resp.path.startsWith('.')) ? resp.path.slice(1) : (resp.path || '');
              contentHtml = \`
                \${previewSrc ? \`<div class="media-preview-box"><audio src="\${previewSrc}" controls></audio></div>\` : ''}
                <div class="file-upload-row">
                  <label class="file-upload-label" for="\${prefix}_file">
                    🎙️ \${resp.path ? 'Cambiar Audio' : 'Subir Audio'}
                  </label>
                  <input type="file" id="\${prefix}_file" class="file-upload-input" accept="audio/*,.ogg,.mp3,.wav" onchange="handleFileUpload(\${rIdx}, \${cIdx}, this, \${isFollowUp}, \${stepIdx})" />
                  <span id="\${prefix}_status" class="file-status-tag">\${resp.path ? '✓ Guardado' : ''}</span>
                </div>
                <div style="margin-top:8px;">
                  <label style="font-size:13px;display:flex;align-items:center;gap:6px;cursor:pointer;">
                    <input type="checkbox" id="\${prefix}_ptt" \${resp.ptt !== false ? 'checked' : ''} />
                    <span>🎙️ Enviar como Nota de Voz humana (con ondas verdes)</span>
                  </label>
                </div>
              \`;
            }

            return \`
              <div class="\${casillaClass}">
                <div class="casilla-top">
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <span class="type-badge \${badgeClass}">\${typeName} (Paso #\${cIdx + 1})</span>
                    \${followUpBadge}
                  </div>
                  
                  <div class="casilla-controls">
                    <div class="delay-control" title="Tiempo de espera antes de enviar este mensaje">
                      <span>⏱️ Esperar:</span>
                      <input type="number" id="\${prefix}_delay" min="0" max="60" value="\${curDelay}" />
                      <span>seg.</span>
                    </div>
                    <button class="btn-ctrl" title="Subir orden" onclick="\${moveFn}, -1)">⬆️</button>
                    <button class="btn-ctrl" title="Bajar orden" onclick="\${moveFn}, 1)">⬇️</button>
                    <button class="btn-ctrl btn-ctrl-delete" title="Eliminar casilla" onclick="\${delFn}">🗑️</button>
                  </div>
                </div>
                \${contentHtml}
              </div>
            \`;
          }

          function syncDOMToState() {
            rulesData.forEach((rule, rIdx) => {
              const titleEl = document.getElementById('rule_title_' + rIdx);
              if (titleEl) rule.name = titleEl.value;

              const patEl = document.getElementById('rule_pat_' + rIdx);
              if (patEl) {
                rule.patterns = patEl.value.split(',').map(s => s.trim()).filter(Boolean);
              }

              // Sincronizar respuestas inmediatas
              if (Array.isArray(rule.responses)) {
                rule.responses.forEach((resp, cIdx) => {
                  const prefix = 'c_' + rIdx + '_' + cIdx;
                  const dInput = document.getElementById(prefix + '_delay');
                  if (dInput) resp.delaySeconds = Math.max(0, parseInt(dInput.value) || 0);

                  if (resp.type === 'text') {
                    const txt = document.getElementById(prefix + '_content');
                    if (txt) resp.content = txt.value;
                  } else if (resp.type === 'image' || resp.type === 'video') {
                    const cap = document.getElementById(prefix + '_caption');
                    if (cap) resp.caption = cap.value;
                  } else if (resp.type === 'document') {
                    const fn = document.getElementById(prefix + '_fileName');
                    if (fn) resp.fileName = fn.value;
                    const cap = document.getElementById(prefix + '_caption');
                    if (cap) resp.caption = cap.value;
                  } else if (resp.type === 'audio') {
                    const ptt = document.getElementById(prefix + '_ptt');
                    if (ptt) resp.ptt = ptt.checked;
                  }
                });
              }

              // Sincronizar seguimiento integrado (todos los pasos)
              if (!Array.isArray(rule.followUps)) {
                rule.followUps = rule.followUp ? [rule.followUp] : [{ enabled: false, delayHours: 3, delayMinutes: 0, cancelRuleIds: [], responses: [] }];
              }

              const fuCheck = document.getElementById('rule_fu_enabled_' + rIdx);
              if (fuCheck && rule.followUps[0]) {
                rule.followUps[0].enabled = fuCheck.checked;
              }

              rule.followUps.forEach((step, sIdx) => {
                step.stepIndex = sIdx;
                const stepCheck = document.getElementById('fu_step_enabled_' + rIdx + '_' + sIdx);
                if (stepCheck) step.enabled = stepCheck.checked;

                const hoursInput = document.getElementById('fu_delay_hours_' + rIdx + '_' + sIdx);
                const minsInput = document.getElementById('fu_delay_mins_' + rIdx + '_' + sIdx);
                if (hoursInput) step.delayHours = Math.max(0, parseInt(hoursInput.value) || 0);
                if (minsInput) step.delayMinutes = Math.max(0, parseInt(minsInput.value) || 0);

                if (Array.isArray(step.responses)) {
                  step.responses.forEach((resp, cIdx) => {
                    const prefix = 'fuc_' + rIdx + '_' + sIdx + '_' + cIdx;
                    const dInput = document.getElementById(prefix + '_delay');
                    if (dInput) resp.delaySeconds = Math.max(0, parseInt(dInput.value) || 0);

                    if (resp.type === 'text') {
                      const txt = document.getElementById(prefix + '_content');
                      if (txt) resp.content = txt.value;
                    } else if (resp.type === 'image' || resp.type === 'video') {
                      const cap = document.getElementById(prefix + '_caption');
                      if (cap) resp.caption = cap.value;
                    } else if (resp.type === 'document') {
                      const fn = document.getElementById(prefix + '_fileName');
                      if (fn) resp.fileName = fn.value;
                      const cap = document.getElementById(prefix + '_caption');
                      if (cap) resp.caption = cap.value;
                    } else if (resp.type === 'audio') {
                      const ptt = document.getElementById(prefix + '_ptt');
                      if (ptt) resp.ptt = ptt.checked;
                    }
                  });
                }
              });

              // Sincronizar Opciones Avanzadas (Anti-repetición y Encadenamiento)
              const onceCheck = document.getElementById('rule_only_once_' + rIdx);
              if (onceCheck) rule.onlyOnce = onceCheck.checked;

              const reqSelect = document.getElementById('rule_required_rule_' + rIdx);
              if (reqSelect) rule.requiredRuleId = reqSelect.value || null;

              const nextSelect = document.getElementById('rule_next_rule_' + rIdx);
              if (nextSelect) rule.nextRuleId = nextSelect.value || null;

              const nextDelay = document.getElementById('rule_next_delay_' + rIdx);
              if (nextDelay) rule.nextRuleDelaySeconds = Math.max(0, parseInt(nextDelay.value) || 0);

              // Sincronizar Verificación de Comprobante con IA
              if (!rule.receiptCheck) {
                rule.receiptCheck = { enabled: false, expectedAmount: 0, expectedHolder: '', expectedAlias: '', expectedCuil: '', maxAgeHours: 6, rejectMessage: '' };
              }
              const rcCheck = document.getElementById('rule_rc_enabled_' + rIdx);
              if (rcCheck) rule.receiptCheck.enabled = rcCheck.checked;

              const rcAmount = document.getElementById('rule_rc_amount_' + rIdx);
              if (rcAmount) rule.receiptCheck.expectedAmount = parseFloat(rcAmount.value) || 0;

              const rcHolder = document.getElementById('rule_rc_holder_' + rIdx);
              if (rcHolder) rule.receiptCheck.expectedHolder = rcHolder.value.trim();

              const rcAlias = document.getElementById('rule_rc_alias_' + rIdx);
              if (rcAlias) rule.receiptCheck.expectedAlias = rcAlias.value.trim();

              const rcCuil = document.getElementById('rule_rc_cuil_' + rIdx);
              if (rcCuil) rule.receiptCheck.expectedCuil = rcCuil.value.trim();

              const rcAge = document.getElementById('rule_rc_age_' + rIdx);
              if (rcAge) rule.receiptCheck.maxAgeHours = Math.max(1, parseInt(rcAge.value) || 6);

              const rcReject = document.getElementById('rule_rc_reject_' + rIdx);
              if (rcReject) rule.receiptCheck.rejectMessage = rcReject.value;

              rule.followUp = rule.followUps[0];
            });

            // Sincronizar estado maestro y Asistente de IA del producto activo
            const curProd = productsData.find(p => p.id === activeProductId);
            if (curProd) {
              const masterCheck = document.getElementById('productMasterCheckbox');
              if (masterCheck) curProd.enabled = masterCheck.checked;
              const aiCheck = document.getElementById('aiEnabledCheckbox');
              if (aiCheck) curProd.aiEnabled = aiCheck.checked;
              const aiDelay = document.getElementById('aiDelayInput');
              if (aiDelay) curProd.aiDelaySeconds = Math.max(0, parseInt(aiDelay.value) || 0);
              const aiInput = document.getElementById('aiPromptInput');
              if (aiInput) curProd.aiPrompt = aiInput.value;
            }
          }

          function renderAiProductCard() {
            const card = document.getElementById('aiProductCard');
            if (!card) return;
            const curProd = productsData.find(p => p.id === activeProductId);
            if (!curProd) {
              card.style.display = 'none';
              return;
            }
            card.style.display = 'block';
            const titleEl = document.getElementById('aiProductTitle');
            if (titleEl) {
              titleEl.innerText = (curProd.icon || '🎁') + ' Control: ' + curProd.name;
            }

            // Interruptor Maestro del Producto (Encendido / Apagado total)
            const isProdEnabled = curProd.enabled !== false;
            const masterCheck = document.getElementById('productMasterCheckbox');
            const masterText = document.getElementById('productMasterText');
            const masterLabel = document.getElementById('productMasterLabel');
            const disabledBanner = document.getElementById('productDisabledBanner');

            if (masterCheck) masterCheck.checked = isProdEnabled;
            if (masterText) masterText.innerText = isProdEnabled ? '🟢 PRODUCTO ENCENDIDO' : '🔴 PRODUCTO APAGADO';
            if (masterLabel) {
              masterLabel.style.borderColor = isProdEnabled ? '#22c55e' : '#ef4444';
              masterLabel.style.color = isProdEnabled ? '#15803d' : '#b91c1c';
              masterLabel.style.background = isProdEnabled ? '#ffffff' : '#fef2f2';
            }
            if (disabledBanner) disabledBanner.style.display = isProdEnabled ? 'none' : 'flex';

            // Asistente de IA
            const aiCheck = document.getElementById('aiEnabledCheckbox');
            const aiContainer = document.getElementById('aiPromptContainer');
            const aiInput = document.getElementById('aiPromptInput');
            const aiDelay = document.getElementById('aiDelayInput');

            const isAiEnabled = Boolean(curProd.aiEnabled);
            if (aiCheck) aiCheck.checked = isAiEnabled;
            if (aiContainer) aiContainer.style.display = isAiEnabled ? 'block' : 'none';
            if (aiDelay) aiDelay.value = curProd.aiDelaySeconds !== undefined ? curProd.aiDelaySeconds : 10;
            if (aiInput) aiInput.value = curProd.aiPrompt || '';
          }

          function toggleProductMasterEnabled(isChecked) {
            syncDOMToState();
            const curProd = productsData.find(p => p.id === activeProductId);
            if (curProd) {
              curProd.enabled = isChecked;
            }
            renderProductTabs();
            renderAiProductCard();
            renderRules();
            showToast(isChecked ? '🟢 Producto encendido. Reglas y Asistente activos.' : '🔴 Producto apagado por completo. Reglas y Asistente pausados.', isChecked ? 'success' : 'info');
          }

          function toggleAiProductEnabled(isChecked) {
            syncDOMToState();
            const curProd = productsData.find(p => p.id === activeProductId);
            if (curProd) {
              curProd.aiEnabled = isChecked;
            }
            const aiContainer = document.getElementById('aiPromptContainer');
            if (aiContainer) aiContainer.style.display = isChecked ? 'block' : 'none';
          }

          function toggleRuleReceiptCheck(rIdx, isChecked) {
            syncDOMToState();
            if (!rulesData[rIdx].receiptCheck) rulesData[rIdx].receiptCheck = {};
            rulesData[rIdx].receiptCheck.enabled = isChecked;
            renderRules();
          }

          function toggleRuleEnabled(rIdx) {
            syncDOMToState();
            rulesData[rIdx].enabled = rulesData[rIdx].enabled === false ? true : false;
            renderRules();
          }

          function ensureRuleFollowUps(rIdx) {
            if (!Array.isArray(rulesData[rIdx].followUps)) {
              rulesData[rIdx].followUps = rulesData[rIdx].followUp ? [rulesData[rIdx].followUp] : [];
            }
            if (rulesData[rIdx].followUps.length === 0) {
              rulesData[rIdx].followUps.push({
                stepIndex: 0,
                enabled: false,
                delayHours: 3,
                delayMinutes: 0,
                cancelRuleIds: [],
                responses: []
              });
            }
            rulesData[rIdx].followUp = rulesData[rIdx].followUps[0];
          }

          function toggleRuleFollowUp(rIdx, isChecked) {
            syncDOMToState();
            ensureRuleFollowUps(rIdx);
            rulesData[rIdx].followUps[0].enabled = isChecked;
            rulesData[rIdx].followUp = rulesData[rIdx].followUps[0];
            renderRules();
          }

          function toggleStepEnabled(rIdx, sIdx, isChecked) {
            syncDOMToState();
            ensureRuleFollowUps(rIdx);
            if (rulesData[rIdx].followUps[sIdx]) {
              rulesData[rIdx].followUps[sIdx].enabled = isChecked;
            }
            renderRules();
          }

          function toggleCancelRuleId(rIdx, cancelId, sIdx = 0) {
            syncDOMToState();
            ensureRuleFollowUps(rIdx);
            if (!rulesData[rIdx].followUps[sIdx]) return;
            if (!Array.isArray(rulesData[rIdx].followUps[sIdx].cancelRuleIds)) {
              rulesData[rIdx].followUps[sIdx].cancelRuleIds = [];
            }
            const arr = rulesData[rIdx].followUps[sIdx].cancelRuleIds;
            const pos = arr.indexOf(cancelId);
            if (pos >= 0) arr.splice(pos, 1);
            else arr.push(cancelId);
            renderRules();
          }

          function addFollowUpStep(rIdx) {
            syncDOMToState();
            ensureRuleFollowUps(rIdx);
            const defaultCancels = rulesData[rIdx].followUps[0]?.cancelRuleIds || [];
            const newStepIdx = rulesData[rIdx].followUps.length;
            rulesData[rIdx].followUps.push({
              stepIndex: newStepIdx,
              enabled: true,
              delayHours: 24,
              delayMinutes: 0,
              cancelRuleIds: [...defaultCancels],
              responses: []
            });
            renderRules();
          }

          function deleteFollowUpStep(rIdx, sIdx) {
            if (confirm('¿Eliminar el Seguimiento #' + (sIdx + 1) + ' y todas sus casillas?')) {
              syncDOMToState();
              rulesData[rIdx].followUps.splice(sIdx, 1);
              rulesData[rIdx].followUps.forEach((st, idx) => st.stepIndex = idx);
              rulesData[rIdx].followUp = rulesData[rIdx].followUps[0] || null;
              renderRules();
            }
          }

          function renderRules() {
            const container = document.getElementById('rulesContainer');
            container.innerHTML = '';

            const activeRulesIndices = [];
            rulesData.forEach((r, idx) => {
              if ((r.productId || 'grafismo') === activeProductId) {
                activeRulesIndices.push(idx);
              }
            });

            const curProd = productsData.find(p => p.id === activeProductId);
            const bannerDiv = document.createElement('div');
            bannerDiv.innerHTML = '<div style="font-size:11px;font-weight:700;color:#047857;text-transform:uppercase;letter-spacing:0.5px;">ESTÁS EDITANDO EL PRODUCTO:</div>' +
              '<div style="font-size:20px;font-weight:800;color:#065f46;display:flex;align-items:center;gap:8px;margin-top:2px;">' +
              '<span>' + (curProd && curProd.icon ? curProd.icon : '📦') + '</span> <span>' + (curProd && curProd.name ? curProd.name : 'Producto') + '</span>' +
              '<span style="font-size:11px;background:#10b981;color:white;padding:3px 10px;border-radius:12px;font-weight:700;">' + activeRulesIndices.length + ' reglas configuradas</span>' +
              '</div>' +
              '<div style="font-size:12px;color:#047857;background:white;padding:6px 12px;border-radius:8px;border:1px solid #a7f3d0;font-weight:600;margin-top:8px;">' +
              '💡 Para ver o editar otro producto, pulsa su pestaña en la barra superior 👆' +
              '</div>';
            container.appendChild(bannerDiv);

            if (activeRulesIndices.length === 0) {
              const emptyDiv = document.createElement('div');
              emptyDiv.innerHTML = '<div style="background:white;padding:30px;border-radius:12px;text-align:center;color:var(--text-muted);margin-bottom:20px;">No hay reglas para este producto todavía. Haz clic abajo para crear tu primera regla.</div>';
              container.appendChild(emptyDiv);
              return;
            }

            activeRulesIndices.forEach((rIdx) => {
              const rule = rulesData[rIdx];
              const isEnabled = rule.enabled !== false;
              ensureRuleFollowUps(rIdx);
              const steps = rule.followUps;
              const isFuEnabled = Boolean(steps[0] && steps[0].enabled);

              const card = document.createElement('div');
              card.className = 'rule-card ' + (isEnabled ? 'enabled' : 'disabled');

              const patternStr = Array.isArray(rule.patterns) ? rule.patterns.join(', ') : '';
              const rc = rule.receiptCheck || { enabled: false, expectedAmount: 0, expectedHolder: '', expectedAlias: '', expectedCuil: '', maxAgeHours: 6, rejectMessage: '' };
              const isRcEnabled = Boolean(rc.enabled);

              // Renderizar casillas inmediatas
              let immediateCasillasHtml = '';
              if (Array.isArray(rule.responses)) {
                rule.responses.forEach((resp, cIdx) => {
                  immediateCasillasHtml += renderCasillaHtml(resp, rIdx, cIdx, false);
                });
              }

              // Checkboxes de reglas para cancelar
              const siblingRules = rulesData.filter((r, idx) => (r.productId || 'grafismo') === activeProductId && idx !== rIdx);

              // Renderizar seguimiento
              let followUpsHtml = '';
              if (isFuEnabled) {
                // Paso 0: Violeta
                const step0 = steps[0];
                let step0CasillasHtml = '';
                if (Array.isArray(step0.responses)) {
                  step0.responses.forEach((resp, cIdx) => {
                    step0CasillasHtml += renderCasillaHtml(resp, rIdx, cIdx, true, 0);
                  });
                }

                const currentCancels0 = step0.cancelRuleIds || [];
                let cancelCheckboxesHtml0 = '';
                siblingRules.forEach(sr => {
                  const isChecked = currentCancels0.includes(sr.id) ? 'checked' : '';
                  cancelCheckboxesHtml0 += \`
                    <label style="display:inline-flex;align-items:center;gap:4px;background:white;padding:5px 9px;border-radius:6px;border:1px solid #c084fc;font-size:12px;cursor:pointer;color:#4c1d95;">
                      <input type="checkbox" \${isChecked} onchange="toggleCancelRuleId(\${rIdx}, '\${sr.id}', 0)" style="accent-color:#7c3aed;" />
                      <b>\${sr.name || sr.id}</b>
                    </label>
                  \`;
                });

                let step0Html = \`
                  <div style="background:white;border:1.5px solid #d8b4fe;border-radius:10px;padding:14px;margin-bottom:14px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
                      <span style="font-size:13px;font-weight:bold;color:#6b21a8;">🟣 SEGUIMIENTO #1 (INICIAL):</span>
                    </div>
                    <div class="followup-row" style="margin-bottom:12px;">
                      <label style="font-weight:bold;color:#4c1d95;">⏱️ Enviar tras esperar:</label>
                      <div style="display:inline-flex;align-items:center;gap:6px;">
                        <input type="number" id="fu_delay_hours_\${rIdx}_0" min="0" max="168" value="\${step0.delayHours !== undefined ? step0.delayHours : 3}" oninput="updateFollowUpDelay(\${rIdx}, 0, 'hours', this.value)" style="width:55px;text-align:center;font-weight:bold;padding:5px;border:1px solid #c084fc;border-radius:6px;" />
                        <label>horas y</label>
                        <input type="number" id="fu_delay_mins_\${rIdx}_0" min="0" max="59" value="\${step0.delayMinutes !== undefined ? step0.delayMinutes : 0}" oninput="updateFollowUpDelay(\${rIdx}, 0, 'mins', this.value)" style="width:55px;text-align:center;font-weight:bold;padding:5px;border:1px solid #c084fc;border-radius:6px;" />
                        <label>minutos</label>
                        <span style="font-size:11px;color:#7c3aed;font-weight:bold;">(ej: 0 hs y 5 min para probar)</span>
                      </div>
                    </div>

                    <div>
                      <label style="display:block;font-size:12px;font-weight:bold;margin-bottom:6px;color:#4c1d95;">🚫 CANCELAR si el cliente activa:</label>
                      <div style="display:flex;gap:6px;flex-wrap:wrap;">
                        \${cancelCheckboxesHtml0 || '<span style="font-size:12px;color:#64748b;">(No hay otras reglas para cancelar)</span>'}
                      </div>
                    </div>
                  </div>

                  <div style="margin-bottom:8px;">
                    <span style="font-size:12px;font-weight:bold;text-transform:uppercase;color:#7c3aed;letter-spacing:0.5px;">
                      🟣 Mensajes y Archivos del Seguimiento #1:
                    </span>
                  </div>

                  <div class="followup-casillas-list">
                    \${step0CasillasHtml || '<div style="background:white;padding:12px;border-radius:8px;border:1px dashed #d8b4fe;text-align:center;color:#6b21a8;font-size:13px;font-style:italic;margin-bottom:10px;">No has agregado casillas al Seguimiento #1. Agrega una abajo 👇</div>'}
                  </div>

                  <div style="background:#ffffff;border:1.5px dashed #a855f7;border-radius:10px;padding:12px;text-align:center;margin-bottom:18px;">
                    <span style="font-size:12px;font-weight:bold;color:#6b21a8;display:block;margin-bottom:6px;">+ AGREGAR CASILLA AL SEGUIMIENTO #1 (VIOLETA 🟣):</span>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;">
                      <button class="btn-add-type b-aud" onclick="addFollowUpCasilla(\${rIdx}, 'audio', 0)">➕ 🎙️ Audio #1</button>
                      <button class="btn-add-type b-pdf" onclick="addFollowUpCasilla(\${rIdx}, 'document', 0)">➕ 📄 PDF #1</button>
                      <button class="btn-add-type b-vid" onclick="addFollowUpCasilla(\${rIdx}, 'video', 0)">➕ 🎥 Video #1</button>
                      <button class="btn-add-type b-img" onclick="addFollowUpCasilla(\${rIdx}, 'image', 0)">➕ 🖼️ Foto #1</button>
                      <button class="btn-add-type b-txt" onclick="addFollowUpCasilla(\${rIdx}, 'text', 0)">➕ 📝 Texto #1</button>
                    </div>
                  </div>
                \`;

                // Pasos adicionales (1..N): ROJOS 🔴
                let additionalStepsHtml = '';
                for (let sIdx = 1; sIdx < steps.length; sIdx++) {
                  const step = steps[sIdx];
                  const stepNum = sIdx + 1;
                  const isStepEnabled = step.enabled !== false;

                  let stepCasillasHtml = '';
                  if (Array.isArray(step.responses)) {
                    step.responses.forEach((resp, cIdx) => {
                      stepCasillasHtml += renderCasillaHtml(resp, rIdx, cIdx, true, sIdx);
                    });
                  }

                  const currentCancels = step.cancelRuleIds || [];
                  let cancelCheckboxesHtml = '';
                  siblingRules.forEach(sr => {
                    const isChecked = currentCancels.includes(sr.id) ? 'checked' : '';
                    cancelCheckboxesHtml += \`
                      <label style="display:inline-flex;align-items:center;gap:4px;background:white;padding:5px 9px;border-radius:6px;border:1px solid #fca5a5;font-size:12px;cursor:pointer;color:#991b1b;">
                        <input type="checkbox" \${isChecked} onchange="toggleCancelRuleId(\${rIdx}, '\${sr.id}', \${sIdx})" style="accent-color:#dc2626;" />
                        <b>\${sr.name || sr.id}</b>
                      </label>
                    \`;
                  });

                  additionalStepsHtml += \`
                    <div class="followup-card-section followup-red" style="margin-top:16px;">
                      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:12px;">
                        <label style="font-size:14px;font-weight:bold;color:#b91c1c;display:flex;align-items:center;gap:8px;cursor:pointer;">
                          <input type="checkbox" id="fu_step_enabled_\${rIdx}_\${sIdx}" \${isStepEnabled ? 'checked' : ''} onchange="toggleStepEnabled(\${rIdx}, \${sIdx}, this.checked)" style="transform:scale(1.2);accent-color:#dc2626;" />
                          <span>🔴 SEGUIMIENTO #\${stepNum} (SEGUIMIENTO ADICIONAL)</span>
                        </label>
                        <button class="btn-del-fu-step" onclick="deleteFollowUpStep(\${rIdx}, \${sIdx})">🗑️ Eliminar Seguimiento #\${stepNum}</button>
                      </div>

                      <div style="background:white;border:1.5px solid #fca5a5;border-radius:10px;padding:14px;margin-bottom:14px;">
                        <div class="followup-row" style="margin-bottom:12px;">
                          <label style="font-weight:bold;color:#991b1b;">⏱️ Enviar tras esperar:</label>
                          <div style="display:inline-flex;align-items:center;gap:6px;">
                            <input type="number" id="fu_delay_hours_\${rIdx}_\${sIdx}" min="0" max="168" value="\${step.delayHours !== undefined ? step.delayHours : 24}" oninput="updateFollowUpDelay(\${rIdx}, \${sIdx}, 'hours', this.value)" style="width:55px;text-align:center;font-weight:bold;padding:5px;border:1px solid #f87171;border-radius:6px;" />
                            <label>horas y</label>
                            <input type="number" id="fu_delay_mins_\${rIdx}_\${sIdx}" min="0" max="59" value="\${step.delayMinutes !== undefined ? step.delayMinutes : 0}" oninput="updateFollowUpDelay(\${rIdx}, \${sIdx}, 'mins', this.value)" style="width:55px;text-align:center;font-weight:bold;padding:5px;border:1px solid #f87171;border-radius:6px;" />
                            <label>minutos</label>
                            <span style="font-size:11px;color:#dc2626;font-weight:bold;">(después del seguimiento #\${stepNum - 1})</span>
                          </div>
                        </div>

                        <div>
                          <label style="display:block;font-size:12px;font-weight:bold;margin-bottom:6px;color:#991b1b;">🚫 CANCELAR si el cliente activa:</label>
                          <div style="display:flex;gap:6px;flex-wrap:wrap;">
                            \${cancelCheckboxesHtml || '<span style="font-size:12px;color:#64748b;">(No hay otras reglas para cancelar)</span>'}
                          </div>
                        </div>
                      </div>

                      <div style="margin-bottom:8px;">
                        <span style="font-size:12px;font-weight:bold;text-transform:uppercase;color:#dc2626;letter-spacing:0.5px;">
                          🔴 Mensajes y Archivos del Seguimiento #\${stepNum}:
                        </span>
                      </div>

                      <div class="followup-casillas-list">
                        \${stepCasillasHtml || \`<div style="background:white;padding:12px;border-radius:8px;border:1px dashed #fca5a5;text-align:center;color:#b91c1c;font-size:13px;font-style:italic;margin-bottom:10px;">No has agregado casillas al Seguimiento #\${stepNum}. Agrega una abajo 👇</div>\`}
                      </div>

                      <div style="background:#ffffff;border:1.5px dashed #ef4444;border-radius:10px;padding:12px;text-align:center;">
                        <span style="font-size:12px;font-weight:bold;color:#b91c1c;display:block;margin-bottom:6px;">+ AGREGAR CASILLA AL SEGUIMIENTO #\${stepNum} (ROJO 🔴):</span>
                        <div style="display:flex;gap:6px;flex-wrap:wrap;justify-content:center;">
                          <button class="btn-add-type b-red-aud" onclick="addFollowUpCasilla(\${rIdx}, 'audio', \${sIdx})">➕ 🎙️ Audio #\${stepNum}</button>
                          <button class="btn-add-type b-red-pdf" onclick="addFollowUpCasilla(\${rIdx}, 'document', \${sIdx})">➕ 📄 PDF #\${stepNum}</button>
                          <button class="btn-add-type b-red-vid" onclick="addFollowUpCasilla(\${rIdx}, 'video', \${sIdx})">➕ 🎥 Video #\${stepNum}</button>
                          <button class="btn-add-type b-red-img" onclick="addFollowUpCasilla(\${rIdx}, 'image', \${sIdx})">➕ 🖼️ Foto #\${stepNum}</button>
                          <button class="btn-add-type b-red-txt" onclick="addFollowUpCasilla(\${rIdx}, 'text', \${sIdx})">➕ 📝 Texto #\${stepNum}</button>
                        </div>
                      </div>
                    </div>
                  \`;
                }

                followUpsHtml = \`
                  \${step0Html}
                  \${additionalStepsHtml}
                  <button class="btn-add-fu-red" onclick="addFollowUpStep(\${rIdx})">
                    🔴 + AGREGAR OTRO SEGUIMIENTO (SEGUIMIENTO ADICIONAL #\${steps.length + 1})
                  </button>
                \`;
              } else {
                followUpsHtml = \`
                  <p style="font-size:12px;color:#6b21a8;margin:0;">
                    💡 Marca la casilla de arriba si deseas que el bot envíe automáticamente recordatorios (audio, PDF, video, foto o texto) si el cliente no avanza tras recibir esta regla.
                  </p>
                \`;
              }

              const productOptionsHtml = productsData.map(p => 
                '<option value="' + p.id + '" ' + ((rule.productId || 'grafismo') === p.id ? 'selected' : '') + '>' + (p.icon || '📦') + ' ' + p.name + '</option>'
              ).join('');

              card.innerHTML = \`
                <div class="rule-header">
                  <div class="rule-header-left">
                    <button class="switch-btn \${isEnabled ? 'switch-on' : 'switch-off'}" onclick="toggleRuleEnabled(\${rIdx})">
                      \${isEnabled ? '🟢 Activa' : '🔴 Pausada'}
                    </button>
                    <span style="background:#e0f2fe;color:#0369a1;font-size:10px;font-weight:800;padding:3px 7px;border-radius:6px;letter-spacing:0.3px;">⚡ REGLA</span>
                    <input type="text" class="rule-title-input" id="rule_title_\${rIdx}" value="\${rule.name || ('Regla #' + (rIdx + 1))}" placeholder="Nombre de esta Regla" />
                  </div>
                  <div style="display:flex;align-items:center;gap:8px;">
                    <div style="display:flex;align-items:center;gap:4px;" title="Producto al que pertenece esta regla">
                      <span style="font-size:11px;color:#64748b;font-weight:bold;">Producto:</span>
                      <select style="padding:4px 8px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;background:#f8fafc;color:#1e293b;font-weight:bold;cursor:pointer;" onchange="changeRuleProduct(\${rIdx}, this.value)">
                        \${productOptionsHtml}
                      </select>
                    </div>
                    <button class="btn-delete-rule" onclick="deleteRule(\${rIdx})">🗑️ Borrar</button>
                  </div>
                </div>

                <div class="rule-body">
                  <!-- 1. Palabras Clave Disparadoras -->
                  <div class="form-group">
                    <label>🔍 Palabras Clave Disparadoras (separadas por coma):</label>
                    <input type="text" id="rule_pat_\${rIdx}" value="\${patternStr}" placeholder="ej: comprar, alias, precio, info" />
                    <p class="help-text">Cuando el cliente escriba un mensaje con alguna de estas palabras, el bot activará de inmediato las respuestas de abajo.</p>
                  </div>

                  <!-- ⚙️ Control de Flujo: Anti-repetición y Encadenamiento de Regla -->
                  <div style="background:#f8fafc;border:1.5px solid #cbd5e1;border-radius:12px;padding:14px;margin-bottom:18px;">
                    <div style="font-size:12px;font-weight:bold;color:#1e293b;margin-bottom:10px;display:flex;align-items:center;gap:6px;">
                      <span>⚙️ CONTROL DE FLUJO: ANTI-REPETICIÓN Y ENCADENAMIENTO AUTOMÁTICO</span>
                    </div>

                    <div style="display:flex;flex-direction:column;gap:12px;">
                      <!-- Anti-repetición -->
                      <div>
                        <label style="display:flex;align-items:center;gap:8px;font-size:13px;font-weight:bold;color:#0f172a;cursor:pointer;">
                          <input type="checkbox" id="rule_only_once_\${rIdx}" \${rule.onlyOnce ? 'checked' : ''} style="transform:scale(1.2);accent-color:#0284c7;" />
                          <span>🛡️ Disparar solo 1 vez por cliente</span>
                        </label>
                        <p style="font-size:11px;color:#64748b;margin:3px 0 0 26px;">Si el cliente ya recibió esta regla y vuelve a escribir palabras clave ("QUIERO", "info", etc.), el bot no repetirá los mensajes; el Asistente IA responderá naturalmente sus dudas.</p>
                      </div>

                      <!-- Requisito previo -->
                      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid #e2e8f0;padding-top:8px;">
                        <label style="font-size:12px;font-weight:bold;color:#334155;">🔒 Requisito previo:</label>
                        <select id="rule_required_rule_\${rIdx}" style="padding:5px 9px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;background:white;font-weight:600;color:#1e293b;">
                          <option value="">-- Ninguno (se puede activar libremente) --</option>
                          \${siblingRules.map(sr => '<option value="' + sr.id + '" ' + (rule.requiredRuleId === sr.id ? 'selected' : '') + '>' + (sr.name || sr.id) + '</option>').join('')}
                        </select>
                        <span style="font-size:11px;color:#64748b;">(Solo se activa si el cliente ya recibió antes la regla elegida)</span>
                      </div>

                      <!-- Encadenamiento automático -->
                      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;border-top:1px solid #e2e8f0;padding-top:8px;">
                        <label style="font-size:12px;font-weight:bold;color:#334155;">🔗 Al terminar esta regla, activar automáticamente:</label>
                        <select id="rule_next_rule_\${rIdx}" style="padding:5px 9px;border:1px solid #cbd5e1;border-radius:6px;font-size:12px;background:white;font-weight:600;color:#1e293b;">
                          <option value="">-- Ninguna regla adicional --</option>
                          \${siblingRules.map(sr => '<option value="' + sr.id + '" ' + (rule.nextRuleId === sr.id ? 'selected' : '') + '>' + (sr.name || sr.id) + '</option>').join('')}
                        </select>
                        <label style="font-size:12px;font-weight:bold;color:#334155;">tras esperar:</label>
                        <input type="number" id="rule_next_delay_\${rIdx}" min="0" max="3600" value="\${rule.nextRuleDelaySeconds !== undefined ? rule.nextRuleDelaySeconds : 2}" style="width:55px;padding:4px;text-align:center;font-weight:bold;border:1px solid #cbd5e1;border-radius:6px;" />
                        <span style="font-size:12px;color:#334155;">segundos.</span>
                      </div>
                    </div>
                  </div>

                  <!-- 🧾 Sección: Verificación de Comprobante de Pago con IA (Gemini Vision) -->
                  <div class="receipt-card-section" style="margin-bottom:18px;border:2px solid \${isRcEnabled ? '#10b981' : '#cbd5e1'};background:\${isRcEnabled ? '#ecfdf5' : '#f8fafc'};border-radius:12px;padding:14px;transition:all 0.2s;">
                    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:\${isRcEnabled ? '12px' : '0'};">
                      <label style="font-size:13px;font-weight:bold;color:\${isRcEnabled ? '#065f46' : '#475569'};display:flex;align-items:center;gap:8px;cursor:pointer;">
                        <input type="checkbox" id="rule_rc_enabled_\${rIdx}" \${isRcEnabled ? 'checked' : ''} onchange="toggleRuleReceiptCheck(\${rIdx}, this.checked)" style="transform:scale(1.2);accent-color:#10b981;" />
                        <span>🧾 Requiere Verificación de Comprobante de Pago (IA Vision)</span>
                      </label>
                      <span style="background:\${isRcEnabled ? '#10b981' : '#94a3b8'};color:white;font-size:10px;font-weight:800;padding:3px 8px;border-radius:6px;letter-spacing:0.3px;">
                        \${isRcEnabled ? '🛡️ ANTIFRAUDE ACTIVO' : 'OPCIONAL'}
                      </span>
                    </div>

                    \${isRcEnabled ? \`
                    <div style="display:grid;grid-template-columns:repeat(auto-fit, minmax(200px, 1fr));gap:10px;margin-bottom:10px;">
                      <div>
                        <label style="display:block;font-size:11px;font-weight:bold;color:#065f46;margin-bottom:4px;">💵 Monto a verificar ($):</label>
                        <input type="number" id="rule_rc_amount_\${rIdx}" value="\${rc.expectedAmount || ''}" placeholder="ej: 4900 o 2500" style="width:100%;padding:7px 10px;border:1px solid #6ee7b7;border-radius:6px;font-size:13px;font-weight:bold;background:white;" />
                        <span style="font-size:10px;color:#047857;">Monto exacto esperado en el comprobante</span>
                      </div>
                      <div>
                        <label style="display:block;font-size:11px;font-weight:bold;color:#065f46;margin-bottom:4px;">👤 Nombre del Titular esperado:</label>
                        <input type="text" id="rule_rc_holder_\${rIdx}" value="\${rc.expectedHolder || ''}" placeholder="ej: Marissa Balderrama" style="width:100%;padding:7px 10px;border:1px solid #6ee7b7;border-radius:6px;font-size:13px;background:white;" />
                        <span style="font-size:10px;color:#047857;">Verifica que el dinero ingresó a este nombre</span>
                      </div>
                      <div>
                        <label style="display:block;font-size:11px;font-weight:bold;color:#065f46;margin-bottom:4px;">🏦 Alias o CBU esperado:</label>
                        <input type="text" id="rule_rc_alias_\${rIdx}" value="\${rc.expectedAlias || ''}" placeholder="ej: Ruta.Crecimiento" style="width:100%;padding:7px 10px;border:1px solid #6ee7b7;border-radius:6px;font-size:13px;background:white;" />
                        <span style="font-size:10px;color:#047857;">Opcional (se compara si figura en la captura)</span>
                      </div>
                      <div>
                        <label style="display:block;font-size:11px;font-weight:bold;color:#065f46;margin-bottom:4px;">🆔 CUIT / CUIL esperado (11 dígitos):</label>
                        <input type="text" id="rule_rc_cuil_\${rIdx}" value="\${rc.expectedCuil || ''}" placeholder="ej: 27431234567" style="width:100%;padding:7px 10px;border:1px solid #6ee7b7;border-radius:6px;font-size:13px;font-weight:bold;background:white;" />
                        <span style="font-size:10px;color:#047857;">Verifica los 11 dígitos del receptor en el ticket</span>
                      </div>
                      <div>
                        <label style="display:block;font-size:11px;font-weight:bold;color:#065f46;margin-bottom:4px;">⏱️ Antigüedad máxima (horas):</label>
                        <input type="number" id="rule_rc_age_\${rIdx}" min="1" max="168" value="\${rc.maxAgeHours !== undefined ? rc.maxAgeHours : 6}" style="width:100%;padding:7px 10px;border:1px solid #6ee7b7;border-radius:6px;font-size:13px;font-weight:bold;background:white;" />
                        <span style="font-size:10px;color:#047857;">Por defecto 6 horas (antifraude)</span>
                      </div>
                    </div>
                    <div>
                      <label style="display:block;font-size:11px;font-weight:bold;color:#065f46;margin-bottom:4px;">⚠️ Mensaje en caso de rechazo o datos inválidos:</label>
                      <textarea id="rule_rc_reject_\${rIdx}" rows="3" placeholder="ej: Hola! Recibimos tu comprobante pero no pudimos verificar los datos o el monto. Por favor revisá y volvé a enviarlo de forma clara." style="width:100%;min-height:75px;padding:8px 10px;border:1px solid #6ee7b7;border-radius:6px;font-size:12px;background:white;resize:vertical;">\${rc.rejectMessage || ''}</textarea>
                      <span style="font-size:10px;color:#047857;">Se le envía automáticamente si la foto no coincide o fue emitida hace más de las horas permitidas.</span>
                    </div>
                    \` : \`
                    <p style="font-size:11px;color:#64748b;margin-top:4px;margin-bottom:0;">Tilda esta casilla si esta regla es una entrega (producto principal o segundo producto/upsell) y querés que la IA lea la captura antes de mandar los archivos.</p>
                    \`}
                  </div>

                  <!-- 2. Respuestas Inmediatas -->
                  <div class="casillas-title">
                    <span>⚡ 1. Mensajes y Archivos Inmediatos (se envían al instante en este orden):</span>
                  </div>

                  <div class="casillas-list">
                    \${immediateCasillasHtml || '<p style="color:var(--text-muted);font-size:13px;font-style:italic;">No hay casillas inmediatas creadas aún.</p>'}
                  </div>

                  <div class="add-casilla-box">
                    <span class="add-casilla-label">+ AGREGAR CASILLA INMEDIATA:</span>
                    <div class="add-buttons-row">
                      <button class="btn-add-type b-txt" onclick="addCasilla(\${rIdx}, 'text')">➕ 📝 Texto</button>
                      <button class="btn-add-type b-img" onclick="addCasilla(\${rIdx}, 'image')">➕ 🖼️ Foto</button>
                      <button class="btn-add-type b-vid" onclick="addCasilla(\${rIdx}, 'video')">➕ 🎥 Video</button>
                      <button class="btn-add-type b-pdf" onclick="addCasilla(\${rIdx}, 'document')">➕ 📄 PDF</button>
                      <button class="btn-add-type b-aud" onclick="addCasilla(\${rIdx}, 'audio')">➕ 🎙️ Audio</button>
                    </div>
                  </div>

                  <!-- 3. Sección de Seguimiento Automático Integrado (VIOLETA 🟣 y ROJO 🔴) -->
                  <div class="followup-card-section" style="margin-top:24px;border:2px solid #c084fc;background:#faf5ff;border-radius:12px;padding:16px;">
                    <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:8px;margin-bottom:10px;">
                      <label style="font-size:14px;font-weight:bold;color:#6b21a8;display:flex;align-items:center;gap:8px;cursor:pointer;">
                        <input type="checkbox" id="rule_fu_enabled_\${rIdx}" \${isFuEnabled ? 'checked' : ''} onchange="toggleRuleFollowUp(\${rIdx}, this.checked)" style="transform:scale(1.2);accent-color:#7c3aed;" />
                        <span>⏰ Activar Seguimiento Automático para esta Regla (si el cliente no avanza)</span>
                      </label>
                      <span class="badge-followup-tag">🟣 SEGUIMIENTOS AUTOMÁTICOS</span>
                    </div>

                    \${followUpsHtml}
                  </div>
                </div>
              \`;
              container.appendChild(card);
            });
          }

          function addCasilla(rIdx, type) {
            syncDOMToState();
            if (!Array.isArray(rulesData[rIdx].responses)) rulesData[rIdx].responses = [];
            rulesData[rIdx].responses.push(createCasillaObj(type));
            renderRules();
          }

          function addFollowUpCasilla(rIdx, type, sIdx = 0) {
            syncDOMToState();
            ensureRuleFollowUps(rIdx);
            if (!rulesData[rIdx].followUps[sIdx]) {
              rulesData[rIdx].followUps[sIdx] = {
                stepIndex: sIdx,
                enabled: true,
                delayHours: sIdx === 0 ? 3 : 24,
                delayMinutes: 0,
                cancelRuleIds: [],
                responses: []
              };
            }
            if (!Array.isArray(rulesData[rIdx].followUps[sIdx].responses)) {
              rulesData[rIdx].followUps[sIdx].responses = [];
            }
            rulesData[rIdx].followUps[sIdx].responses.push(createCasillaObj(type));
            renderRules();
          }

          function moveCasilla(rIdx, cIdx, direction) {
            syncDOMToState();
            const list = rulesData[rIdx].responses;
            const targetIdx = cIdx + direction;
            if (targetIdx < 0 || targetIdx >= list.length) return;
            const temp = list[cIdx];
            list[cIdx] = list[targetIdx];
            list[targetIdx] = temp;
            renderRules();
          }

          function moveFollowUpCasilla(rIdx, sIdx, cIdx, direction) {
            syncDOMToState();
            const list = rulesData[rIdx].followUps?.[sIdx]?.responses;
            if (!list) return;
            const targetIdx = cIdx + direction;
            if (targetIdx < 0 || targetIdx >= list.length) return;
            const temp = list[cIdx];
            list[cIdx] = list[targetIdx];
            list[targetIdx] = temp;
            renderRules();
          }

          function deleteCasilla(rIdx, cIdx) {
            if (confirm('¿Eliminar esta casilla?')) {
              syncDOMToState();
              rulesData[rIdx].responses.splice(cIdx, 1);
              renderRules();
            }
          }

          function deleteFollowUpCasilla(rIdx, sIdx, cIdx) {
            if (confirm('¿Eliminar esta casilla de seguimiento?')) {
              syncDOMToState();
              rulesData[rIdx].followUps?.[sIdx]?.responses.splice(cIdx, 1);
              renderRules();
            }
          }

          function handleFileUpload(rIdx, cIdx, input, isFollowUp = false, sIdx = 0) {
            const file = input.files[0];
            if (!file) return;

            const sizeMb = (file.size / (1024 * 1024)).toFixed(1);
            if (file.size > 100 * 1024 * 1024) {
              alert(\`El archivo pesa \${sizeMb} MB. WhatsApp solo permite enviar archivos de hasta 100 MB. Por favor comprímelo.\`);
              input.value = '';
              return;
            }
            if (file.size > 16 * 1024 * 1024) {
              if (!confirm(\`El video pesa \${sizeMb} MB. Como supera los 16 MB, el bot lo enviará automáticamente como archivo descargable MP4 para que WhatsApp no lo rechace (soporta hasta 100 MB). ¿Deseas subirlo?\`)) {
                input.value = '';
                return;
              }
            }

            const prefix = isFollowUp ? ('fuc_' + rIdx + '_' + sIdx + '_' + cIdx) : ('c_' + rIdx + '_' + cIdx);
            const statusEl = document.getElementById(prefix + '_status');
            if (statusEl) statusEl.innerText = '⏳ Subiendo...';

            showToast(\`⏳ Subiendo \${file.name} (\${sizeMb} MB)... por favor espera.\`, 'info', 0);

            const xhr = new XMLHttpRequest();
            xhr.open('POST', '/api/upload', true);
            xhr.setRequestHeader('x-password', currentPass);
            xhr.setRequestHeader('x-filename', encodeURIComponent(file.name));

            xhr.upload.onprogress = function(e) {
              if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                showToast(\`⏳ Subiendo \${file.name}: \${pct}%...\`, 'info', 0);
                if (statusEl) statusEl.innerText = \`⏳ \${pct}%\`;
              }
            };

            xhr.onload = function() {
              if (xhr.status === 200) {
                try {
                  const res = JSON.parse(xhr.responseText);
                  if (res.success) {
                    syncDOMToState();
                    const targetList = isFollowUp ? rulesData[rIdx].followUps[sIdx].responses : rulesData[rIdx].responses;
                    targetList[cIdx].path = res.path;
                    if (targetList[cIdx].type === 'document' && !targetList[cIdx].fileName) {
                      targetList[cIdx].fileName = res.fileName || file.name;
                    }
                    renderRules();
                    showToast(\`✅ ¡\${file.name} subido con éxito! Recuerda pulsar GUARDAR TODOS LOS CAMBIOS abajo.\`, 'success', 5000);
                  } else {
                    showToast('❌ Error: ' + (res.error || 'No se pudo subir'), 'error', 6000);
                    if (statusEl) statusEl.innerText = '❌ Error';
                  }
                } catch (e) {
                  showToast('❌ Error procesando respuesta del servidor', 'error', 6000);
                  if (statusEl) statusEl.innerText = '❌ Error';
                }
              } else {
                showToast('❌ Error del servidor al subir (' + xhr.status + ')', 'error', 6000);
                if (statusEl) statusEl.innerText = '❌ Error';
              }
            };

            xhr.onerror = function() {
              showToast('❌ Error de conexión al subir el archivo', 'error', 6000);
              if (statusEl) statusEl.innerText = '❌ Error';
            };

            xhr.send(file);
          }

          function testGeminiKey() {
            const key = (document.getElementById('geminiApiKeyInput')?.value || '').trim();
            if (!key) {
              alert('Ingresa una o más API Keys para probar.');
              return;
            }
            const statusEl = document.getElementById('geminiKeyStatus');
            statusEl.style.display = 'block';
            statusEl.style.color = '#0369a1';
            statusEl.innerText = 'Probando conexión y modelos de Google Gemini...';

            fetch('/api/test-gemini', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ apiKey: key })
            })
            .then(r => r.json())
            .then(res => {
              if (res.success) {
                statusEl.style.color = '#15803d';
                statusEl.innerText = '✅ ' + (res.message || '¡Conexión con Google Gemini exitosa!');
              } else {
                statusEl.style.color = '#dc2626';
                statusEl.innerText = '⚠️ ' + (res.message || res.error || 'Error al validar las claves');
              }
            })
            .catch(err => {
              statusEl.style.color = '#dc2626';
              statusEl.innerText = '❌ Error de red: ' + err.message;
            });
          }

          function saveAllChanges() {
            syncDOMToState();
            const btn = document.getElementById('btnSave');
            btn.disabled = true;
            btn.innerText = '⏳ Guardando cambios...';
            showToast('Guardando configuración...', 'info', 0);

            const apiKeyVal = (document.getElementById('geminiApiKeyInput')?.value || '').trim();

            fetch('/api/save', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                password: currentPass,
                rules: rulesData,
                products: productsData,
                config: {
                  geminiApiKey: apiKeyVal
                }
              })
            })
            .then(r => r.json())
            .then(res => {
              btn.disabled = false;
              btn.innerText = '💾 GUARDAR TODOS LOS CAMBIOS';
              if (res.success) {
                showToast('✅ ¡Todos los cambios se guardaron con éxito!', 'success', 5000);
                loadData();
              } else {
                showToast('❌ Error: ' + (res.error || 'No se pudo guardar'), 'error', 6000);
              }
            })
            .catch(err => {
              btn.disabled = false;
              btn.innerText = '💾 GUARDAR TODOS LOS CAMBIOS';
              showToast('❌ Error de conexión: ' + err.message, 'error', 6000);
            });
          }

          function changeRuleProduct(rIdx, newProdId) {
            syncDOMToState();
            if (rulesData[rIdx]) {
              rulesData[rIdx].productId = newProdId;
              renderProductTabs();
              renderRules();
              showToast('Regla asignada al nuevo producto. Recuerda pulsar GUARDAR.', 'info');
            }
          }

          function addNewRule() {
            syncDOMToState();
            const newId = 'rule_' + Date.now();
            rulesData.push({
              id: newId,
              name: 'Nueva Regla',
              productId: activeProductId || (productsData[0]?.id || 'grafismo'),
              enabled: true,
              onlyOnce: false,
              requiredRuleId: null,
              nextRuleId: null,
              nextRuleDelaySeconds: 2,
              patterns: [],
              receiptCheck: {
                enabled: false,
                expectedAmount: 0,
                expectedHolder: '',
                expectedAlias: '',
                expectedCuil: '',
                maxAgeHours: 6,
                rejectMessage: ''
              },
              responses: [
                { type: 'text', delaySeconds: 2, content: '' }
              ],
              followUps: [{
                stepIndex: 0,
                enabled: false,
                delayHours: 3,
                delayMinutes: 0,
                cancelRuleIds: [],
                responses: []
              }]
            });
            renderProductTabs();
            renderRules();
            showToast('✅ Regla creada para este producto. Recuerda pulsar GUARDAR abajo.', 'success');
          }

          function deleteRule(rIdx) {
            const rule = rulesData[rIdx];
            const name = rule ? (rule.name || ('Regla #' + (rIdx + 1))) : 'esta regla';
            if (confirm('¿Seguro que deseas eliminar "' + name + '"?')) {
              syncDOMToState();
              rulesData.splice(rIdx, 1);
              renderProductTabs();
              renderRules();
              showToast('🗑️ Regla eliminada. Recuerda pulsar GUARDAR abajo.', 'info');
            }
          }

          function duplicateProduct(sourceProductId) {
            syncDOMToState();
            const sourceProduct = productsData.find(p => p.id === sourceProductId);
            if (!sourceProduct) return;

            const defaultName = sourceProduct.name + ' (Copia)';
            const newName = prompt('Nombre para el nuevo producto duplicado basado en "' + sourceProduct.name + '":', defaultName);
            if (!newName || !newName.trim()) return;

            const newProductId = 'prod_' + Date.now();
            const newProduct = {
              id: newProductId,
              name: newName.trim(),
              icon: sourceProduct.icon || '🎁',
              enabled: sourceProduct.enabled !== false,
              aiEnabled: Boolean(sourceProduct.aiEnabled),
              aiDelaySeconds: sourceProduct.aiDelaySeconds !== undefined ? sourceProduct.aiDelaySeconds : 10,
              aiPrompt: sourceProduct.aiPrompt || ''
            };
            productsData.push(newProduct);

            // Reglas que pertenecen al producto original
            const sourceRules = rulesData.filter(r => (r.productId || 'grafismo') === sourceProductId);

            // Mapeo de IDs viejos a nuevos para mantener relaciones de cancelación independientes
            const idMap = {};
            sourceRules.forEach((r, idx) => {
              idMap[r.id] = 'rule_' + Date.now() + '_' + idx;
            });

            // Clonar cada regla
            sourceRules.forEach(r => {
              const cloned = JSON.parse(JSON.stringify(r));
              cloned.id = idMap[r.id] || ('rule_' + Date.now() + '_' + Math.random().toString(36).substring(2, 6));
              cloned.productId = newProductId;

              if (cloned.requiredRuleId && idMap[cloned.requiredRuleId]) {
                cloned.requiredRuleId = idMap[cloned.requiredRuleId];
              }
              if (cloned.nextRuleId && idMap[cloned.nextRuleId]) {
                cloned.nextRuleId = idMap[cloned.nextRuleId];
              }

              // Actualizar cancelRuleIds en los seguimientos para que apunten a las nuevas reglas clonadas
              if (Array.isArray(cloned.followUps)) {
                cloned.followUps.forEach(fu => {
                  if (Array.isArray(fu.cancelRuleIds)) {
                    fu.cancelRuleIds = fu.cancelRuleIds.map(oldId => idMap[oldId] || oldId);
                  }
                });
                cloned.followUp = cloned.followUps[0] || null;
              } else if (cloned.followUp && Array.isArray(cloned.followUp.cancelRuleIds)) {
                cloned.followUp.cancelRuleIds = cloned.followUp.cancelRuleIds.map(oldId => idMap[oldId] || oldId);
              }

              rulesData.push(cloned);
            });

            activeProductId = newProductId;
            renderProductTabs();
            renderRules();
            showToast('✅ ¡Producto "' + newProduct.name + '" creado con éxito (' + sourceRules.length + ' reglas duplicadas)! Recuerda pulsar GUARDAR TODOS LOS CAMBIOS abajo.', 'success', 6000);
          }

          function deleteProduct(productId) {
            syncDOMToState();
            if (productsData.length <= 1) {
              alert('Debes tener al menos un producto en el sistema.');
              return;
            }
            const p = productsData.find(prod => prod.id === productId);
            if (!p) return;
            const count = rulesData.filter(r => (r.productId || 'grafismo') === p.id).length;
            const msg = '¿Estás seguro de que deseas eliminar permanentemente el producto "' + p.name + '"' + (count > 0 ? (' junto con sus ' + count + ' regla(s)?') : '?');
            if (confirm(msg)) {
              productsData = productsData.filter(prod => prod.id !== productId);
              rulesData = rulesData.filter(r => (r.productId || 'grafismo') !== productId);
              if (activeProductId === productId) {
                activeProductId = productsData[0].id;
              }
              renderProductTabs();
              renderRules();
              showToast('🗑️ Producto "' + p.name + '" eliminado. Recuerda pulsar GUARDAR TODOS LOS CAMBIOS abajo.', 'info', 5000);
            }
          }

          function scrollTabs(offset) {
            const container = document.getElementById('productTabs');
            if (container) {
              container.scrollBy({ left: offset, behavior: 'smooth' });
            }
          }
        </script>
      </body>
      </html>
    `);
  }

  // Endpoint para resetear la sesión de WhatsApp y forzar un nuevo código QR
  if (req.url === "/api/reset-session" || req.url === "/api/restart-qr" || req.url === "/api/logout") {
    console.log("[BOT] Solicitando nuevo código QR y reseteando sesión de WhatsApp...");
    try {
      if (currentSocket) {
        try { currentSocket.end(); } catch (e) {}
      }
      if (fs.existsSync("auth_info_baileys")) {
        fs.rmSync("auth_info_baileys", { recursive: true, force: true });
      }
      isConnected = false;
      currentQR = null;
      setTimeout(() => startBot(), 1500);
      res.writeHead(302, { Location: "/api/qr" });
      res.end();
      return;
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Error reseteando sesión: " + e.message);
      return;
    }
  }

  // Página principal con estado de conexión o QR
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  if (isConnected) {
    res.end(`
      <!DOCTYPE html>
      <html lang="es">
      <head><title>Bot Conectado</title><style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f0f2f5;}</style></head>
      <body>
        <div style="background:white;max-width:520px;margin:auto;padding:35px;border-radius:14px;box-shadow:0 4px 15px rgba(0,0,0,0.1);">
          <h1 style="color:#25D366;font-size:32px;">¡Bot Conectado con Éxito! ✅</h1>
          <p style="font-size:16px;color:#475569;margin:15px 0;">Tu WhatsApp ya está vinculado y respondiendo en segundo plano 24/7.</p>
          <div style="margin-top:20px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
            <a href="/admin" style="display:inline-block;padding:12px 20px;background:#128C7E;color:white;text-decoration:none;border-radius:8px;font-weight:bold;font-size:15px;">Ir al Panel de Control ⚙️</a>
            <a href="/api/reset-session" style="display:inline-block;padding:12px 20px;background:#64748b;color:white;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">🔄 Desconectar y Cambiar Número</a>
          </div>
        </div>
      </body>
      </html>
    `);
  } else if (currentQR) {
    try {
      const qrDataUrl = await QRCode.toDataURL(currentQR, { width: 320 });
      res.end(`
        <!DOCTYPE html>
        <html lang="es">
        <head>
          <title>Escanea tu QR de WhatsApp</title>
          <meta http-equiv="refresh" content="5">
          <style>body{font-family:sans-serif;text-align:center;padding:30px;background:#f0f2f5;}</style>
        </head>
        <body>
          <div style="background:white;max-width:500px;margin:auto;padding:30px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
            <h2 style="color:#075E54;font-size:24px;">Escanea este código QR con WhatsApp</h2>
            <img src="${qrDataUrl}" style="border:4px solid #25D366;border-radius:8px;margin:15px auto;display:block;" width="320" height="320" alt="Código QR"/>
            <p style="color:#64748b;font-size:14px;margin-top:10px;">Abre WhatsApp en tu teléfono > Dispositivos vinculados > Vincular un dispositivo</p>
            <div style="margin-top:20px;">
              <a href="/api/reset-session" style="display:inline-block;padding:10px 18px;background:#e11d48;color:white;text-decoration:none;border-radius:8px;font-weight:bold;font-size:13px;">🔄 Generar Nuevo Código QR</a>
            </div>
          </div>
        </body>
        </html>
      `);
    } catch (e) {
      res.end(`<h3>Error generando QR: ${e.message}</h3>`);
    }
  } else {
    res.end(`
      <!DOCTYPE html>
      <html lang="es">
      <head>
        <title>Iniciando WhatsApp...</title>
        <meta http-equiv="refresh" content="3">
        <style>body{font-family:sans-serif;text-align:center;padding:50px;background:#f0f2f5;}</style>
      </head>
      <body>
        <div style="background:white;max-width:480px;margin:auto;padding:35px;border-radius:12px;box-shadow:0 4px 12px rgba(0,0,0,0.1);">
          <h2 style="color:#075E54;margin-bottom:12px;">⏳ Conectando con WhatsApp...</h2>
          <p style="color:#64748b;font-size:14px;line-height:1.5;">El bot se está iniciando en la nube. Esta pantalla se actualizará automáticamente en unos segundos.</p>
          <div style="margin-top:25px;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
            <a href="/api/reset-session" style="display:inline-block;padding:12px 20px;background:#e11d48;color:white;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">🔄 Forzar Generación de Nuevo QR</a>
            <a href="/admin" style="display:inline-block;padding:12px 20px;background:#128C7E;color:white;text-decoration:none;border-radius:8px;font-weight:bold;font-size:14px;">Ir al Panel de Control ⚙️</a>
          </div>
        </div>
      </body>
      </html>
    `);
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`[BOT] Servidor activo en puerto ${PORT}`);
  try {
    const uploadsDir = path.join(__dirname, "uploads");
    if (fs.existsSync(uploadsDir)) {
      const files = fs.readdirSync(uploadsDir);
      for (const f of files) {
        const ext = path.extname(f).toLowerCase();
        if (ext === ".wav" || ext === ".mp3") {
          convertToOpusOgg(path.join(uploadsDir, f));
        }
      }
    }
  } catch (e) {
    console.warn("[BOT AUDIO] Pre-conversión en arranque:", e.message);
  }
});

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("auth_info_baileys");
  const { version, isLatest } = await fetchLatestBaileysVersion();
  console.log(`[BOT] Iniciando Baileys v${version.join(".")} (Última: ${isLatest})`);

  const sock = makeWASocket({
    version,
    logger: pino({ level: "silent" }),
    auth: state,
    printQRInTerminal: false,
    syncFullHistory: false,
    getMessage: async (key) => {
      const stored = messageStore.get(key?.id);
      return stored?.message || undefined;
    }
  });
  currentSocket = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      currentQR = qr;
      isConnected = false;
      console.log("\n[BOT] Nuevo código QR disponible");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "close") {
      isConnected = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[BOT] Conexión cerrada. Motivo: ${statusCode}. ¿Reconectar?: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(() => startBot(), 2500);
      } else {
        console.log("[BOT] Sesión cerrada definitivamente por WhatsApp (logged out). Limpiando credenciales y generando nuevo QR...");
        try {
          if (fs.existsSync("auth_info_baileys")) {
            fs.rmSync("auth_info_baileys", { recursive: true, force: true });
          }
        } catch (e) {}
        currentQR = null;
        setTimeout(() => startBot(), 1500);
      }
    } else if (connection === "open") {
      isConnected = true;
      currentQR = null;
      console.log("\n*******************************************************");
      console.log("  BOT CONECTADO CON ÉXITO A WHATSAPP Y LISTO PARA RESPONDER!");
      console.log("*******************************************************\n");
    }
  });

  sock.ev.on("messages.upsert", async (m) => {
    try {
      if (!m || !Array.isArray(m.messages)) return;
      for (const msg of m.messages) {
        if (!msg || !msg.message) continue;

        const remoteJid = msg.key.remoteJid;
        const remoteJidAlt = msg.key.remoteJidAlt;
        const msgId = msg.key.id;

        // Guardar mensaje en store para soportar peticiones de reintento/descifrado de WhatsApp
        if (msgId) {
          messageStore.set(msgId, msg);
          if (messageStore.size > 150) {
            const firstK = messageStore.keys().next().value;
            messageStore.delete(firstK);
          }
        }

        // Mapear LID <-> Teléfono (@s.whatsapp.net) si viene en el mensaje
        if (remoteJid && remoteJid.endsWith("@lid") && remoteJidAlt && remoteJidAlt.endsWith("@s.whatsapp.net")) {
          lidToPnMap.set(remoteJid, remoteJidAlt);
          pnToLidMap.set(remoteJidAlt, remoteJid);
        }

        if (msg.key.fromMe) {
          console.log(`[BOT] Mensaje de la propia cuenta (fromMe=true) ignorado para evitar bucles. Si estás probando, escribe desde OTRO número de WhatsApp. (De: ${remoteJid})`);
          continue;
        }

        if (!remoteJid || remoteJid.includes("@g.us") || remoteJid.includes("@broadcast") || remoteJid === "status@broadcast") continue;
        if (processedMessages.has(msgId)) continue;
        processedMessages.add(msgId);
        if (processedMessages.size > 500) {
          const firstItem = processedMessages.values().next().value;
          processedMessages.delete(firstItem);
        }

        // Evitar procesar mensajes viejos de sincronización histórica (más de 15 min de antigüedad)
        const msgTimestampSec = msg.messageTimestamp ? Number(msg.messageTimestamp) : 0;
        const nowSec = Math.floor(Date.now() / 1000);
        if (msgTimestampSec > 0 && !isNaN(msgTimestampSec) && (nowSec - msgTimestampSec) > 900) {
          console.log(`[BOT] Mensaje antiguo ignorado (${nowSec - msgTimestampSec}s de antigüedad)`);
          continue;
        }

        const { text: rawText, hasImage, hasAudio, audioMime, mediaMime } = extractMessage(msg);
        const norm = normalizeText(rawText);
        const cleanIncoming = cleanForMatch(rawText);

        console.log(`[MENSAJE] De: ${remoteJid}${remoteJidAlt ? ` (Alt: ${remoteJidAlt})` : ""} | Texto: "${rawText}" | ¿Foto?: ${hasImage} | ¿Audio?: ${hasAudio}`);

        // 1. Identificación de contexto del cliente
        if (!userState[remoteJid]) userState[remoteJid] = {};
        if (!Array.isArray(userState[remoteJid].triggeredRules)) {
          userState[remoteJid].triggeredRules = [];
        }

        // Tracking de Origen / Anuncio de Facebook Ads:
        if (!userState[remoteJid].firstSeenAt) {
          userState[remoteJid].firstSeenAt = Date.now();
        }
        if (!userState[remoteJid].firstMessage && rawText && rawText.trim()) {
          const trimmedMsg = rawText.trim().substring(0, 150);
          userState[remoteJid].firstMessage = trimmedMsg;
          
          // Extraer tag si viene entre corchetes ej: [V1], [PROMO], #AD1
          const tagMatch = trimmedMsg.match(/(\[[a-zA-Z0-9_\-\. ]+\]|#[a-zA-Z0-9_\-]+)/);
          if (tagMatch) {
            userState[remoteJid].adTag = tagMatch[1];
          }
          saveUserState();
        }
        if (remoteJidAlt) {
          if (!userState[remoteJidAlt]) userState[remoteJidAlt] = {};
          if (!userState[remoteJidAlt].firstSeenAt) userState[remoteJidAlt].firstSeenAt = userState[remoteJid].firstSeenAt;
          if (!userState[remoteJidAlt].firstMessage && userState[remoteJid].firstMessage) {
            userState[remoteJidAlt].firstMessage = userState[remoteJid].firstMessage;
            userState[remoteJidAlt].adTag = userState[remoteJid].adTag;
            saveUserState();
          }
        }

        let clientProduct = userState[remoteJid].activeProduct || null;
        const triggered = userState[remoteJid].triggeredRules;

        // Si el cliente envía un mensaje de anuncio (patrón largo >= 12 caracteres), identificar o cambiar el producto activo
        let matchedAdRule = null;
        for (const rule of rules) {
          if (rule.enabled === false || rule.isFollowUp || !rule.patterns) continue;
          const ruleProd = products.find((p) => p.id === (rule.productId || "grafismo"));
          if (ruleProd && ruleProd.enabled === false) continue;

          for (const pat of rule.patterns) {
            if (pat.length < 12) continue; // Solo patrones largos de anuncio
            const np = normalizeText(pat);
            const cp = cleanForMatch(pat);
            if ((np && norm.includes(np)) || (cp && cleanIncoming.includes(cp))) {
              matchedAdRule = rule;
              break;
            }
          }
          if (matchedAdRule) break;
        }

        if (matchedAdRule) {
          const newProdId = matchedAdRule.productId || "grafismo";
          clientProduct = newProdId;
          userState[remoteJid].activeProduct = newProdId;
          saveUserState();
          console.log(`[BOT] Detección de anuncio: Producto "${newProdId}" asignado a ${remoteJid} por regla "${matchedAdRule.name}"`);
        }

        // Si el cliente aún no tiene producto asignado y menciona el nombre o id de un producto activo
        if (!clientProduct && rawText) {
          const lowerText = rawText.toLowerCase();
          for (const p of products) {
            if (p.enabled === false) continue;
            const words = (p.name + " " + p.id).toLowerCase().split(/[\s_]+/);
            if (words.some(w => w.length > 3 && lowerText.includes(w))) {
              clientProduct = p.id;
              userState[remoteJid].activeProduct = p.id;
              saveUserState();
              break;
            }
          }
        }

        let matchedRule = null;

        // Evaluar primero la regla de anuncio detectada (si no fue bloqueada por onlyOnce)
        if (matchedAdRule) {
          let skipAd = false;
          if (matchedAdRule.requiredRuleId && !triggered.includes(matchedAdRule.requiredRuleId)) {
            skipAd = true;
          }
          if (matchedAdRule.onlyOnce && triggered.includes(matchedAdRule.id)) {
            console.log(`[BOT] Regla de anuncio "${matchedAdRule.name}" ya recibida por ${remoteJid}. Se omite para que responda la IA.`);
            skipAd = true;
          }
          if (!skipAd) {
            matchedRule = matchedAdRule;
          }
        }

        // Si no hubo regla de anuncio o fue omitida, buscar entre las reglas activas
        if (!matchedRule) {
          for (const rule of rules) {
            if (rule.enabled === false) continue;
            if (rule.isFollowUp) continue;
            if (!rule.patterns || rule.patterns.length === 0) continue;

            const ruleProdId = rule.productId || "grafismo";
            const ruleProd = products.find((p) => p.id === ruleProdId);
            if (ruleProd && ruleProd.enabled === false) continue;

            // Aislamiento estricto de producto: si el cliente ya tiene producto activo, SOLO evaluar reglas de ese producto
            if (clientProduct && ruleProdId !== clientProduct) continue;

            // Requisito previo: solo permitir si el cliente ya recibió antes la regla requerida
            if (rule.requiredRuleId && !triggered.includes(rule.requiredRuleId)) {
              continue;
            }

            // Anti-repetición: si está marcado para disparar solo 1 vez por cliente y ya se disparó
            if (rule.onlyOnce && triggered.includes(rule.id)) {
              continue;
            }

            for (const pattern of rule.patterns) {
              const normPattern = normalizeText(pattern);
              const cleanPattern = cleanForMatch(pattern);

              if (
                (normPattern && norm.includes(normPattern)) ||
                (cleanPattern && cleanIncoming.includes(cleanPattern))
              ) {
                matchedRule = rule;
                break;
              }
            }
            if (matchedRule) break;
          }
        }

        // 2. Si envió imagen o comprobante (con o sin texto de pie de foto)
        if (hasImage) {
          const currentProd = clientProduct || (products.find(p => p.enabled !== false)?.id || "grafismo");
          const clientProdObj = products.find(p => p.id === currentProd);
          if (clientProdObj && clientProdObj.enabled === false) {
            console.log(`[BOT] Producto "${currentProd}" apagado por switch maestro. Ignorando comprobante de ${remoteJid}.`);
            continue;
          }
          console.log(`[BOT] Foto o captura recibida de ${remoteJid}. Verificando flujo para producto: "${currentProd}"...`);

          // Obtener las reglas activas de este producto que tienen activada la verificación de comprobante
          const receiptRules = rules.filter(
            (r) =>
              (r.productId || "grafismo") === currentProd &&
              r.enabled !== false &&
              !r.isFollowUp &&
              r.receiptCheck &&
              r.receiptCheck.enabled
          );

          if (receiptRules.length > 0) {
            if (!Array.isArray(userState[remoteJid].completedReceiptRules)) {
              userState[remoteJid].completedReceiptRules = [];
            }
            const clientHistory = userState[remoteJid].completedReceiptRules;

            const apiKeys = getGeminiApiKeys();
            if (apiKeys.length === 0) {
              console.warn(`[BOT RECEIPT] ⚠️ Se recibió una foto pero falta la Gemini API Key. Ir al panel para ingresarla.`);
              let fallbackRule = receiptRules.find((r) => !clientHistory.includes(r.id)) || receiptRules[receiptRules.length - 1];
              matchedRule = fallbackRule;
            } else {
              console.log(`[BOT RECEIPT] Descargando imagen para análisis con Gemini Vision (${apiKeys.length} claves disponibles)...`);
              const imageBuffer = await getMediaBuffer(msg, sock);
              if (imageBuffer) {
                try {
                  console.log(`[BOT RECEIPT] Consultando a Google Gemini Vision (${imageBuffer.length} bytes, MIME: ${mediaMime || "image/jpeg"})...`);
                  const geminiResult = await queryGeminiVision(imageBuffer, mediaMime || "image/jpeg");
                  console.log(`[BOT RECEIPT] Datos extraídos por Gemini:`, JSON.stringify(geminiResult));

                  // Reglas pendientes que aún no completó este cliente
                  const pendingRules = receiptRules.filter((r) => !clientHistory.includes(r.id));
                  const candidatePool = pendingRules.length > 0 ? pendingRules : receiptRules;

                  // Selección inteligente: buscar regla cuyo monto coincida con el comprobante
                  let targetReceiptRule = null;
                  if (geminiResult && geminiResult.monto !== undefined) {
                    const extractedAmount = parseReceiptAmount(geminiResult.monto);
                    targetReceiptRule = candidatePool.find((r) => {
                      const exp = Number(r.receiptCheck?.expectedAmount) || 0;
                      return exp > 0 && Math.abs(extractedAmount - exp) <= 1.5;
                    });
                  }

                  // Si no coincide por monto exacto, tomar la siguiente regla secuencial pendiente
                  if (!targetReceiptRule) {
                    targetReceiptRule = candidatePool[0];
                  }

                  console.log(`[BOT RECEIPT] Regla asignada para verificar comprobante: "${targetReceiptRule.name}" (ID: ${targetReceiptRule.id})`);

                  const validation = validateReceiptData(geminiResult, targetReceiptRule.receiptCheck);
                  console.log(`[BOT RECEIPT] Validación:`, validation.valid ? "APROBADO ✅" : `RECHAZADO ❌ (${validation.reason})`);

                  if (validation.valid) {
                    if (validation.opId) {
                      verifiedOperations.add(validation.opId);
                      saveVerifiedOperations();
                    }
                    if (!userState[remoteJid].completedReceiptRules.includes(targetReceiptRule.id)) {
                      userState[remoteJid].completedReceiptRules.push(targetReceiptRule.id);
                    }
                    if (!userState[remoteJid].triggeredRules.includes(targetReceiptRule.id)) {
                      userState[remoteJid].triggeredRules.push(targetReceiptRule.id);
                    }
                    const currentBoughtProd = targetReceiptRule.productId || currentProd;
                    userState[remoteJid].activeProduct = currentBoughtProd;
                    userState[remoteJid].lastRuleId = targetReceiptRule.id;
                    if (!Array.isArray(userState[remoteJid].purchasedProducts)) {
                      userState[remoteJid].purchasedProducts = [];
                    }
                    if (!userState[remoteJid].purchasedProducts.includes(currentBoughtProd)) {
                      userState[remoteJid].purchasedProducts.push(currentBoughtProd);
                    }
                    userState[remoteJid].updatedAt = Date.now();
                    saveUserState();

                    // Registrar venta en el Panel de Finanzas de forma ultrarrápida
                    const clientPhone = (remoteJidAlt || remoteJid).replace(/@[^]+/, "");
                    const matchedProduct = products.find(p => p.id === currentBoughtProd);
                    const nowSale = new Date();
                    const uState = userState[remoteJid] || (remoteJidAlt ? userState[remoteJidAlt] : {}) || {};
                    const firstSeen = uState.firstSeenAt || Date.now();
                    const diffMinutes = Math.max(0, Math.round((Date.now() - firstSeen) / 60000));
                    const isDirect = diffMinutes <= 25;
                    const originMsg = uState.firstMessage || (rawText ? rawText.trim().substring(0, 150) : "Mensaje directo / Sin anuncio");
                    
                    let adTag = uState.adTag || null;
                    if (!adTag && originMsg) {
                      const tagMatch = originMsg.match(/(\[[a-zA-Z0-9_\-\. ]+\]|#[a-zA-Z0-9_\-]+)/);
                      if (tagMatch) adTag = tagMatch[1];
                    }

                    const newSale = {
                      id: "sale_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
                      timestamp: Date.now(),
                      date: nowSale.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
                      time: nowSale.toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }),
                      phone: clientPhone,
                      clientName: geminiResult?.remitente || geminiResult?.titular_origen || validation?.sender || "Cliente WhatsApp",
                      amount: Number(targetReceiptRule?.receiptCheck?.expectedAmount) || Number(geminiResult?.monto) || 4800,
                      operationId: validation.opId || geminiResult?.numeroOperacion || "N/A",
                      productId: currentBoughtProd,
                      productName: matchedProduct ? matchedProduct.name : targetReceiptRule.name,
                      ruleName: targetReceiptRule.name,
                      ruleId: targetReceiptRule.id,
                      status: "Aprobado ✅",
                      originMessage: originMsg,
                      adTag: adTag,
                      leadTimeMinutes: diffMinutes,
                      saleType: isDirect ? "Directa ⚡" : "Seguimiento ⏰"
                    };
                    sales.unshift(newSale);
                    saveSales();
                    console.log(`[BOT FINANZAS] ¡Venta registrada! $${newSale.amount} de ${newSale.phone} (${newSale.productName})`);

                    matchedRule = targetReceiptRule;
                  } else {
                    console.log(`[BOT RECEIPT] Enviando mensaje de rechazo a ${remoteJid}: "${validation.userMessage}"`);
                    await safeSendMessage(sock, remoteJid, { text: validation.userMessage });
                    if (!Array.isArray(userState[remoteJid].chatHistory)) userState[remoteJid].chatHistory = [];
                    userState[remoteJid].chatHistory.push({ role: "user", text: "[Envío de comprobante de pago]" });
                    userState[remoteJid].chatHistory.push({ role: "model", text: validation.userMessage });
                    saveUserState();
                    continue; // Detener flujo para no entregar el producto
                  }
                } catch (geminiErr) {
                  console.error(`[BOT RECEIPT ERROR]:`, geminiErr.message);
                  console.warn(`[BOT RECEIPT CONTINGENCIA] 🚨 Claves de IA saturadas o cuota agotada. Activando entrega automática para asegurar la venta a ${remoteJid}...`);

                  // Fallback de contingencia: entregar producto y marcar para revisión
                  const pendingRules = receiptRules.filter((r) => !clientHistory.includes(r.id));
                  const targetReceiptRule = pendingRules[0] || receiptRules[0];

                  if (!userState[remoteJid].completedReceiptRules.includes(targetReceiptRule.id)) {
                    userState[remoteJid].completedReceiptRules.push(targetReceiptRule.id);
                  }
                  if (!userState[remoteJid].triggeredRules.includes(targetReceiptRule.id)) {
                    userState[remoteJid].triggeredRules.push(targetReceiptRule.id);
                  }
                  const currentBoughtProd = targetReceiptRule.productId || currentProd;
                  userState[remoteJid].activeProduct = currentBoughtProd;
                  userState[remoteJid].lastRuleId = targetReceiptRule.id;
                  if (!Array.isArray(userState[remoteJid].purchasedProducts)) {
                    userState[remoteJid].purchasedProducts = [];
                  }
                  if (!userState[remoteJid].purchasedProducts.includes(currentBoughtProd)) {
                    userState[remoteJid].purchasedProducts.push(currentBoughtProd);
                  }
                  userState[remoteJid].updatedAt = Date.now();
                  saveUserState();

                  const clientPhone = (remoteJidAlt || remoteJid).replace(/@[^]+/, "");
                  const matchedProduct = products.find(p => p.id === currentBoughtProd);
                  const nowSale = new Date();
                  const newSale = {
                    id: "sale_" + Date.now() + "_" + Math.random().toString(36).slice(2, 7),
                    timestamp: Date.now(),
                    date: nowSale.toLocaleDateString("es-AR", { timeZone: "America/Argentina/Buenos_Aires" }),
                    time: nowSale.toLocaleTimeString("es-AR", { timeZone: "America/Argentina/Buenos_Aires", hour12: false }),
                    phone: clientPhone,
                    clientName: "Cliente WhatsApp (Revisión Cuota IA)",
                    amount: Number(targetReceiptRule?.receiptCheck?.expectedAmount) || 4800,
                    operationId: "FALLBACK_CUOTA_IA",
                    productId: currentBoughtProd,
                    productName: matchedProduct ? matchedProduct.name : targetReceiptRule.name,
                    ruleName: targetReceiptRule.name,
                    ruleId: targetReceiptRule.id,
                    status: "Revisión Manual (Cuota IA) ⚠️"
                  };
                  sales.unshift(newSale);
                  saveSales();

                  matchedRule = targetReceiptRule;
                }
              }
            }
          } else if (!matchedRule) {
            // Fallback tradicional si no tiene casillas de comprobante activadas (SIEMPRE dentro del mismo producto)
            matchedRule = rules.find(
              (r) =>
                (r.productId || "grafismo") === currentProd &&
                r.enabled !== false &&
                !r.isFollowUp &&
                (r.id.includes("entrega") ||
                  r.name?.toLowerCase().includes("entrega") ||
                  r.name?.toLowerCase().includes("comprobante"))
            );
          }
        }

        if (matchedRule) {
          // Registrar en diagnóstico de mensajes recientes
          recentIncoming.unshift({
            time: new Date().toLocaleTimeString("es-AR", { hour12: false }),
            remoteJid,
            remoteJidAlt: remoteJidAlt || null,
            text: rawText ? (rawText.length > 60 ? rawText.slice(0, 60) + "..." : rawText) : (hasImage ? "[Foto/Comprobante]" : (hasAudio ? "[Audio]" : "[Vacío]")),
            matchedRule: matchedRule.name
          });
          if (recentIncoming.length > 30) recentIncoming.pop();

          // Actualizar memoria del cliente con el producto actual y registrar regla disparada
          const prodId = matchedRule.productId || "grafismo";
          if (!userState[remoteJid]) userState[remoteJid] = {};
          if (!Array.isArray(userState[remoteJid].triggeredRules)) {
            userState[remoteJid].triggeredRules = [];
          }
          if (!userState[remoteJid].triggeredRules.includes(matchedRule.id)) {
            userState[remoteJid].triggeredRules.push(matchedRule.id);
          }
          userState[remoteJid].activeProduct = prodId;
          userState[remoteJid].lastRuleId = matchedRule.id;
          userState[remoteJid].updatedAt = Date.now();
          saveUserState();

          // Manejar triggers y cancelaciones de seguimientos (remarketing)
          handleFollowUpTriggers(remoteJid, matchedRule);

          // Despachar todas las respuestas de la regla con sus demoras en segundos
          await executeRuleResponses(sock, remoteJid, matchedRule);
        } else if (!hasImage && (hasAudio || (rawText && rawText.trim().length > 0))) {
          // 3. Si no coincidió con ninguna regla fija ni es comprobante: consultar al Asistente de IA
          let clientProduct = userState[remoteJid]?.activeProduct;
          let prodObj = clientProduct ? products.find((p) => p.id === clientProduct) : null;

          // Si el cliente ya tenía un producto asignado, pero ese producto está apagado, no responder
          if (prodObj && prodObj.enabled === false) {
            console.log(`[BOT AI] El producto "${prodObj.name}" de ${remoteJid} está apagado por switch maestro. No se responde.`);
            continue;
          }

          // Si el mensaje menciona explícitamente palabras clave de otro producto ACTIVO, asociar a ese producto
          if (rawText) {
            const lowerText = rawText.toLowerCase();
            for (const p of products) {
              if (p.enabled === false) continue;
              const words = (p.name + " " + p.id).toLowerCase().split(/[\s_]+/);
              if (words.some(w => w.length > 3 && lowerText.includes(w))) {
                prodObj = p;
                if (!userState[remoteJid]) userState[remoteJid] = {};
                userState[remoteJid].activeProduct = p.id;
                saveUserState();
                break;
              }
            }
          }

          // Si aún no tiene producto asignado o no se encontró, seleccionar el primer producto habilitado con IA activa
          if (!prodObj || prodObj.enabled === false) {
            prodObj = products.find((p) => p.enabled !== false && p.aiEnabled) || products.find((p) => p.enabled !== false) || products[0];
          }

          // Si el producto seleccionado está apagado o no tiene IA activa, no responder
          if (!prodObj || prodObj.enabled === false || !prodObj.aiEnabled) {
            console.log(`[BOT AI] Sin producto con IA activa disponible para responder a ${remoteJid}.`);
            continue;
          }

          if (prodObj && prodObj.enabled !== false && prodObj.aiEnabled) {
            recentIncoming.unshift({
              time: new Date().toLocaleTimeString("es-AR", { hour12: false }),
              remoteJid,
              remoteJidAlt: remoteJidAlt || null,
              text: rawText ? (rawText.length > 60 ? rawText.slice(0, 60) + "..." : rawText) : (hasAudio ? "[Audio]" : "[Vacío]"),
              matchedRule: `IA (${prodObj.name})`
            });
            if (recentIncoming.length > 30) recentIncoming.pop();

            const apiKey = (botConfig.geminiApiKey || process.env.GEMINI_API_KEY || "").trim();
            if (apiKey) {
              console.log(`[BOT AI] Activando Asistente de IA para ${remoteJid} (Producto: "${prodObj.name}", ¿Audio?: ${hasAudio})...`);
              try {
                const targetDelaySec = prodObj.aiDelaySeconds !== undefined && !isNaN(Number(prodObj.aiDelaySeconds))
                  ? Math.max(0, Number(prodObj.aiDelaySeconds))
                  : 10;
                const startTime = Date.now();

                // Indicador de "escribiendo..." en WhatsApp
                try {
                  await sock.sendPresenceUpdate("composing", remoteJid);
                } catch (pe) {}

                let audioBuffer = null;
                if (hasAudio) {
                  audioBuffer = await getMediaBuffer(msg, sock);
                }

                if (!userState[remoteJid]) userState[remoteJid] = {};
                if (!userState[remoteJid].activeProduct) {
                  userState[remoteJid].activeProduct = prodObj.id;
                }
                if (!Array.isArray(userState[remoteJid].chatHistory)) {
                  userState[remoteJid].chatHistory = [];
                }

                const isPurchased = Boolean(
                  userState[remoteJid]?.purchasedProducts?.includes(prodObj.id) ||
                  userState[remoteJid]?.completedReceiptRules?.some((rId) => {
                    const r = rules.find((x) => x.id === rId);
                    return r && (r.productId || "grafismo") === prodObj.id;
                  }) ||
                  userState[remoteJid]?.triggeredRules?.some((rId) => {
                    const r = rules.find((x) => x.id === rId);
                    return r && (r.productId || "grafismo") === prodObj.id && (r.receiptCheck?.enabled || r.name?.toLowerCase().includes("entrega"));
                  })
                );

                let systemInstruction = "";
                if (isPurchased) {
                  systemInstruction = `Sos el asistente de soporte post-venta en WhatsApp para el curso/producto: "${prodObj.name}".
ESTADO DEL CLIENTE: ESTE ALUMNO YA COMPRÓ Y YA RECIBIÓ LOS ENLACES DE ACCESO AL CURSO.

REGLAS ESTRICTAS DE SOPORTE POST-VENTA:
1. NUNCA, bajo ningún concepto, le ofrezcas comprar el curso, ni le pidas que escriba "QUIERO", ni le pidas que comente ninguna palabra clave. Ya es alumno.
2. NUNCA le pidas comprobantes de pago ni le digas que estamos revisando su comprobante. Su pago ya fue verificado y aprobado con éxito.
3. POLÍTICA ABSOLUTA DE REEMBOLSOS: Queda terminantemente PROHIBIDO ofrecer, tramitar, prometer o aceptar reembolsos o devoluciones de dinero. Si el cliente solicita o menciona una devolución de dinero o reembolso, explicále amablemente pero con total firmeza que por tratarse de un infoproducto/curso digital de entrega y acceso inmediato, no se realizan reembolsos ni devoluciones de dinero.
4. Tu rol es responder dudas técnicas, pedagógicas o de acceso sobre "${prodObj.name}", felicitarlo, guiarlo sobre cómo ver o descargar el contenido o resolver consultas basándote en la información del producto.
5. Si el cliente envió una nota de voz, respondé directamente a lo que preguntó en el audio.
6. Respondé en tono amable, humano, directo y conciso estilo WhatsApp (máximo 2 párrafos cortos).

Base de datos / Información de "${prodObj.name}":
${prodObj.aiPrompt || ""}`;
                } else {
                  systemInstruction = `Sos el asesor de ventas y atención en WhatsApp EXCLUSIVAMENTE para el producto: "${prodObj.name}".
Base de datos e información específica de este producto:
${prodObj.aiPrompt || ""}

REGLAS ESTRICTAS DE ATENCIÓN Y VENTAS:
1. Respondé ÚNICAMENTE dudas relacionadas con "${prodObj.name}" basándote en la base de datos anterior. No mezcles con otros cursos ni desvíes la conversación.
2. Si el cliente envió una nota de voz, respondé directamente a lo que preguntó en el audio.
3. Si el cliente menciona que ya pagó, ya envió el comprobante o ves en el chat que dice que ya transfirió (ej: "está claro", "ya pagué", "ya mandé el comprobante"), NUNCA le vuelvas a pedir que escriba QUIERO ni le ofrezcas comprar de nuevo. Decile amablemente que estamos revisando su comprobante y que aguarde un instante que enseguida se le entrega el curso.
4. POLÍTICA ABSOLUTA DE REEMBOLSOS: Queda terminantemente PROHIBIDO ofrecer, tramitar, prometer o aceptar reembolsos o devoluciones de dinero. Si el cliente consulta sobre devoluciones o reembolsos, explicále con amabilidad y firmeza que los productos digitales no cuentan con reembolso tras la entrega.
5. Respondé en tono amable, humano, directo y conciso estilo WhatsApp (máximo 2 párrafos cortos).`;
                }

                const aiResponse = await queryGeminiChat(
                  apiKey,
                  systemInstruction,
                  rawText,
                  audioBuffer,
                  audioMime,
                  userState[remoteJid].chatHistory
                );

                if (aiResponse) {
                  console.log(`[BOT AI] Respuesta generada para ${remoteJid}: "${aiResponse.slice(0, 100)}..."`);

                  // Si se configuró demora (por defecto 10s), esperar lo que reste simulando "escribiendo..."
                  const elapsedMs = Date.now() - startTime;
                  const remainingMs = (targetDelaySec * 1000) - elapsedMs;
                  if (remainingMs > 0) {
                    console.log(`[BOT AI] Esperando ${Math.round(remainingMs / 1000)}s restantes en "escribiendo..." para completar los ${targetDelaySec}s humanos...`);
                    await safePresence(sock, "composing", remoteJid);
                    await sleep(remainingMs);
                  }

                  await safeSendMessage(sock, remoteJid, { text: aiResponse });

                  // Guardar en historial contextual
                  if (rawText && rawText.trim()) {
                    userState[remoteJid].chatHistory.push({ role: "user", text: rawText.trim() });
                  } else if (hasAudio) {
                    userState[remoteJid].chatHistory.push({ role: "user", text: "[Nota de voz enviada]" });
                  }
                  userState[remoteJid].chatHistory.push({ role: "assistant", text: aiResponse });

                  if (userState[remoteJid].chatHistory.length > 6) {
                    userState[remoteJid].chatHistory = userState[remoteJid].chatHistory.slice(-6);
                  }
                  userState[remoteJid].updatedAt = Date.now();
                  saveUserState();
                }
              } catch (aiErr) {
                console.error(`[BOT AI ERROR]:`, aiErr.message);
              } finally {
                await safePresence(sock, "paused", remoteJid);
              }
            } else {
              console.log(`[BOT AI] Asistente activo para "${prodObj.name}" pero falta la Gemini API Key.`);
            }
          }
        }
      }
    } catch (err) {
      console.error("[BOT ERROR]:", err);
    }
  });
}

startBot();

// Keep-Alive para evitar que Render Free Tier suspenda el bot por inactividad
const RENDER_APP_URL = process.env.RENDER_EXTERNAL_URL || "https://whatsapp-bot-5po0.onrender.com";
setInterval(() => {
  try {
    const isHttps = RENDER_APP_URL.startsWith("https");
    const mod = isHttps ? https : http;
    mod.get(RENDER_APP_URL + "/api/data", (res) => {
      // Ping keepalive exitoso
    }).on("error", () => {});
  } catch (e) {}
}, 10 * 60 * 1000);

// Gestor de Memoria RAM: Recolección periódica de basura para Render Free Tier (512 MB máx)
setInterval(() => {
  try {
    const mem = process.memoryUsage();
    const rssMb = Math.round(mem.rss / (1024 * 1024));
    const heapUsedMb = Math.round(mem.heapUsed / (1024 * 1024));
    const heapTotalMb = Math.round(mem.heapTotal / (1024 * 1024));

    if (typeof global.gc === "function") {
      global.gc();
      const afterMem = process.memoryUsage();
      const afterRss = Math.round(afterMem.rss / (1024 * 1024));
      const afterHeap = Math.round(afterMem.heapUsed / (1024 * 1024));
      console.log(`[SISTEMA RAM] Limpieza de memoria ejecutada (GC). RSS: ${afterRss} MB (antes: ${rssMb} MB) | Heap: ${afterHeap} MB (antes: ${heapUsedMb} MB / ${heapTotalMb} MB)`);
    } else {
      console.log(`[SISTEMA RAM] Monitoreo. RSS: ${rssMb} MB | Heap: ${heapUsedMb} MB / ${heapTotalMb} MB`);
    }

    // Poda preventiva de historiales en memoria
    if (messageStore.size > 150) {
      const keysToDelete = Array.from(messageStore.keys()).slice(0, messageStore.size - 100);
      for (const k of keysToDelete) messageStore.delete(k);
    }
    if (processedMessages.size > 500) {
      const valsToDelete = Array.from(processedMessages.values()).slice(0, processedMessages.size - 300);
      for (const v of valsToDelete) processedMessages.delete(v);
    }
  } catch (err) {
    console.error("[SISTEMA RAM ERROR]:", err.message);
  }
}, 10 * 60 * 1000);
