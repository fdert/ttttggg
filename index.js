const express = require('express');
const { makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys');
const QRCode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', '*');
  res.header('Access-Control-Allow-Methods', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const sessions = new Map();
const qrCodes = new Map();
const AUTH_DIR = './auth_sessions';

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

async function createSession(sessionId) {
  const sessionPath = path.join(AUTH_DIR, sessionId);
  const { state, saveCreds } = await useMultiFileAuthState(sessionPath);

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: true,
    logger: pino({ level: 'silent' }),
    browser: ['WhatsApp Primo', 'Chrome', '120.0.0'],
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    
    if (qr) {
      console.log(`[${sessionId}] QR Code generated`);
      const qrDataUrl = await QRCode.toDataURL(qr);
      qrCodes.set(sessionId, qrDataUrl);
    }

    if (connection === 'open') {
      console.log(`[${sessionId}] Connected!`);
      qrCodes.delete(sessionId);
      sessions.set(sessionId, { sock, status: 'connected' });
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      console.log(`[${sessionId}] Disconnected: ${reason}`);
      
      if (reason !== DisconnectReason.loggedOut) {
        setTimeout(() => createSession(sessionId), 3000);
      } else {
        sessions.delete(sessionId);
        qrCodes.delete(sessionId);
      }
    }
  });

  sessions.set(sessionId, { sock, status: 'pending' });
  return sock;
}

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Get all sessions
app.get('/sessions', (req, res) => {
  const list = [];
  sessions.forEach((val, id) => {
    list.push({ id, status: val.status });
  });
  res.json(list);
});

// Create session
app.post('/sessions', async (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'Session ID required' });
  
  if (sessions.has(id)) {
    return res.json({ id, status: sessions.get(id).status });
  }

  await createSession(id);
  res.json({ id, status: 'pending' });
});

// Delete session
app.delete('/sessions/:id', (req, res) => {
  const { id } = req.params;
  const session = sessions.get(id);
  
  if (session?.sock) {
    session.sock.logout().catch(() => {});
    session.sock.end();
  }
  
  sessions.delete(id);
  qrCodes.delete(id);
  
  const sessionPath = path.join(AUTH_DIR, id);
  if (fs.existsSync(sessionPath)) {
    fs.rmSync(sessionPath, { recursive: true });
  }
  
  res.json({ success: true });
});

// Get session status
app.get('/sessions/:id/status', (req, res) => {
  const session = sessions.get(req.params.id);
  res.json({ status: session?.status || 'disconnected' });
});

// Get QR code
app.get('/qr/:sessionId', (req, res) => {
  const qr = qrCodes.get(req.params.sessionId);
  res.json({ qr: qr || null });
});

// Send text message
app.post('/send/text', async (req, res) => {
  const { sessionId, to, message } = req.body;
  const session = sessions.get(sessionId);
  
  if (!session?.sock || session.status !== 'connected') {
    return res.status(400).json({ error: 'Session not connected' });
  }

  try {
    const jid = to.includes('@') ? to : `${to}@s.whatsapp.net`;
    await session.sock.sendMessage(jid, { text: message });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
