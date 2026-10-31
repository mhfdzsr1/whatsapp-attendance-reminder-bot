# 🤖 WhatsApp Attendance Reminder Bot

[![Node.js Version](https://img.shields.io/badge/Node.js-20.x-green.svg)](https://nodejs.org/)
[![Engine](https://img.shields.io/badge/Engine-Baileys%20WebSocket-blue.svg)](https://github.com/WhiskeySockets/Baileys)
[![Database](https://img.shields.io/badge/Database-MongoDB%20Atlas-brightgreen.svg)](https://www.mongodb.com/atlas)
[![Deployment](https://img.shields.io/badge/Cloud-Render%20Free%20Tier-success.svg)](https://render.com/)
[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

An automated, ultra-lightweight **WhatsApp Attendance Reminder Bot** built for teams, internship groups, and organizations. Designed specifically to run **24/7 on 100% Free Cloud Tier (Render)** without running into memory limits (*Zero-Chromium / ~50 MB RAM*).

---

## ✨ Features

- ⚡ **Zero-Chromium Architecture:** Powered by [`@whiskeysockets/baileys`](https://github.com/WhiskeySockets/Baileys) directly connecting via WebSockets. Uses only **~40–60 MB RAM** (vs 500+ MB in Puppeteer/Chromium), completely preventing Out-Of-Memory (OOM) crashes on 512 MB cloud tiers.
- 💾 **Persistent Session in MongoDB Atlas:** Automatically syncs WhatsApp multi-device credentials to MongoDB Atlas, ensuring seamless session recovery across container restarts or redeploys without needing to re-scan QR codes.
- ⏰ **Automated Hourly Cron Scheduler:** Sends periodic reminders on workdays (Monday–Friday from 16:00 to 23:00) with dynamic escalation (First Reminder → Hourly Alerts → Last Call).
- 🏷️ **Intelligent Group Mentions:** Automatically tags (`@mention`) only members who have **not yet** confirmed their daily attendance.
- 🎉 **All-Clear Group Notification:** Automatically congratulates the group when all registered members have completed their attendance for the day.
- 📊 **Visual Web Dashboard (`/anggota`):** Real-time web table displaying member list, status, and completion progress.
- 📷 **Live Web QR Scanner (`/qr`):** Browser-accessible QR code display for easy pairing from any smartphone or laptop.
- 🛡️ **Role-Based Admin Access:** Admin-only commands (`!anggota`, `!hapus`, `!test-reminder`) with verification against WhatsApp group admin roles and `.env` master admins.

---

## 💬 WhatsApp Group Commands

### 📌 Member Commands
| Command | Description | Example |
|---|---|---|
| `!daftar [Full Name]` | Register phone number into the attendance system | `!daftar Budi Santoso` |
| `!sudah` | Confirm daily attendance completion | `!sudah` |
| `!keluar` | Unregister oneself from the reminder system | `!keluar` |
| `!halo` or `!bantuan` | Show introduction and list of available commands | `!bantuan` |

### 🛡️ Admin Commands
| Command | Permission | Description |
|---|---|---|
| `!anggota` | Group Admin / Master | Display list of registered members & today's attendance status |
| `!test-reminder` | Group Admin / Master | Instantly trigger a reminder simulation in the group |
| `!hapus [Name/@tag]` | Group Admin / Master | Remove a member from the group database |

---

## 📁 Project Structure

```text
├── models/
│   ├── User.js             # Mongoose schema for registered members & groups
│   └── AttendanceLog.js    # Mongoose schema for daily attendance records
├── cronService.js          # Scheduled node-cron jobs & reminder dispatch logic
├── index.js                # Express web server, Baileys socket & endpoint handlers
├── mongoAuth.js            # MongoDB sync layer for Baileys MultiFileAuthState
├── whatsappService.js      # WhatsApp message parser & command handling
├── Dockerfile              # Production Dockerfile (node:20-bookworm-slim)
├── .env.example            # Environment variables template
└── README.md
```

---

## 🚀 Getting Started

### 1. Prerequisites
- [Node.js](https://nodejs.org/) v18 or v20 LTS
- Free [MongoDB Atlas](https://www.mongodb.com/atlas) Cluster (M0 Free Tier)

### 2. Local Installation
```bash
# 1. Clone this repository
git clone https://github.com/mhfdzsr1/whatsapp-attendance-reminder-bot.git
cd whatsapp-attendance-reminder-bot

# 2. Install dependencies
npm install

# 3. Configure environment variables
cp .env.example .env
```

Edit your `.env` file:
```env
MONGODB_URI=mongodb+srv://<username>:<password>@cluster0.xxxxx.mongodb.net/attendance_bot?retryWrites=true&w=majority
PORT=3000
ADMIN_NUMBERS=628123456789
ATTENDANCE_PORTAL_URL=https://portal-absensi-anda.com
```

### 3. Run Locally
```bash
npm start
```
Scan the terminal QR code or visit `http://localhost:3000/qr` using **WhatsApp > Linked Devices > Link a Device**.

---

## ☁️ Free 24/7 Cloud Deployment (Render)

1. **Push to GitHub:** Push this codebase to your own GitHub repository.
2. **Create Web Service on Render:**
   - Connect your GitHub repository.
   - Choose **Docker** runtime.
   - Set Instance Type: **Free (512 MB RAM)**.
   - Set Port: `10000`.
   - Add Environment Variables:
     - `MONGODB_URI`: Your MongoDB Atlas connection string.
     - `ADMIN_NUMBERS`: Your WhatsApp number in international format (e.g. `628123456789`).
     - `ATTENDANCE_PORTAL_URL`: (Optional) Your organization's portal URL.
3. **Scan QR Code:**
   - Once deployed, visit `https://your-service.onrender.com/qr` to link your WhatsApp account.
4. **Setup 24/7 Keep-Alive (Prevent Idle Sleep):**
   - Render Free Tier spins down after 15 minutes of inactivity.
   - Create a free job on [cron-job.org](https://cron-job.org):
     - **URL:** `https://your-service.onrender.com/ping`
     - **Schedule:** Every **10 minutes**
   - This keeps your bot alive and active around the clock at $0 cost!

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
