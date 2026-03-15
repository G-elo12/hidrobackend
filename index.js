const express = require("express");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const PORT = process.env.PORT || 3000;

// ── Token de autenticación (env var o fallback para desarrollo) ──────────────
const AUTH_TOKEN = process.env.AUTH_TOKEN || "secret-token-dev";

const app = express();
const server = http.createServer(app);

app.use(express.json());

// ── Estado global ────────────────────────────────────────────────────────────
let estadoBomba = false;
let datosSensores = { temperatura: null, ph: null, nivel: null };
const notificaciones = [];

// ── Límites de alerta ────────────────────────────────────────────────────────
const LIMITES = {
  temperaturaMax: 30,
  phMin: 6.0,
  phMax: 8.0,
  nivelMin: 20,
};

// ────────────────────────────────────────────────────────────────────────────
//  REST API
// ────────────────────────────────────────────────────────────────────────────

/** Middleware: valida token en header Authorization: Bearer <token> */
function autenticar(req, res, next) {
  const header = req.headers["authorization"] || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (token !== AUTH_TOKEN) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

app.post("/cmd", autenticar, (req, res) => {
  const { bomba } = req.body;

  if (typeof bomba !== "boolean") {
    return res.status(400).json({ error: 'Falta el campo "bomba" (true o false)' });
  }

  estadoBomba = bomba;

  const payload = JSON.stringify({ type: "cmd", bomba: estadoBomba });
  broadcast(payload, "esp32");
  broadcast(payload, "dashboard");
  timestamp(`[REST→WS] Comando: Bomba ${estadoBomba ? "ENCENDIDA" : "APAGADA"}`);
  res.json({ ok: true, bomba: estadoBomba });
});

app.get("/status", autenticar, (_req, res) => {
  const clientes = [...clienteMap.values()].map(({ device, ip }) => ({ device, ip }));
  res.json({ clientes, total: clienteMap.size });
});

app.get("/state", autenticar, (_req, res) => {
  res.json({ bomba: estadoBomba, sensores: datosSensores });
});

app.get("/notifications", autenticar, (_req, res) => {
  res.json({ notificaciones });
});

// ────────────────────────────────────────────────────────────────────────────
//  Lógica de alertas
// ────────────────────────────────────────────────────────────────────────────

/**
 * Evalúa TODAS las condiciones de alerta y emite una notificación por cada una.
 * Antes: solo disparaba la primera condición que se cumplía.
 */
function evaluarNotificaciones(temperatura, ph, nivel) {
  const alertas = [];

  if (temperatura > LIMITES.temperaturaMax)
    alertas.push(`Temperatura alta (${temperatura}°C)`);
  if (ph < LIMITES.phMin || ph > LIMITES.phMax)
    alertas.push(`pH fuera de rango (${ph})`);
  if (nivel < LIMITES.nivelMin)
    alertas.push(`Nivel de agua muy bajo (${nivel}%)`);

  for (const mensaje of alertas) {
    const nuevaNotificacion = {
      id: Date.now(),
      mensaje: `Alerta: ${mensaje}`,
      fecha: new Date().toISOString(),
    };

    notificaciones.push(nuevaNotificacion);
    if (notificaciones.length > 50) notificaciones.shift();

    broadcast(
      JSON.stringify({ type: "notification", data: nuevaNotificacion }),
      "dashboard"
    );
    timestamp(`[NOTIFICACIÓN] ${nuevaNotificacion.mensaje}`);
  }
}

// ────────────────────────────────────────────────────────────────────────────
//  WebSocket
// ────────────────────────────────────────────────────────────────────────────

const wss = new WebSocketServer({ server });
const clienteMap = new Map(); // ws → { device, ip }

wss.on("connection", (ws, req) => {
  const ip = req.socket.remoteAddress;
  clienteMap.set(ws, { device: "unknown", ip });
  timestamp(`Cliente conectado desde ${ip}. Total: ${wss.clients.size}`);

  ws.on("message", (rawData) => {
    let data;
    try {
      data = JSON.parse(rawData.toString());
    } catch {
      console.error("[JSON] Trama inválida:", rawData.toString());
      return;
    }

    switch (data.type) {
      case "register": {
        // Valida token en el mensaje de registro
        if (data.token !== AUTH_TOKEN) {
          timestamp(`[AUTH] Token inválido desde ${ip}. Cerrando conexión.`);
          ws.close(1008, "Token inválido");
          return;
        }

        const device = data.device || "unknown";
        clienteMap.set(ws, { device, ip });
        timestamp(`Dispositivo registrado: ${device} (${ip})`);

        enviar(ws, { type: "ack", msg: `Bienvenido, ${device}` });

        if (device === "dashboard") {
          enviar(ws, {
            type: "state_sync",
            bomba: estadoBomba,
            sensores: datosSensores,
          });
          timestamp(`[SYNC] Estado enviado a la nueva app (${ip})`);
        }
        break;
      }

      case "sensor_data": {
        const { temperatura, ph, nivel } = data;

        // FIX: valida que los campos sean números antes de procesar
        if (
          typeof temperatura !== "number" ||
          typeof ph !== "number" ||
          typeof nivel !== "number"
        ) {
          console.warn("[WS] sensor_data con campos inválidos:", data);
          enviar(ws, { type: "error", msg: "Campos de sensor inválidos" });
          return;
        }

        datosSensores = { temperatura, ph, nivel };

        // FIX: usa el device registrado en clienteMap en lugar de data.device
        const info = clienteMap.get(ws) || {};
        timestamp(
          `[${info.device || "esp32"}] Temp=${temperatura}°C | pH=${ph} | Nivel=${nivel}%`
        );

        broadcast(
          JSON.stringify({ type: "sensor_data", sensores: datosSensores }),
          "dashboard"
        );
        evaluarNotificaciones(temperatura, ph, nivel);
        break;
      }

      case "ping":
        enviar(ws, { type: "pong" });
        break;

      default:
        console.log(`[WS] Tipo desconocido: ${data.type}`);
    }
  });

  ws.on("close", (code) => {
    const info = clienteMap.get(ws) || {};
    timestamp(
      `Desconectado: ${info.device || "unknown"} (${info.ip}) — código ${code}`
    );
    clienteMap.delete(ws); // limpieza al cerrar
  });

  ws.on("error", (err) => {
    console.error("[WS] Error de socket:", err.message);
    clienteMap.delete(ws); // FIX: también limpia el mapa en caso de error
  });
});

// ────────────────────────────────────────────────────────────────────────────
//  Helpers
// ────────────────────────────────────────────────────────────────────────────

function enviar(ws, obj) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

function broadcast(payload, targetDevice = "*") {
  for (const [ws, info] of clienteMap.entries()) {
    if (ws.readyState !== WebSocket.OPEN) continue;
    if (targetDevice !== "*" && info.device !== targetDevice) continue;
    ws.send(payload);
  }
}

function timestamp(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// ────────────────────────────────────────────────────────────────────────────
//  Arranque
// ────────────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  timestamp(`Servidor escuchando en http://localhost:${PORT}`);
  timestamp(`WebSocket disponible en ws://localhost:${PORT}`);
  console.log("──────────────────────────────────────────────────────────────");
  console.log("  POST /cmd            {bomba: true/false}  [Auth requerida]");
  console.log("  GET  /state          Estado de bomba y sensores             ");
  console.log("  GET  /notifications  Historial de alertas                   ");
  console.log("  GET  /status         Clientes conectados                    ");
  console.log("  WS   register        {type,device,token}                    ");
  console.log("──────────────────────────────────────────────────────────────");
  console.log(`  AUTH_TOKEN activo: ${AUTH_TOKEN === "secret-token-dev" ? "⚠️  DEV (cámbialo en producción)" : "✅ Personalizado"}`);
  console.log("──────────────────────────────────────────────────────────────");
});