// Gunakan DNS resolver Google untuk mencegah error querySrv EBADRESP di jaringan/ISP tertentu
try {
  require('dns').setServers(['8.8.8.8', '8.8.4.4']);
} catch (e) {
  // Abaikan jika tidak diizinkan di env tertentu
}

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const express = require('express');
const mongoose = require('mongoose');
const { Client, RemoteAuth } = require('whatsapp-web.js');
const { MongoStore } = require('wwebjs-mongo');
const { registerWhatsAppEvents } = require('./whatsappService');
const { startCronScheduler, executeReminderJob, getJakartaDateRange } = require('./cronService');
const User = require('./models/User');
const AttendanceLog = require('./models/AttendanceLog');

/**
 * Mencari path Google Chrome atau Edge yang terpasang di sistem
 */
function getExecutablePath() {
  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }
  const possiblePaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser'
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

const app = express();
const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
let waClient = null;

// Middleware JSON & URL-Encoded
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

/**
 * 4.A Express Keep-Alive Endpoints
 * Endpoint /ping digunakan untuk keep-alive oleh cron-job.org / UptimeRobot
 */
app.get('/ping', (req, res) => {
  res.status(200).json({
    status: 'OK',
    message: 'Pong! Server is active.',
    timestamp: new Date().toISOString()
  });
});

app.get('/test-reminder', async (req, res) => {
  if (!waClient) {
    return res.status(503).json({ error: 'WhatsApp client belum siap.' });
  }
  try {
    await executeReminderJob(waClient);
    res.status(200).json({ status: 'OK', message: 'Pengingat berhasil dijalankan!' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.status(200).json({
    name: 'WA Bot Monev Reminder Maganghub',
    status: 'Running',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

/**
 * Web Dashboard / Endpoint Daftar Anggota Terdaftar
 * Dapat diakses via browser: http://localhost:3000/anggota
 */
app.get(['/anggota', '/users'], async (req, res) => {
  try {
    const users = await User.find({ isActive: true }).sort({ name: 1 });
    const { startOfDay, endOfDay } = getJakartaDateRange();
    const userIds = users.map((u) => u._id);
    const attendedUserIds = await AttendanceLog.distinct('user', {
      user: { $in: userIds },
      date: { $gte: startOfDay, $lte: endOfDay }
    });
    const attendedSet = new Set(attendedUserIds.map((id) => id.toString()));

    // Format JSON jika diminta melalui query parameter (?format=json)
    if (req.query.format === 'json') {
      return res.status(200).json({
        total: users.length,
        alreadyAttendedToday: attendedSet.size,
        users: users.map((u) => ({
          id: u._id,
          name: u.name,
          whatsappNumber: u.whatsappNumber,
          groupId: u.groupId,
          attendedToday: attendedSet.has(u._id.toString()),
          registeredAt: u.createdAt
        }))
      });
    }

    // Tampilan HTML Dashboard untuk dibuka di browser oleh admin
    const rows = users
      .map((u, i) => {
        const isAttended = attendedSet.has(u._id.toString());
        const badge = isAttended
          ? '<span style="background:#dcfce7;color:#166534;padding:4px 10px;border-radius:12px;font-weight:600;font-size:12px;">✅ Sudah Absen</span>'
          : '<span style="background:#fee2e2;color:#991b1b;padding:4px 10px;border-radius:12px;font-weight:600;font-size:12px;">⏳ Belum Absen</span>';
        const cleanNum = (u.whatsappNumber || '').split('@')[0];
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
            Data diperbarui secara otomatis dari MongoDB Atlas • <a href="/ping" style="color:#2563eb;text-decoration:none;">Status Server</a>
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
 * Inisialisasi Koneksi Database dan WhatsApp Client
 */
async function bootstrap() {
  if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI tidak ditemukan di file .env!');
    process.exit(1);
  }

  try {
    // 1. Jalankan Express Server terlebih dahulu
    app.listen(PORT, () => {
      console.log(`🌐 Express server berjalan pada port ${PORT}`);
      console.log(`📡 Keep-alive endpoint: http://localhost:${PORT}/ping`);
    });

    // 2. Hubungkan ke MongoDB Atlas
    console.log('⏳ Menghubungkan ke MongoDB Atlas...');
    await mongoose.connect(MONGODB_URI);
    console.log('✅ Terhubung ke MongoDB Atlas!');

    // 3. Inisialisasi MongoStore untuk RemoteAuth
    console.log('📦 Menginisialisasi MongoStore untuk RemoteAuth...');
    const authDir = path.join(process.cwd(), '.wwebjs_auth');
    if (!fs.existsSync(authDir)) {
      fs.mkdirSync(authDir, { recursive: true });
    }

    const store = new MongoStore({ mongoose: mongoose });

    // Override store.extract: memastikan folder tujuan ada sebelum stream unduh dari MongoDB dimulai
    store.extract = async function (options) {
      if (options.path) {
        const targetDir = path.dirname(options.path);
        if (!fs.existsSync(targetDir)) {
          fs.mkdirSync(targetDir, { recursive: true });
        }
      }

      const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
        bucketName: `whatsapp-${options.session}`
      });

      return new Promise((resolve, reject) => {
        const downloadStream = bucket.openDownloadStreamByName(`${options.session}.zip`);
        const writeStream = fs.createWriteStream(options.path);

        downloadStream
          .pipe(writeStream)
          .on('error', (err) => reject(err))
          .on('finish', () => resolve())
          .on('close', () => resolve());
      });
    };

    // Override store.save: wwebjs-mongo mencari file di root (cwd), sedangkan whatsapp-web.js
    // menyimpannya di folder .wwebjs_auth/. Override ini membaca dari path yang tepat dan
    // menggunakan stream 'finish'/'close' agar penyimpanan ke MongoDB Atlas selalu mulus.
    store.save = async function (options) {
      const sessionZip = `${options.session}.zip`;
      const possiblePaths = [
        path.join(process.cwd(), '.wwebjs_auth', sessionZip),
        path.join(process.cwd(), sessionZip)
      ];
      const sourceZip = possiblePaths.find((p) => fs.existsSync(p));

      if (!sourceZip) {
        console.warn(`⚠️ File sesi ${sessionZip} belum ditemukan untuk disimpan ke MongoDB.`);
        return;
      }

      const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
        bucketName: `whatsapp-${options.session}`
      });

      await new Promise((resolve, reject) => {
        const uploadStream = bucket.openUploadStream(sessionZip);
        fs.createReadStream(sourceZip)
          .pipe(uploadStream)
          .on('error', (err) => reject(err))
          .on('finish', () => resolve())
          .on('close', () => resolve());
      });

      // Bersihkan backup sesi lama di MongoDB jika ada lebih dari 1 versi
      try {
        const documents = await bucket.find({ filename: sessionZip }).toArray();
        if (documents.length > 1) {
          const oldSession = documents.reduce((a, b) => (a.uploadDate < b.uploadDate ? a : b));
          await bucket.delete(oldSession._id);
        }
      } catch (delErr) {
        // Abaikan error pembersihan minor
      }
    };

    // 4. Inisialisasi WhatsApp Web Client dengan RemoteAuth
    console.log('🤖 Menginisialisasi WhatsApp Web Client...');
    const executablePath = getExecutablePath();
    if (executablePath) {
      console.log(`🧭 Menggunakan browser sistem: ${executablePath}`);
    }

    const puppeteerOptions = {
      headless: true,
      protocolTimeout: 0, // Nonaktifkan protocol timeout agar Puppeteer tidak time out saat sinkronisasi sesi
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--disable-gpu',
        '--disable-extensions',
        '--disable-default-apps'
      ]
    };

    if (executablePath) {
      puppeteerOptions.executablePath = executablePath;
    }

    const client = new Client({
      authStrategy: new RemoteAuth({
        store: store,
        backupSyncIntervalMs: 300000 // Sinkronisasi backup ke MongoDB tiap 5 menit
      }),
      authTimeoutMs: 120000, // Beri waktu toleransi hingga 2 menit untuk pemulihan sesi
      puppeteer: puppeteerOptions
    });
    waClient = client;

    // 5. Daftarkan event listener WhatsApp
    registerWhatsAppEvents(client);

    // 6. Mulai Cron Scheduler tepat satu kali setelah WhatsApp Client pertama kali siap
    let isCronStarted = false;
    client.on('ready', () => {
      if (!isCronStarted) {
        isCronStarted = true;
        startCronScheduler(client);
      }
    });

    // 7. Start WhatsApp client dengan penanganan navigasi/reload halaman
    console.log('🌐 Membuka Chrome & memuat WhatsApp Web (sinkronisasi sesi)...');
    try {
      await client.initialize();
    } catch (initErr) {
      if (initErr.message && (initErr.message.includes('Execution context was destroyed') || initErr.message.includes('Session closed'))) {
        console.warn('⚠️ Halaman WhatsApp Web memuat ulang saat otentikasi. Menunggu sesi stabil...');
      } else {
        throw initErr;
      }
    }
  } catch (error) {
    console.error('❌ Terjadi kesalahan fatal saat inisialisasi aplikasi:', error);
    process.exit(1);
  }
}

// Tangani Uncaught Exception & Rejection
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Penanganan Graceful Shutdown saat Ctrl+C (SIGINT) atau Server dimatikan (SIGTERM)
// Menutup browser Chrome secara bersih agar tidak ada proses orphan yang mengunci file sesi
let isShuttingDown = false;
async function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  console.log(`\n🛑 Menerima sinyal ${signal}. Menutup browser WhatsApp secara bersih...`);
  try {
    if (waClient) {
      await waClient.destroy();
    }
    await mongoose.disconnect();
    console.log('👋 Bot dan Chrome berhasil ditutup dengan aman.');
  } catch (err) {
    console.error('Error saat shutdown:', err);
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// Jalankan aplikasi
bootstrap();

