# Monev Maganghub WhatsApp Reminder Bot (100% Free Cloud Version)

Bot WhatsApp pengingat absensi Monev Maganghub di dalam grup WhatsApp. Didesain khusus agar dapat berjalan 24/7 di layanan cloud gratis (Render, Koyeb, atau PaaS sejenis) tanpa kehilangan sesi WhatsApp saat server restart berkat **RemoteAuth** via **MongoDB Atlas**.

---

## 🚀 Fitur Utama
1. **RemoteAuth Persistent Session:** Sesi WhatsApp disimpan di MongoDB Atlas via `wwebjs-mongo`, sehingga aman dari *Ephemeral Storage* (data tidak hilang saat server restart/redeploy).
2. **Express Keep-Alive Endpoint (`/ping`):** Mencegah server Render/Koyeb tertidur (*idle spin-down*) jika diping setiap 14 menit oleh layanan seperti [cron-job.org](https://cron-job.org).
3. **Pendaftaran Otomatis di Grup (`!daftar [Nama]`):** Anggota grup cukup mendaftar sekali.
4. **Konfirmasi Absensi Cerdas (`!sudah`):**
   * Menyimpan riwayat log absensi harian (`AttendanceLog`).
   * **All-Clear Notification:** Otomatis mengirim pesan ucapan selamat jika semua anggota aktif di grup sudah absen pada hari tersebut.
5. **Hourly Persistent Scheduler (`cronService.js`):**
   * Aktif setiap jam kerja: **Senin – Jumat pukul 16:00 s.d. 23:00 WIB** (`0 16-23 * * 1-5`).
   * Hanya memention anggota yang **belum** absen pada hari itu.
   * Teks pesan dinamis (Pukul 16:00 sambutan awal, 17:00-22:00 pengingat berkala, 23:00 panggilan terakhir/last call).

---

## 📁 Struktur Direktori
```
wa-bot-monev-reminder/
├── models/
│   ├── User.js              # Model Mongoose untuk data anggota & grup
│   └── AttendanceLog.js     # Model Mongoose untuk log konfirmasi absensi
├── cronService.js           # Scheduler node-cron & logika mention otomatis
├── index.js                 # Entry point Express, MongoDB & WhatsApp Client
├── package.json             # Dependensi Node.js
├── whatsappService.js       # Handler event WhatsApp, !daftar & !sudah
├── .env.example             # Contoh variabel environment
└── README.md
```

---

## 🛠️ Instalasi & Pengujian Lokal

### 1. Prasyarat
* Node.js v18 atau v20 LTS
* Akun MongoDB Atlas (Free Tier M0)

### 2. Setup
1. Clone atau ekstrak proyek ini.
2. Pasang dependensi:
   ```bash
   npm install
   ```
3. Buat file `.env` dari `.env.example`:
   ```env
   MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/monev_bot?retryWrites=true&w=majority
   PORT=3000
   ```
4. Jalankan bot:
   ```bash
   npm start
   ```
5. Scan QR code yang muncul di terminal menggunakan WhatsApp Anda (**Linked Devices / Perangkat Tertaut**).

---

## ☁️ Panduan Deploy ke Cloud Gratis (Render / Koyeb)

### Render (Web Service)
1. **Push** repository ini ke GitHub / GitLab.
2. Buat Web Service baru di **Render Dashboard**.
3. Hubungkan repository Anda.
4. Atur konfigurasi:
   * **Runtime:** `Node`
   * **Build Command:** `npm install`
   * **Start Command:** `node index.js`
   * **Environment Variables:**
     * `MONGODB_URI`: Masukkan connection string MongoDB Atlas Anda.
     * Pastikan IP Whitelist di MongoDB Atlas diset `0.0.0.0/0` (Allow access from anywhere).
5. Pada deploy pertama, buka tab **Logs** di Render untuk memindai QR code via `qrcode-terminal`.
6. Setelah terhubung (*ready*), sesi akan tersimpan otomatis di database MongoDB Anda.

### Mencegah Server Sleep (Keep-Alive)
1. Buka [cron-job.org](https://cron-job.org) (gratis).
2. Buat Cronjob baru:
   * **URL:** `https://nama-aplikasi-anda.onrender.com/ping`
   * **Schedule:** Setiap **14 menit** (Every 14 minutes).
3. Hal ini akan menjaga server Render tetap aktif 24/7.

---

## 💬 Perintah Bot di Grup WhatsApp

### 📌 Menu Anggota (Bisa Digunakan Siapa Saja)
| Perintah | Deskripsi |
| :--- | :--- |
| `!halo` / `!bantuan` | Menampilkan pesan perkenalan bot dan menu bantuan. |
| `!daftar [Nama Lengkap]` | Mendaftarkan nomor WhatsApp Anda ke sistem pengingat grup. |
| `!sudah` | Mengonfirmasi absensi Monev Maganghub hari ini (*real-time progress*). |
| `!keluar` | Menghapus diri sendiri dari sistem bot jika masa magang telah selesai. |

### 🛡️ Menu Khusus Admin Grup (Dilindungi Hak Akses)
| Perintah | Hak Akses | Deskripsi |
| :--- | :--- | :--- |
| `!anggota` / `!list` | **Admin Grup** | Melihat rekap daftar seluruh anggota terdaftar & status absensi hari ini. |
| `!hapus [Nama / @Tag]` | **Admin Grup** | Menghapus anggota dari sistem pengingat grup. |
| `!test-reminder` | **Admin Grup** | Menjalankan simulasi pengingat langsung ke grup. |

