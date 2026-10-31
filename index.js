// Gunakan DNS resolver Google untuk mencegah error querySrv EBADRESP
try {
  require('dns').setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {}

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const pino = require('pino');
const qrcode = require('qrcode');
const qrcodeTerminal = require('qrcode-terminal');

const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const { restoreAuthFromMongo, backupAuthToMongo, clearAuth } = require('./mongoAuth');
const { handleMessage, getIntroductionMessage } = require('./whatsappService');
const { startCronScheduler, executeReminderJob, getJakartaDateRange } = require('./cronService');
const User = require('./models/User');
const AttendanceLog = require('./models/AttendanceLog');

const app = express();
const PORT = process.env.PORT || 10000;
const MONGODB_URI = process.env.MONGODB_URI;

let sock = null;
let lastQR = null;
let isReady = false;
let isCronStarted = false;
const authDir = path.join(process.cwd(), 'baileys_auth');

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * Endpoint Keep-Alive untuk cron-job.org / UptimeRobot
 */
app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Pong! Server is active.',
    timestamp: new Date().toISOString()
  });
});

/**
 * Endpoint Status Bot & Penggunaan Memori
 */
app.get('/status', (req, res) => {
  res.status(200).json({
    status: isReady ? 'READY' : (lastQR ? 'WAITING_QR_SCAN' : 'CONNECTING'),
    isReady,
    user: sock?.user || null,
    uptimeSec: Math.round(process.uptime()),
    memoryUsageMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    timestamp: new Date().toISOString()
  });
});

/**
 * Endpoint Tes Pengingat Manual via Web
 */
app.get('/test-reminder', async (req, res) => {
  if (!sock || !isReady) {
    return res.status(503).json({ error: 'WhatsApp client belum siap / belum terhubung.' });
  }
  try {
    await executeReminderJob(sock);
    res.status(200).json({ status: 'OK', message: 'Pengingat berhasil dijalankan!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * Tampilan Web Live QR Scanner (Zero-Chromium / Super Ringan)
 */
app.get(['/screenshot', '/qr'], async (req, res) => {
  if (req.query.raw === '1') {
    if (!lastQR) {
      return res.status(404).send(isReady ? 'WhatsApp Sudah Terhubung.' : 'QR belum tersedia.');
    }
    const qrBuffer = await qrcode.toBuffer(lastQR, { width: 400, margin: 2 });
    res.contentType('image/png').send(qrBuffer);
    return;
  }

  let qrImgSrc = '';
  if (lastQR) {
    qrImgSrc = await qrcode.toDataURL(lastQR, { width: 350, margin: 2 });
  }

  res.send(`
    <!DOCTYPE html>
    <html lang="id">
    <head>
      <meta charset="UTF-8">
      <title>WhatsApp Web QR Scanner (Baileys)</title>
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; text-align: center; background: #111b21; color: #e9edef; margin: 0; padding: 24px; }
        .card { max-width: 500px; margin: 0 auto; background: #202c33; padding: 28px; border-radius: 12px; box-shadow: 0 4px 16px rgba(0,0,0,0.6); }
        h2 { margin-top: 0; color: #00a884; }
        img { border-radius: 8px; border: 4px solid #00a884; background: #fff; max-width: 100%; height: auto; }
        .btn { padding: 12px 24px; background: #00a884; color: #fff; text-decoration: none; border-radius: 8px; font-weight: bold; font-size: 15px; border: none; cursor: pointer; transition: 0.2s; display: inline-block; margin-top: 16px; }
        .btn:hover { opacity: 0.9; }
        .status-box { padding: 12px; border-radius: 8px; margin: 16px 0; font-size: 15px; font-weight: 500; }
        .connected { background: #064e3b; color: #6ee7b7; border: 1px solid #059669; }
        .waiting { background: #374151; color: #e5e7eb; border: 1px solid #4b5563; }
        .note { font-size: 13px; color: #8696a0; margin-top: 14px; line-height: 1.5; }
      </style>
    </head>
    <body>
      <div class="card">
        <h2>📱 WhatsApp Bot Scanner</h2>
        ${
          isReady
            ? `<div class="status-box connected">✅ Bot WhatsApp SUDAH TERHUBUNG & AKTIF!<br><small>Nomor: +${(sock?.user?.id || '').split(':')[0]}</small></div>
               <p class="note">Bot sedang memantau grup dan siap menjalankan pengingat harian secara otomatis.</p>`
            : qrImgSrc
            ? `<div class="status-box waiting">⚡ Pindai QR Code di bawah menggunakan WhatsApp Anda</div>
               <img src="${qrImgSrc}" alt="QR Code WhatsApp">
               <p class="note">Buka WhatsApp > Titik Tiga / Pengaturan > <b>Perangkat Tertaut</b> > <b>Tautkan Perangkat</b>.</p>
               <button class="btn" onclick="location.reload()">🔄 Segarkan QR</button>`
            : `<div class="status-box waiting">⏳ Sedang menyiapkan koneksi WhatsApp...</div>
               <p class="note">Halaman akan otomatis memuat ulang dalam beberapa detik.</p>
               <script>setTimeout(() => location.reload(), 3000);</script>`
        }
      </div>
      ${!isReady && qrImgSrc ? '<script>setTimeout(() => location.reload(), 15000);</script>' : ''}
    </body>
    </html>
  `);
});

/**
 * Web Dashboard Daftar Anggota Terdaftar
 */
app.get(['/', '/anggota', '/users'], async (req, res) => {
  try {
    const users = await User.find({ isActive: true }).sort({ name: 1 });
    const { startOfDay, endOfDay } = getJakartaDateRange();
    const userIds = users.map((u) => u._id);
    const attendedUserIds = await AttendanceLog.distinct('user', {
      user: { $in: userIds },
      date: { $gte: startOfDay, $lte: endOfDay }
    });
    const attendedSet = new Set(attendedUserIds.map((id) => id.toString()));

    const rows = users
      .map((u, i) => {
        const isAttended = attendedSet.has(u._id.toString());
        const badge = isAttended
          ? '<span style="background:#dcfce7;color:#166534;padding:4px 10px;border-radius:12px;font-weight:600;font-size:12px;">✅ Sudah Absen</span>'
          : '<span style="background:#fee2e2;color:#991b1b;padding:4px 10px;border-radius:12px;font-weight:600;font-size:12px;">⏳ Belum Absen</span>';
        const cleanNum = (u.whatsappNumber || '').split('@')[0].replace(/[^0-9]/g, '');
        const dateStr = u.createdAt ? new Date(u.createdAt).toLocaleDateString('id-ID', { dateStyle: 'medium' }) : '-';
        return `
          <tr style="border-bottom:1px solid #e5e7eb;">
            <td style="padding:12px 16px;text-align:center;color:#6b7280;">${i + 1}</td>
            <td style="padding:12px 16px;font-weight:600;color:#111827;">${u.name}</td>
            <td style="padding:12px 16px;font-family:monospace;color:#374151;">+${cleanNum}</td>
            <td style="padding:12px 16px;text-align:center;">${badge}</td>
            <td style="padding:12px 16px;color:#6b7280;font-size:13px;">${dateStr}</td>
          </tr>
        `;
      })
      .join('');

    const html = `
      <!DOCTYPE html>
      <html lang="id">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Daftar Anggota Monev Maganghub</title>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f3f4f6; margin: 0; padding: 24px; color: #1f2937; }
          .card { max-width: 800px; margin: 0 auto; background: #fff; border-radius: 12px; box-shadow: 0 4px 6px -1px rgba(0,0,0,0.1); overflow: hidden; }
          .header { background: linear-gradient(135deg, #2563eb, #1d4ed8); color: #fff; padding: 24px; text-align: center; }
          .header h1 { margin: 0 0 8px 0; font-size: 22px; }
          .header p { margin: 0; opacity: 0.9; font-size: 14px; }
          .stats { display: flex; justify-content: space-around; padding: 16px; background: #f9fafb; border-bottom: 1px solid #e5e7eb; font-size: 14px; font-weight: 500; }
          table { width: 100%; border-collapse: collapse; text-align: left; }
          th { background: #f9fafb; padding: 12px 16px; font-size: 12px; font-weight: 700; color: #4b5563; text-transform: uppercase; border-bottom: 1px solid #e5e7eb; }
          .footer { padding: 16px; text-align: center; font-size: 13px; color: #6b7280; background: #f9fafb; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header">
            <h1>📋 Daftar Anggota Terdaftar Monev Maganghub</h1>
            <p>Portal Monitoring & Evaluasi Presensi Magang</p>
          </div>
          <div class="stats">
            <div>👥 Total Terdaftar: <strong>${users.length} Orang</strong></div>
            <div>✅ Sudah Absen Hari Ini: <strong>${attendedSet.size} Orang</strong></div>
            <div>⏳ Belum Absen: <strong>${Math.max(0, users.length - attendedSet.size)} Orang</strong></div>
          </div>
          <table>
            <thead>
              <tr>
                <th style="text-align:center;width:50px;">No</th>
                <th>Nama Anggota</th>
                <th>Nomor WhatsApp</th>
                <th style="text-align:center;">Status Hari Ini</th>
                <th>Terdaftar Sejak</th>
              </tr>
            </thead>
            <tbody>
              ${rows || '<tr><td colspan="5" style="text-align:center;padding:32px;color:#9ca3af;">Belum ada anggota yang terdaftar</td></tr>'}
            </tbody>
          </table>
          <div class="footer">
            Data diperbarui secara otomatis dari MongoDB Atlas • <a href="/qr" style="color:#2563eb;text-decoration:none;">Status Bot</a> • <a href="/ping" style="color:#2563eb;text-decoration:none;">Ping</a>
          </div>
        </div>
      </body>
      </html>
    `;

    res.send(html);
  } catch (err) {
    res.status(500).send(`Error saat memuat data anggota: ${err.message}`);
  }
});

/**
 * Menghubungkan ke WhatsApp menggunakan Baileys
 */
async function connectToWhatsApp() {
  console.log('🤖 Menginisialisasi koneksi Baileys (Zero-Chromium)...');

  // Pulihkan auth dari MongoDB Atlas ke folder lokal
  await restoreAuthFromMongo(authDir);

  const { state, saveCreds } = await useMultiFileAuthState(authDir);
  const { version } = await fetchLatestBaileysVersion();

  console.log(`🌐 Menggunakan Baileys WA Web Version: ${version.join('.')}`);

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: pino({ level: 'silent' }), // Silent logger agar logs bersih
    browser: ['Ubuntu', 'Chrome', '20.0.04']
  });

  // Listener event kredensial
  sock.ev.on('creds.update', async () => {
    await saveCreds();
    await backupAuthToMongo(authDir);
  });

  // Listener status koneksi & QR code
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      lastQR = qr;
      console.log('\n======================================================');
      console.log('⚡ QR Code Baileys diterima. Pindai menggunakan WhatsApp:');
      console.log('======================================================\n');
      qrcodeTerminal.generate(qr, { small: true });
      console.log('📱 Bisa scan langsung di terminal atau buka di browser:');
      console.log('👉 https://wa-bot-monev-maganghub-reminder.onrender.com/qr\n');
    }

    if (connection === 'close') {
      isReady = false;
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      console.warn(`⚠️ Koneksi terputus (Status: ${statusCode}). Mencoba rekoneksi: ${shouldReconnect}`);

      if (statusCode === DisconnectReason.loggedOut) {
        console.warn('🚪 Akun keluar (Logged Out). Membersihkan sesi...');
        await clearAuth(authDir);
      }

      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      }
    } else if (connection === 'open') {
      isReady = true;
      lastQR = null;
      console.log('🚀 WhatsApp Bot (Baileys) Berhasil Terhubung & Siap Digunakan!');
      await backupAuthToMongo(authDir);

      if (!isCronStarted) {
        isCronStarted = true;
        startCronScheduler(sock);
      }
    }
  });

  // Listener pesan masuk
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      try {
        await handleMessage(sock, msg);
      } catch (err) {
        console.error('❌ Error saat memproses pesan:', err);
      }
    }
  });

  // Listener saat bot diundang masuk ke dalam grup
  sock.ev.on('group-participants.update', async ({ id, participants, action }) => {
    try {
      if (action === 'add') {
        const botJid = sock.user?.id ? sock.user.id.split(':')[0] + '@s.whatsapp.net' : null;
        if (botJid && participants.includes(botJid)) {
          console.log(`🎉 Bot baru saja diundang ke grup: ${id}. Mengirim pesan perkenalan...`);
          await sock.sendMessage(id, { text: getIntroductionMessage() });
        }
      }
    } catch (e) {
      console.warn('Gagal menangani event group-participants.update:', e.message);
    }
  });

  // Backup berkala sesi ke MongoDB Atlas setiap 5 menit
  setInterval(() => {
    if (isReady) {
      backupAuthToMongo(authDir);
    }
  }, 300000);
}

/**
 * Bootstrap Utama Aplikasi
 */
async function bootstrap() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI tidak ditemukan di file .env!');
    process.exit(1);
  }

  try {
    // 1. Jalankan Express Server
    app.listen(PORT, () => {
      console.log(`🌐 Express server berjalan pada port ${PORT}`);
      console.log(`📡 Keep-alive endpoint: http://localhost:${PORT}/ping`);
      console.log(`📊 Dashboard anggota : http://localhost:${PORT}/anggota`);
      console.log(`📷 Tampilan QR Code  : http://localhost:${PORT}/qr`);
    });

    // 2. Hubungkan ke MongoDB Atlas
    console.log('⏳ Menghubungkan ke MongoDB Atlas...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Terhubung ke MongoDB Atlas!');

    // 3. Jalankan koneksi Baileys WhatsApp
    await connectToWhatsApp();
  } catch (err) {
    console.error('❌ Terjadi kesalahan fatal pada bootstrap:', err);
    process.exit(1);
  }
}

bootstrap();
