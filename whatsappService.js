const User = require('./models/User');
const AttendanceLog = require('./models/AttendanceLog');
const { getJakartaDateRange, executeReminderJob } = require('./cronService');

/**
 * Format nomor WhatsApp pengirim untuk keperluan mention dalam teks
 * Contoh: 628123456789@s.whatsapp.net -> @628123456789
 */
function getMentionHandle(whatsappNumber) {
  const cleanId = (whatsappNumber || '').split('@')[0].replace(/[^0-9]/g, '');
  return `@${cleanId}`;
}

/**
 * Mengonversi nomor WhatsApp ke format JID Baileys (xxx@s.whatsapp.net)
 */
function toBaileysJid(whatsappNumber) {
  if (!whatsappNumber) return '';
  const clean = whatsappNumber.split('@')[0].replace(/[^0-9]/g, '');
  return `${clean}@s.whatsapp.net`;
}

/**
 * Mengecek apakah pengirim pesan adalah Admin di grup WhatsApp atau ada di ADMIN_NUMBERS .env
 */
async function isSenderAdmin(sock, chatId, senderJid) {
  try {
    const cleanSender = senderJid.split('@')[0].replace(/[^0-9]/g, '');

    // 1. Cek dari daftar ADMIN_NUMBERS di file .env
    const envAdmins = (process.env.ADMIN_NUMBERS || '')
      .split(',')
      .map((n) => n.trim().replace(/[^0-9]/g, ''))
      .filter((n) => n.length > 0);

    if (envAdmins.some((admin) => cleanSender === admin || cleanSender.endsWith(admin))) {
      console.log(`🔑 [Admin Check] Akses diizinkan: Cocok dengan ADMIN_NUMBERS di .env (${cleanSender})`);
      return true;
    }

    // 2. Cek metadata grup WhatsApp jika berada di dalam grup
    if (chatId.endsWith('@g.us')) {
      const groupMetadata = await sock.groupMetadata(chatId);
      const participant = groupMetadata.participants.find((p) => {
        const cleanP = p.id.split('@')[0].replace(/[^0-9]/g, '');
        return cleanP === cleanSender;
      });

      if (participant && (participant.admin === 'admin' || participant.admin === 'superadmin')) {
        console.log(`🔑 [Admin Check] Akses diizinkan: Admin grup (${cleanSender})`);
        return true;
      }
    }
  } catch (err) {
    console.warn('⚠️ Gagal memeriksa status admin:', err.message);
  }

  return false;
}

/**
 * Teks perkenalan resmi bot
 */
function getIntroductionMessage() {
  return (
    '👋 *Halo Gaiss! Salam kenal!*\n\n' +
    'Saya adalah *Bot Pengingat Monev Maganghub Dit.PDLKWS (Unofficial)*, asisten virtual yang bertugas membantu teman-teman di grup ini agar tidak terlewat melakukan absensi harian di Monev Maganghub.\n\n' +
    '✨ *Fungsi Utama Saya:*\n' +
    '• Mengingatkan secara otomatis anggota grup yang belum absen secara berkala pada hari kerja (Senin–Jumat pukul 16:00 s.d. 23:00 WIB).\n' +
    '• Memantau progres absensi secara real-time.\n' +
    '• Memberikan informasi otomatis saat seluruh anggota kelompok sudah melakukan absensi harian.\n\n' +
    '📌 *Menu Perintah Peserta:*\n' +
    '1. *!daftar [Nama Lengkap]*\n' +
    '   👉 Daftarkan nomor Anda agar dikenali bot.\n' +
    '   Contoh: `!daftar Adit Suditya`\n\n' +
    '2. *!sudah*\n' +
    '   👉 Konfirmasikan setelah Anda selesai absen di website Maganghub hari ini.\n\n' +
    '3. *!keluar*\n' +
    '   👉 Hapus diri sendiri dari bot jika masa magang telah selesai.\n\n' +
    '4. *!bantuan* atau *!halo*\n' +
    '   👉 Menampilkan kembali pesan panduan & menu perintah ini.\n\n' +
    '🛡️ *Menu Khusus Admin Grup:*\n' +
    '1. *!anggota*\n' +
    '   👉 Rekap daftar seluruh anggota terdaftar & status absen hari ini.\n\n' +
    '2. *!hapus [Nama/@Tag]*\n' +
    '   👉 Menghapus anggota dari sistem pengingat grup.\n\n' +
    '3. *!test-reminder*\n' +
    '   👉 Menjalankan simulasi pengecekan/pengingat absensi langsung.\n\n' +
    '💡 *Langkah Awal:* Silakan semua anggota grup mendaftarkan diri dengan mengetik *!daftar [Nama]* sekarang ya! Semangat magangnya gaiss! 🚀'
  );
}

/**
 * Memproses pesan teks yang masuk
 */
async function handleMessage(sock, msg) {
  if (!msg.message) return;

  const chatId = msg.key.remoteJid;
  if (!chatId) return;

  const isGroup = chatId.endsWith('@g.us');
  const senderJid = isGroup ? (msg.key.participant || msg.participant) : chatId;
  if (!senderJid) return;

  // Ekstrak pesan teks (mendukung text biasa, extended text, atau caption)
  const body = (
    msg.message.conversation ||
    msg.message.extendedTextMessage?.text ||
    msg.message.imageMessage?.caption ||
    ''
  ).trim();

  if (!body.startsWith('!')) return;

  console.log(`📩 Perintah diterima di ${chatId}: "${body}" dari ${senderJid}`);

  // 1. Perintah !halo / !bantuan
  if (['!halo', '!bantuan', '!help', '!perkenalan', '!intro'].includes(body.toLowerCase())) {
    await sock.sendMessage(chatId, { text: getIntroductionMessage() }, { quoted: msg });
    return;
  }

  // 2. Perintah !test-reminder
  if (body.toLowerCase() === '!test-reminder' || body.toLowerCase() === '!ingatkan') {
    if (!isGroup) {
      await sock.sendMessage(chatId, { text: '⚠️ Perintah ini hanya bisa digunakan di dalam grup.' }, { quoted: msg });
      return;
    }

    const isAdmin = await isSenderAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      await sock.sendMessage(
        chatId,
        { text: '⛔ *Akses Ditolak!*\n\nPerintah `!test-reminder` hanya dapat dijalankan oleh *Admin Grup*.' },
        { quoted: msg }
      );
      return;
    }

    console.log(`⚡ [Admin] Menjalankan pengingat manual di grup ${chatId}...`);
    await executeReminderJob(sock, chatId);
    return;
  }

  // 3. Perintah !anggota
  if (['!anggota', '!list', '!daftar-anggota'].includes(body.toLowerCase())) {
    if (!isGroup) {
      await sock.sendMessage(chatId, { text: '⚠️ Perintah ini hanya bisa digunakan di dalam grup.' }, { quoted: msg });
      return;
    }

    const isAdmin = await isSenderAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      await sock.sendMessage(
        chatId,
        { text: '⛔ *Akses Ditolak!*\n\nPerintah `!anggota` hanya dapat diakses oleh *Admin Grup*.' },
        { quoted: msg }
      );
      return;
    }

    const users = await User.find({ groupId: chatId, isActive: true }).sort({ name: 1 });
    if (users.length === 0) {
      await sock.sendMessage(
        chatId,
        { text: '📋 *DAFTAR ANGGOTA MONEV*\n\nBelum ada anggota yang terdaftar di grup ini.\nSilakan mendaftar dengan ketik:\n*!daftar [Nama Lengkap]*' },
        { quoted: msg }
      );
      return;
    }

    const { startOfDay, endOfDay } = getJakartaDateRange();
    const userIds = users.map((u) => u._id);
    const attendedUserIds = await AttendanceLog.distinct('user', {
      user: { $in: userIds },
      date: { $gte: startOfDay, $lte: endOfDay }
    });
    const attendedSet = new Set(attendedUserIds.map((id) => id.toString()));

    let text = `📋 *DAFTAR ANGGOTA MONEV TERDAFTAR (ADMIN)*\nTotal: *${users.length}* Orang\n\n`;
    users.forEach((u, idx) => {
      const isAttended = attendedSet.has(u._id.toString());
      const statusIcon = isAttended ? '✅ Sudah Absen' : '⏳ Belum Absen';
      const cleanNum = (u.whatsappNumber || '').split('@')[0].replace(/[^0-9]/g, '');
      text += `${idx + 1}. *${u.name}* (@${cleanNum}) — ${statusIcon}\n`;
    });

    const attendedCount = attendedSet.size;
    text += `\n📊 *Progres Hari Ini:* ${attendedCount}/${users.length} anggota sudah absen.`;
    text += '\n\n💡 *Tips Admin:* Ketik *!hapus [Nama]* untuk menghapus anggota dari daftar.';

    await sock.sendMessage(chatId, { text }, { quoted: msg });
    return;
  }

  // 4. Perintah !hapus [Nama / Tag]
  if (body.startsWith('!hapus')) {
    if (!isGroup) {
      await sock.sendMessage(chatId, { text: '⚠️ Perintah ini hanya bisa digunakan di dalam grup.' }, { quoted: msg });
      return;
    }

    const isAdmin = await isSenderAdmin(sock, chatId, senderJid);
    if (!isAdmin) {
      await sock.sendMessage(
        chatId,
        { text: '⛔ *Akses Ditolak!*\n\nPerintah `!hapus` hanya dapat dijalankan oleh *Admin Grup*.' },
        { quoted: msg }
      );
      return;
    }

    const targetQuery = body.replace('!hapus', '').trim();
    let targetUser = null;

    // Cek apakah ada mention di pesan
    const mentionedJids = msg.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
    if (mentionedJids.length > 0) {
      const cleanMention = mentionedJids[0].split('@')[0].replace(/[^0-9]/g, '');
      targetUser = await User.findOne({
        groupId: chatId,
        whatsappNumber: { $regex: cleanMention }
      });
    }

    // Jika tidak mention, cari nama
    if (!targetUser && targetQuery) {
      targetUser = await User.findOne({
        groupId: chatId,
        name: { $regex: new RegExp(`^${targetQuery}$`, 'i') }
      });

      if (!targetUser) {
        targetUser = await User.findOne({
          groupId: chatId,
          name: { $regex: new RegExp(targetQuery, 'i') }
        });
      }
    }

    if (!targetUser) {
      await sock.sendMessage(
        chatId,
        {
          text: '⚠️ Anggota tidak ditemukan!\n\nCara penggunaan:\n• *!hapus @tag_orangnya*\n• *!hapus [Nama Lengkap]* (Contoh: `!hapus Budi Santoso`)\n\nKetik *!anggota* untuk melihat daftar.'
        },
        { quoted: msg }
      );
      return;
    }

    const removedName = targetUser.name;
    const removedId = targetUser._id;

    await User.deleteOne({ _id: removedId });
    await AttendanceLog.deleteMany({ user: removedId });

    await sock.sendMessage(
      chatId,
      { text: `✅ Anggota *${removedName}* berhasil dihapus dari sistem pengingat grup ini.` },
      { quoted: msg }
    );
    return;
  }

  // 5. Perintah !daftar [Nama]
  if (body.startsWith('!daftar')) {
    if (!isGroup) {
      await sock.sendMessage(chatId, { text: '⚠️ Perintah ini harus dijalankan di dalam grup WhatsApp Magangers.' }, { quoted: msg });
      return;
    }

    const name = body.replace('!daftar', '').trim();
    if (!name) {
      await sock.sendMessage(
        chatId,
        { text: '⚠️ Format salah! Gunakan: *!daftar [Nama Lengkap]*\nContoh: *!daftar Budi Santoso*' },
        { quoted: msg }
      );
      return;
    }

    const cleanSender = senderJid.split('@')[0].replace(/[^0-9]/g, '');
    const userJid = `${cleanSender}@s.whatsapp.net`;

    const existingUser = await User.findOne({
      whatsappNumber: { $regex: cleanSender }
    });

    if (existingUser) {
      existingUser.whatsappNumber = userJid;
      if (existingUser.groupId !== chatId || !existingUser.isActive) {
        existingUser.groupId = chatId;
        existingUser.name = name;
        existingUser.isActive = true;
        await existingUser.save();
        await sock.sendMessage(
          chatId,
          {
            text: `${getMentionHandle(userJid)} Data pendaftaranmu berhasil diperbarui untuk grup ini!`,
            mentions: [userJid]
          },
          { quoted: msg }
        );
        return;
      }

      existingUser.name = name;
      await existingUser.save();
      await sock.sendMessage(
        chatId,
        {
          text: `${getMentionHandle(userJid)} Kamu sudah terdaftar sebelumnya dengan nama *${existingUser.name}* di grup ini.`,
          mentions: [userJid]
        },
        { quoted: msg }
      );
      return;
    }

    // Daftarkan user baru
    await User.create({
      name,
      whatsappNumber: userJid,
      groupId: chatId,
      isActive: true
    });

    await sock.sendMessage(
      chatId,
      {
        text: `${getMentionHandle(userJid)} Berhasil terdaftar! Sistem akan mengingatkanmu di grup ini jika belum absen Monev.`,
        mentions: [userJid]
      },
      { quoted: msg }
    );
    return;
  }

  // 6. Perintah !sudah
  if (body.toLowerCase() === '!sudah') {
    if (!isGroup) {
      await sock.sendMessage(chatId, { text: '⚠️ Konfirmasi absen harus dilakukan di grup WhatsApp.' }, { quoted: msg });
      return;
    }

    const cleanSender = senderJid.split('@')[0].replace(/[^0-9]/g, '');
    const userJid = `${cleanSender}@s.whatsapp.net`;

    const user = await User.findOne({
      whatsappNumber: { $regex: cleanSender }
    });

    if (!user) {
      await sock.sendMessage(
        chatId,
        {
          text: `${getMentionHandle(userJid)} Kamu belum terdaftar dalam sistem bot. Silakan daftar terlebih dahulu dengan ketik:\n*!daftar [Nama]*`,
          mentions: [userJid]
        },
        { quoted: msg }
      );
      return;
    }

    // Perbarui format nomor jika sebelumnya tersimpan beda
    if (user.whatsappNumber !== userJid) {
      user.whatsappNumber = userJid;
      await user.save();
    }

    const { startOfDay, endOfDay } = getJakartaDateRange();

    const existingLog = await AttendanceLog.findOne({
      user: user._id,
      date: { $gte: startOfDay, $lte: endOfDay }
    });

    if (existingLog) {
      await sock.sendMessage(
        chatId,
        {
          text: `${getMentionHandle(userJid)} Kamu sudah mengonfirmasi absen Monev untuk hari ini. Terima kasih! 👍`,
          mentions: [userJid]
        },
        { quoted: msg }
      );
      return;
    }

    // Buat log absensi hari ini
    await AttendanceLog.create({
      user: user._id,
      date: new Date(),
      status: 'confirmed'
    });

    // Cek status grup
    const activeUsersInGroup = await User.find({
      groupId: chatId,
      isActive: true
    });

    const totalActiveCount = activeUsersInGroup.length;
    const userIdsInGroup = activeUsersInGroup.map((u) => u._id);

    const distinctAttendedToday = await AttendanceLog.distinct('user', {
      user: { $in: userIdsInGroup },
      date: { $gte: startOfDay, $lte: endOfDay }
    });

    const completedCount = distinctAttendedToday.length;

    if (totalActiveCount > 0 && completedCount >= totalActiveCount) {
      const allClearMessage =
        '🎉 Mantap Gaiss! Semua anggota grup Magangers sudah absen Monev Maganghub hari ini.\n\n' +
        'Tetap semangat gaiss! Rezeki yang sudah tertakar, tidak mungkin tertukar. ✨';
      await sock.sendMessage(chatId, { text: allClearMessage });
    } else {
      const remaining = Math.max(0, totalActiveCount - completedCount);
      const ackMessage =
        `${getMentionHandle(userJid)} Absen Monev kamu hari ini berhasil dicatat! ✅\n` +
        `📊 Progress grup: *${completedCount}/${totalActiveCount}* anggota sudah absen (${remaining} orang lagi).`;
      await sock.sendMessage(chatId, { text: ackMessage, mentions: [userJid] }, { quoted: msg });
    }
    return;
  }

  // 7. Perintah !keluar
  if (body.toLowerCase() === '!keluar' || body.toLowerCase() === '!unregister') {
    if (!isGroup) {
      await sock.sendMessage(chatId, { text: '⚠️ Perintah ini hanya bisa digunakan di dalam grup.' }, { quoted: msg });
      return;
    }

    const cleanSender = senderJid.split('@')[0].replace(/[^0-9]/g, '');
    const userJid = `${cleanSender}@s.whatsapp.net`;

    const user = await User.findOne({
      groupId: chatId,
      whatsappNumber: { $regex: cleanSender }
    });

    if (!user) {
      await sock.sendMessage(
        chatId,
        {
          text: `${getMentionHandle(userJid)} Kamu belum terdaftar dalam sistem bot di grup ini.`,
          mentions: [userJid]
        },
        { quoted: msg }
      );
      return;
    }

    const removedName = user.name;
    await User.deleteOne({ _id: user._id });
    await AttendanceLog.deleteMany({ user: user._id });

    await sock.sendMessage(
      chatId,
      { text: `✅ *${removedName}* telah berhasil keluar dan dihapus dari sistem pengingat grup ini.` },
      { quoted: msg }
    );
    return;
  }
}

module.exports = {
  handleMessage,
  getIntroductionMessage,
  toBaileysJid
};
