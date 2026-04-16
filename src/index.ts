import http from "http";
import { Client, GatewayIntentBits } from "discord.js";
import {
  joinVoiceChannel,
  getVoiceConnection,
  VoiceConnectionStatus,
  EndBehaviorType,
} from "@discordjs/voice";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const OpusScript = require("opusscript") as new (
  sampleRate: number,
  channels: number,
  application?: number
) => { decode(buf: Buffer, frameSize?: number): Buffer; delete(): void };
import WebSocket from "ws";

// ── Config ────────────────────────────────────────────────────────────────────
const BOT_TOKEN = process.env["DISCORD_BOT_TOKEN"];
const GUILD_ID = process.env["SCANNER_BOT_GUILD_ID"];
const CHANNEL_ID = process.env["SCANNER_CHANNEL_ID"];
const API_WS_URL =
  process.env["SCANNER_WS_URL"] ?? "ws://localhost:8080/internal/scanner-feed";
const SCANNER_SECRET =
  process.env["SCANNER_INTERNAL_SECRET"] ?? "dev-scanner-secret";

// On Replit, outbound UDP is blocked so voice will never connect.
// Skip voice entirely here and let the external Railway deployment handle it.
const VOICE_DISABLED = !!process.env["REPL_ID"] || process.env["SCANNER_DISABLE_VOICE"] === "true";

// ── PCM constants (must match api-server and bcrp-phone) ─────────────────────
const SAMPLE_RATE = 48_000;
const CHANNELS = 2;
const FRAME_SIZE = 960; // 20ms at 48kHz
const BYTES_PER_SAMPLE = 2; // int16 LE
const FRAME_BYTES = FRAME_SIZE * CHANNELS * BYTES_PER_SAMPLE; // 3840 bytes

type OpusDecoder = { decode(buf: Buffer, frameSize?: number): Buffer; delete(): void };

// ── State ─────────────────────────────────────────────────────────────────────
const userBuffers = new Map<string, Buffer[]>();
const opusDecoders = new Map<string, OpusDecoder>();
let ws: WebSocket | null = null;
let wsReady = false;

// ── WebSocket connection to API server ────────────────────────────────────────
function connectToServer() {
  console.log(`[Scanner] Connecting to API server at ${API_WS_URL} …`);
  const socket = new WebSocket(API_WS_URL, {
    headers: { "x-scanner-secret": SCANNER_SECRET },
  });

  socket.on("open", () => {
    ws = socket;
    wsReady = true;
    console.log("[Scanner] ✓ Connected to API server — audio relay active");
  });

  socket.on("close", () => {
    if (ws === socket) {
      ws = null;
      wsReady = false;
    }
    console.log("[Scanner] Disconnected from API server — retrying in 5 s …");
    setTimeout(connectToServer, 5_000);
  });

  socket.on("error", (err: Error) => {
    console.error("[Scanner] WebSocket error:", err.message);
  });
}

// ── Mix-and-send loop (20 ms) ─────────────────────────────────────────────────
setInterval(() => {
  if (!wsReady || !ws || userBuffers.size === 0) return;

  const mixed = Buffer.alloc(FRAME_BYTES, 0);
  const mixedView = new Int16Array(
    mixed.buffer,
    mixed.byteOffset,
    mixed.length / 2
  );

  for (const [, packets] of userBuffers) {
    const packet = packets.shift();
    if (!packet || packet.length < FRAME_BYTES) continue;

    const packetView = new Int16Array(
      packet.buffer,
      packet.byteOffset,
      packet.length / 2
    );

    for (let i = 0; i < mixedView.length; i++) {
      const sum = (mixedView[i] ?? 0) + (packetView[i] ?? 0);
      // Hard-clip to int16 range to prevent distortion
      mixedView[i] = sum > 32767 ? 32767 : sum < -32768 ? -32768 : sum;
    }
  }

  try {
    ws.send(mixed);
  } catch {
    // Socket may have closed between the check and send
  }
}, 20);

// ── Discord client ────────────────────────────────────────────────────────────
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once("ready", () => {
  console.log(`[Scanner] Bot ready as ${client.user?.tag}`);

  if (VOICE_DISABLED) {
    console.log("[Scanner] Voice disabled on this host (UDP not available). Relay-only mode — waiting for external bot to stream audio.");
    return;
  }

  if (!GUILD_ID || !CHANNEL_ID) {
    console.warn(
      "[Scanner] SCANNER_BOT_GUILD_ID or SCANNER_CHANNEL_ID not set — not joining any channel."
    );
    console.warn(
      "[Scanner] Set both env vars and restart the scanner-bot workflow to start relaying audio."
    );
    return;
  }

  joinRTO();
});

// Exponential backoff state for voice retries
let voiceRetryDelay = 15_000;
const VOICE_RETRY_MAX = 120_000; // cap at 2 minutes

function joinRTO() {
  if (!GUILD_ID || !CHANNEL_ID) return;

  // Destroy any stale connection for this guild first —
  // leaving a zombie connection causes Discord to ignore new VOICE_STATE_UPDATEs.
  const existing = getVoiceConnection(GUILD_ID);
  if (existing) {
    console.log("[Scanner] Destroying stale voice connection before reconnecting …");
    existing.destroy();
    // Give the gateway a moment to process the disconnect before we rejoin
    setTimeout(() => joinRTO(), 2_000);
    return;
  }

  const guild = client.guilds.cache.get(GUILD_ID);
  if (!guild) {
    console.error(`[Scanner] Guild ${GUILD_ID} not found in cache. Retrying in 10 s …`);
    setTimeout(joinRTO, 10_000);
    return;
  }

  const channel = guild.channels.cache.get(CHANNEL_ID);
  if (!channel || !channel.isVoiceBased()) {
    console.error(`[Scanner] Channel ${CHANNEL_ID} not found or is not a voice channel. Check SCANNER_CHANNEL_ID env var.`);
    return;
  }

  console.log(`[Scanner] Joining voice channel: #${channel.name} (type=${channel.type})`);

  const connection = joinVoiceChannel({
    channelId: CHANNEL_ID,
    guildId: GUILD_ID,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: false,
    selfMute: true,
  });

  let joined = false;
  let stateLoggedAt = Date.now();

  connection.on(VoiceConnectionStatus.Signalling, () => {
    stateLoggedAt = Date.now();
    console.log("[Scanner] Voice: Signalling — waiting for Discord voice server assignment …");
  });
  connection.on(VoiceConnectionStatus.Connecting, () => {
    stateLoggedAt = Date.now();
    console.log(`[Scanner] Voice: Connecting (UDP handshake) … elapsed=${Date.now() - stateLoggedAt}ms`);
  });
  connection.on(VoiceConnectionStatus.Ready, () => {
    joined = true;
    voiceRetryDelay = 15_000; // reset backoff on success
    console.log(`[Scanner] ✓ Joined #${channel.name} — listening for audio …`);
    const receiver = connection.receiver;

    receiver.speaking.on("start", (userId: string) => {
      if (receiver.subscriptions.has(userId)) return;

      if (!opusDecoders.has(userId)) {
        opusDecoders.set(userId, new OpusScript(SAMPLE_RATE, CHANNELS));
      }

      const stream = receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: 300 },
      });

      stream.on("data", (opusPacket: Buffer) => {
        const decoder = opusDecoders.get(userId);
        if (!decoder) return;
        try {
          const pcm = decoder.decode(opusPacket);
          if (!userBuffers.has(userId)) userBuffers.set(userId, []);
          userBuffers.get(userId)!.push(pcm);
        } catch {
          // Malformed Opus packet — skip silently
        }
      });

      stream.on("end", () => {
        userBuffers.delete(userId);
      });
    });
  });

  connection.on(VoiceConnectionStatus.Disconnected, () => {
    if (joined) {
      console.log("[Scanner] Disconnected from voice channel — retrying in 5 s …");
      joined = false;
      connection.destroy();
      userBuffers.clear();
      voiceRetryDelay = 15_000;
      setTimeout(joinRTO, 5_000);
    }
  });

  // Diagnose if stuck in Signalling: log a raw VOICE_SERVER_UPDATE check after 8s
  setTimeout(() => {
    if (!joined) {
      const state = connection.state.status;
      console.warn(
        `[Scanner] Still waiting after 8 s — current state: ${state}. ` +
        "If stuck at 'signalling', Discord gateway is not responding with VOICE_SERVER_UPDATE. " +
        "This usually means: rapid reconnects rate-limited, or the channel has unusual settings."
      );
    }
  }, 8_000);

  // Full timeout with exponential backoff
  setTimeout(() => {
    if (!joined) {
      const state = connection.state.status;
      console.error(`[Scanner] ⚠ Voice not ready after 30 s (state=${state}). Backing off ${voiceRetryDelay / 1000}s before retry …`);
      connection.destroy();
      userBuffers.clear();
      const delay = voiceRetryDelay;
      voiceRetryDelay = Math.min(voiceRetryDelay * 2, VOICE_RETRY_MAX);
      setTimeout(joinRTO, delay);
    }
  }, 30_000);
}

// ── Health check HTTP server (required by Railway — without it Railway restarts the
//    process every ~5 minutes when health checks fail, dropping the WebSocket feed) ─
const HEALTH_PORT = parseInt(process.env["PORT"] ?? "3000", 10);
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status: "ok",
    wsConnected: wsReady,
    voiceDisabled: VOICE_DISABLED,
  }));
}).listen(HEALTH_PORT, () => {
  console.log(`[Scanner] Health check server listening on port ${HEALTH_PORT}`);
});

// ── Boot ──────────────────────────────────────────────────────────────────────
if (!BOT_TOKEN) {
  console.error("[Scanner] DISCORD_BOT_TOKEN is not set — cannot start bot.");
  process.exit(1);
}

connectToServer();
client.login(BOT_TOKEN);
