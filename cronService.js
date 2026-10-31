const cron = require('node-cron');
const User = require('./models/User');
const AttendanceLog = require('./models/AttendanceLog');

/**
 * Mendapatkan rentang waktu awal dan akhir hari ini dalam zona waktu Asia/Jakarta (WIB)
 */
function getJakartaDateRange() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  const dateStr = formatter.format(now); // format: YYYY-MM-DD

  const startOfDay = new Date(`${dateStr}T00:00:00+07:00`);
  const endOfDay = new Date(`${dateStr}T23:59:59.999+07:00`);

  return { startOfDay, endOfDay };
}

/**
 * Mendapatkan jam saat ini dalam zona waktu Asia/Jakarta (0-23)
 */
function getJakartaHour() {
  const formatter = new Intl.DateTimeFormat('id-ID', {
    hour: 'numeric',
    hour12: false,
    timeZone: 'Asia/Jakarta'
  });
  return parseInt(formatter.format(new Date()), 10);
}

/**
 * Inisialisasi cron scheduler untuk pengingat absensi Monev
 * Jadwal: Jam 16:00 sampai 23:00 setiap hari kerja (Senin - Jumat)
 * @param {any} sock Baileys socket client
 */
function startCronScheduler(sock) {
  // Pola cron: 0 16-23 * * 1-5 (Menit 0, jam 16-23, Senin-Jumat)
  const cronPattern = '0 16-23 * * 1-5';

  console.log(`⏰ Cron scheduler diaktifkan dengan pola: ${cronPattern} (Timezone: Asia/Jakarta)`);

  cron.schedule(
    cronPattern,
    async () => {
      try {
        await executeReminderJob(sock);
      } catch (error) {
        console.error('❌ Terjadi kesalahan pada cron reminder job:', error);
      }
    },
    {
      timezone: 'Asia/Jakarta'
    }
  );
}

/**
 * Format dan kirim pesan pengingat ke satu grup
 */
async function sendReminderToGroup(sock, groupId, users, currentHour) {
  const mentions = [];
  const mentionLines = [];

  for (const user of users) {
    const cleanNumber = (user.whatsappNumber || '').split('@')[0].replace(/[^0-9]/g, '');
    const userJid = `${cleanNumber}@s.whatsapp.net`;
    mentions.push(userJid);
    mentionLines.push(`• @${cleanNumber} (${user.name})`);
  }

  const mentionsText = mentionLines.join('\n');
  const portalUrl = 'https://monev.maganghub.kemnaker.go.id/dashboard';
  let reminderText = '';

  if (currentHour === 16) {
    reminderText =
      '📢 *PENGINGAT ABSENSI MONEV MAGANGHUB*\n\n' +
      'Halo teman-teman! Waktu menunjukkan pukul 16:00 WIB, saatnya absen Monev Maganghub hari ini.\n\n' +
      'Daftar anggota yang belum absen:\n' +
      `${mentionsText}\n\n` +
      `🌐 *Link Portal Monev:*\n${portalUrl}\n\n` +
      '👉 Segera lakukan absensi di portal Maganghub, lalu ketik *!sudah* di grup ini.';
  } else if (currentHour > 16 && currentHour < 23) {
    reminderText =
      '⚠️ *PENGINGAT BERKALA MONEV MAGANGHUB*\n\n' +
      `Pukul ${currentHour}:00 WIB — Anggota berikut terpantau *belum absen* Monev Maganghub:\n\n` +
      `${mentionsText}\n\n` +
      `🌐 *Link Portal Monev:*\n${portalUrl}\n\n` +
      '👉 Yuk luangkan waktu sebentar untuk absen, lalu balas dengan ketik *!sudah* di grup ini!';
  } else if (currentHour >= 23) {
    reminderText =
      '🚨 *PERINGATAN TERAKHIR (LAST CALL)!*\n\n' +
      'Panggilan terakhir untuk absen Monev Maganghub hari ini sebelum batas akhir!\n\n' +
      'Anggota yang belum konfirmasi:\n' +
      `${mentionsText}\n\n` +
      `🌐 *Link Portal Monev:*\n${portalUrl}\n\n` +
      '👉 Segera selesaikan absensi sekarang juga dan ketik *!sudah*!';
  } else {
    reminderText =
      '🔔 *PENGINGAT MONEV MAGANGHUB*\n\n' +
      'Daftar anggota yang belum melakukan absen:\n\n' +
      `${mentionsText}\n\n` +
      `🌐 *Link Portal Monev:*\n${portalUrl}\n\n` +
      '👉 Jangan lupa absen dan konfirmasi dengan ketik *!sudah*.';
  }

  try {
    await sock.sendMessage(groupId, {
      text: reminderText,
      mentions
    });
    console.log(`📨 Pengingat terkirim ke grup ${groupId} (${users.length} anggota dimention).`);
  } catch (sendError) {
    console.error(`❌ Gagal mengirim pesan ke grup ${groupId}:`, sendError.message);
  }
}

/**
 * Logika eksekusi pengingat absensi ke grup WhatsApp
 * @param {any} sock Baileys socket client
 * @param {string|null} targetGroupId - ID grup jika dipicu secara manual via !test-reminder
 */
async function executeReminderJob(sock, targetGroupId = null) {
  const currentHour = getJakartaHour();
  console.log(`\n🔔 Menjalankan pengingat absensi untuk jam: ${currentHour}:00 WIB ${targetGroupId ? `(Target Grup: ${targetGroupId})` : '(Semua Grup)'}`);

  const { startOfDay, endOfDay } = getJakartaDateRange();

  // 1. Dapatkan daftar user ID yang SUDAH absen hari ini
  const attendedUserIds = await AttendanceLog.distinct('user', {
    date: { $gte: startOfDay, $lte: endOfDay }
  });

  // Kasus jika dipicu secara manual pada grup tertentu (!test-reminder)
  if (targetGroupId) {
    const totalUsersInGroup = await User.find({ groupId: targetGroupId, isActive: true });

    if (totalUsersInGroup.length === 0) {
      await sock.sendMessage(targetGroupId, {
        text: 'ℹ️ Belum ada anggota yang terdaftar aktif di grup ini.\nSilakan anggota mendaftar terlebih dahulu dengan mengetik:\n*!daftar [Nama Lengkap]*'
      });
      return;
    }

    const uncompletedInGroup = totalUsersInGroup.filter(
      (u) => !attendedUserIds.some((id) => id.toString() === u._id.toString())
    );

    // Jika SEMUA anggota di grup ini SUDAH absen
    if (uncompletedInGroup.length === 0) {
      const total = totalUsersInGroup.length;
      const allClearText =
        '🎉 *Mantap Gaiss! Semua Sudah Absen!*\n\n' +
        `Seluruh anggota yang terdaftar di grup ini (*${total}/${total}* orang) terpantau *sudah menyelesaikan absen* Monev Maganghub hari ini.\n\n` +
        '✨ Tidak ada yang perlu diingatkan lagi kecuali ibadah';
      await sock.sendMessage(targetGroupId, { text: allClearText });
      console.log(`✨ Semua anggota di grup ${targetGroupId} sudah absen hari ini. Pesan konfirmasi sukses terkirim.`);
      return;
    }

    // Jika masih ada yang belum absen di grup ini
    await sendReminderToGroup(sock, targetGroupId, uncompletedInGroup, currentHour);
    return;
  }

  // Kasus jika dipicu otomatis oleh Cron Scheduler untuk seluruh grup
  const uncompletedUsers = await User.find({
    isActive: true,
    _id: { $nin: attendedUserIds }
  });

  if (uncompletedUsers.length === 0) {
    console.log('✨ Semua anggota di seluruh grup telah absen hari ini. Tidak ada pesan dikirim.');
    return;
  }

  // Kelompokkan sisa User berdasarkan groupId
  const groupedByGroup = {};
  for (const user of uncompletedUsers) {
    if (!groupedByGroup[user.groupId]) {
      groupedByGroup[user.groupId] = [];
    }
    groupedByGroup[user.groupId].push(user);
  }

  // Loop setiap grup dan kirim pesan pengingat
  for (const [groupId, users] of Object.entries(groupedByGroup)) {
    if (!users || users.length === 0) continue;
    await sendReminderToGroup(sock, groupId, users, currentHour);
  }
}

module.exports = {
  startCronScheduler,
  executeReminderJob,
  getJakartaDateRange,
  getJakartaHour
};
