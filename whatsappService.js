const qrcode = require('qrcode-terminal');
const User = require('./models/User');
const AttendanceLog = require('./models/AttendanceLog');
const { getJakartaDateRange, executeReminderJob } = require('./cronService');

/**
 * Format nomor WhatsApp pengirim untuk keperluan mention dalam teks
 * Memotong akhiran @c.us maupun @lid agar mention WhatsApp berfungsi sempurna
 * Contoh: 628123456789@c.us -> @628123456789
 * Contoh: 82300331135097@lid -> @82300331135097
 */
function getMentionHandle(whatsappNumber) {
  const cleanId = (whatsappNumber || '').split('@')[0];
  return `@${cleanId}`;
}

/**
 * Mengonversi ID pengirim (baik @lid maupun @c.us) ke format nomor telepon asli (@c.us) jika memungkinkan
 * Menggunakan timeout 2.5 detik agar tidak pernah menahan pemrosesan pesan
 * @param {import('whatsapp-web.js').Client} client
 * @param {string} rawId
 * @returns {Promise<string>} Format nomor WhatsApp (contoh: 628xxx@c.us) atau fallback ke rawId jika tidak ditemukan
 */
async function resolvePhoneNumber(client, rawId) {
  if (!rawId) return rawId;
  if (rawId.endsWith('@c.us')) return rawId;

  const resolveLogic = async () => {
    // 1. Coba resolusi melalui getContactLidAndPhone
    try {
      if (typeof client.getContactLidAndPhone === 'function') {
        const results = await client.getContactLidAndPhone([rawId]);
        if (results && results[0] && results[0].pn) {
          console.log(`🔍 Terdeteksi nomor asli dari LID ${rawId} -> ${results[0].pn}`);
          return results[0].pn;
        }
      }
    } catch (err) {
      // Abaikan jika gagal
    }

    // 2. Coba fallback melalui getContactById
    try {
      const contact = await client.getContactById(rawId);
      if (contact && contact.id && contact.id._serialized && contact.id._serialized.endsWith('@c.us')) {
        return contact.id._serialized;
      }
      if (contact && contact.id && contact.id.user && !contact.id.user.includes('@')) {
        return `${contact.id.user}@c.us`;
      }
      if (contact && contact.number) {
        return `${contact.number}@c.us`;
      }
    } catch (err) {
      // Abaikan jika gagal
    }

    return rawId;
  };

  try {
    const timeout = new Promise((resolve) => setTimeout(() => resolve(rawId), 2500));
    return await Promise.race([resolveLogic(), timeout]);
  } catch (e) {
    return rawId;
  }
}

/**
 * Mengecek apakah pengirim pesan adalah Admin di grup WhatsApp atau akun Bot itu sendiri
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 * @param {string} chatId
 * @param {string} rawSenderId
 * @returns {Promise<boolean>}
 */
async function isSenderAdmin(client, message, chatId, rawSenderId) {
  try {
    // 1. Jika dikirim dari akun bot itu sendiri (fromMe)
    if (message.fromMe) {
      console.log('🔑 [Admin Check] Akses diizinkan: Pesan berasal dari akun Bot sendiri (fromMe).');
      return true;
    }

    // Resolusi nomor pengirim (mengatasi multi-device @lid vs @c.us)
    let contactNumber = '';
    let contactSerialized = '';
    try {
      const contact = await message.getContact();
      if (contact) {
        contactNumber = contact.number || (contact.id && contact.id.user) || '';
        contactSerialized = (contact.id && contact.id._serialized) || '';
      }
    } catch (e) {
      // Abaikan jika getContact gagal
    }

    let resolvedId = rawSenderId;
    try {
      resolvedId = await resolvePhoneNumber(client, rawSenderId);
    } catch (e) {
      // Abaikan
    }

    const cleanRaw = (rawSenderId || '').replace(/[^0-9]/g, '');
    const cleanResolved = (resolvedId || '').replace(/[^0-9]/g, '');
    const cleanContact = (contactNumber || '').replace(/[^0-9]/g, '');
    const cleanContactSer = (contactSerialized || '').replace(/[^0-9]/g, '');

    console.log(
      `🔍 [Admin Check] Memeriksa pengirim: rawSenderId="${rawSenderId}", resolvedId="${resolvedId}", contactNum="${contactNumber}", contactJid="${contactSerialized}"`
    );

    // 2. Cek apakah nomor pengirim terdaftar di variabel ADMIN_NUMBERS pada file .env (SuperAdmin)
    const envAdmins = (process.env.ADMIN_NUMBERS || '')
      .split(',')
      .map((s) => s.trim().replace(/[^0-9]/g, ''))
      .filter(Boolean);

    if (envAdmins.length > 0) {
      const isEnvAdmin = envAdmins.some((adminNum) => {
        return (
          (cleanContact && (cleanContact.endsWith(adminNum) || adminNum.endsWith(cleanContact))) ||
          (cleanContactSer && (cleanContactSer.endsWith(adminNum) || adminNum.endsWith(cleanContactSer))) ||
          (cleanResolved && (cleanResolved.endsWith(adminNum) || adminNum.endsWith(cleanResolved))) ||
          (cleanRaw && (cleanRaw.endsWith(adminNum) || adminNum.endsWith(cleanRaw)))
        );
      });

      if (isEnvAdmin) {
        console.log(`🔑 [Admin Check] Akses diizinkan: Pengirim cocok dengan ADMIN_NUMBERS di .env`);
        return true;
      }
    }

    // 3. Verifikasi role admin langsung dari metadata grup WhatsApp
    if (chatId && chatId.endsWith('@g.us')) {
      const chat = await message.getChat();
      if (chat && chat.isGroup && Array.isArray(chat.participants)) {
        // Cari seluruh peserta yang berstatus admin di grup
        const adminParticipants = chat.participants.filter(
          (p) =>
            p.isAdmin === true ||
            p.isSuperAdmin === true ||
            p.admin === 'admin' ||
            p.admin === 'superadmin' ||
            p.role === 'admin' ||
            p.role === 'superadmin'
        );

        console.log(`👥 [Admin Check] Jumlah total peserta grup: ${chat.participants.length}, Admin ditemukan: ${adminParticipants.length}`);

        // Cek apakah pengirim cocok dengan salah satu admin grup
        for (const admin of adminParticipants) {
          const adminId = (admin.id && admin.id._serialized) || (typeof admin.id === 'string' ? admin.id : '');
          const adminUser = (admin.id && admin.id.user) || '';
          const cleanAdmin = adminId.replace(/[^0-9]/g, '');
          const cleanAdminUser = adminUser.replace(/[^0-9]/g, '');

          const matches =
            adminId === rawSenderId ||
            adminId === resolvedId ||
            adminId === contactSerialized ||
            (cleanAdminUser && (cleanAdminUser === cleanContact || cleanAdminUser === cleanResolved || cleanAdminUser === cleanRaw)) ||
            (cleanAdmin && (
              (cleanContact && cleanAdmin.endsWith(cleanContact)) ||
              (cleanResolved && cleanAdmin.endsWith(cleanResolved)) ||
              (cleanRaw && cleanAdmin.endsWith(cleanRaw))
            ));

          if (matches) {
            console.log(`🔑 [Admin Check] Akses diizinkan: Pengirim cocok dengan Admin Grup (${adminId})`);
            return true;
          }
        }
      }
    }
  } catch (err) {
    console.warn('❌ Gagal memverifikasi status admin pengirim:', err.message);
  }

  console.warn(`⛔ [Admin Check] Akses ditolak untuk rawSenderId="${rawSenderId}"`);
  return false;
}

/**
 * Teks perkenalan resmi bot mengenai identitas dan fungsinya
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
 * Setup seluruh event listener untuk WhatsApp Client
 * @param {import('whatsapp-web.js').Client} client
 */
function registerWhatsAppEvents(client) {
  // QR Code generation
  client.on('qr', (qr) => {
    console.log('\n======================================================');
    console.log('⚡ QR Code diterima. Pindai menggunakan WhatsApp Anda:');
    console.log('======================================================\n');
    qrcode.generate(qr, { small: true });
    console.log('📱 Bisa scan langsung dari kotak QR terminal di atas atau buka:');
    console.log('👉 https://wa-bot-monev-maganghub-reminder.onrender.com/screenshot\n');
  });

  // Status loading WhatsApp Web
  client.on('loading_screen', (percent, message) => {
    console.log(`⏳ Memuat WhatsApp Web: ${percent}% - ${message}`);
  });

  // Perubahan status koneksi
  client.on('change_state', (state) => {
    console.log(`🔄 Status Koneksi WhatsApp: ${state}`);
  });

  // Client berhasil terautentikasi
  client.on('authenticated', () => {
    console.log('✅ Autentikasi WhatsApp Web berhasil!');
  });

  // Sesi berhasil disimpan ke MongoDB oleh RemoteAuth
  client.on('remote_session_saved', () => {
    console.log('💾 Sesi WhatsApp berhasil disimpan ke MongoDB Atlas (RemoteAuth).');
  });

  // Client siap digunakan
  client.on('ready', () => {
    console.log('🚀 WhatsApp Client siap dan aktif!');
  });

  // Gagal autentikasi
  client.on('auth_failure', (msg) => {
    console.error('❌ Gagal autentikasi WhatsApp:', msg);
  });

  // Terputus
  client.on('disconnected', (reason) => {
    console.warn('⚠️ WhatsApp client terputus:', reason);
  });

  // Event otomatis saat bot baru di-invite / bergabung ke dalam grup
  client.on('group_join', async (notification) => {
    try {
      const myId = client.info && client.info.wid ? client.info.wid._serialized : null;
      const isBotAdded = notification.recipientIds && myId && notification.recipientIds.includes(myId);

      // Jika yang baru masuk grup adalah bot itu sendiri
      if (isBotAdded) {
        console.log(`🎉 Bot baru saja diundang ke grup: ${notification.chatId}. Mengirim pesan perkenalan...`);
        const welcomeMessage = getIntroductionMessage();
        await client.sendMessage(notification.chatId, welcomeMessage);
      }
    } catch (err) {
      console.error('Error saat menangani event group_join:', err.message);
    }
  });

  // Listener pesan masuk dari orang lain
  client.on('message', async (message) => {
    try {
      await handleIncomingMessage(client, message);
    } catch (err) {
      console.error('Error saat memproses pesan masuk:', err);
    }
  });

  // Listener pesan yang dikirim dari akun bot sendiri (agar testing dari nomor sendiri juga berfungsi)
  client.on('message_create', async (message) => {
    if (message.fromMe) {
      try {
        await handleIncomingMessage(client, message);
      } catch (err) {
        console.error('Error saat memproses pesan fromMe:', err);
      }
    }
  });
}

/**
 * Memproses pesan masuk dari pengguna/grup
 * @param {import('whatsapp-web.js').Client} client
 * @param {import('whatsapp-web.js').Message} message
 */
async function handleIncomingMessage(client, message) {
  const body = (message.body || '').trim();
  if (!body.startsWith('!')) return;

  const chatId = message.from; // ID grup atau chat (contoh: 12345xxx@g.us)
  const isGroup = chatId.endsWith('@g.us');
  const rawSenderId = message.author || message.from; // ID pengirim mentah (bisa @c.us atau @lid)

  console.log(`📩 Perintah diterima di ${chatId}: "${body}" dari ${rawSenderId}`);

  // Perintah perkenalan & bantuan (instan tanpa perlu resolusi nomor)
  if (['!halo', '!bantuan', '!help', '!perkenalan', '!intro'].includes(body.toLowerCase())) {
    await client.sendMessage(chatId, getIntroductionMessage());
    return;
  }

  // Perintah uji coba pengingat langsung (khusus Admin Grup)
  if (body.toLowerCase() === '!test-reminder' || body.toLowerCase() === '!ingatkan') {
    if (!isGroup) {
      await client.sendMessage(chatId, '⚠️ Perintah ini hanya bisa digunakan di dalam grup.');
      return;
    }

    const isAdmin = await isSenderAdmin(client, message, chatId, rawSenderId);
    if (!isAdmin) {
      await client.sendMessage(
        chatId,
        '⛔ *Akses Ditolak!*\n\nPerintah `!test-reminder` hanya dapat dijalankan oleh *Admin Grup*.'
      );
      return;
    }

    console.log(`⚡ [Admin] Menjalankan pengingat manual di grup ${chatId}...`);
    await executeReminderJob(client, chatId);
    return;
  }

  // Perintah !anggota atau !list (khusus Admin Grup)
  if (['!anggota', '!list', '!daftar-anggota'].includes(body.toLowerCase())) {
    if (!isGroup) {
      await client.sendMessage(chatId, '⚠️ Perintah ini hanya bisa digunakan di dalam grup.');
      return;
    }

    const isAdmin = await isSenderAdmin(client, message, chatId, rawSenderId);
    if (!isAdmin) {
      await client.sendMessage(
        chatId,
        '⛔ *Akses Ditolak!*\n\nPerintah `!anggota` hanya dapat diakses oleh *Admin Grup*.'
      );
      return;
    }

    const users = await User.find({ groupId: chatId, isActive: true }).sort({ name: 1 });
    if (users.length === 0) {
      await client.sendMessage(
        chatId,
        '📋 *DAFTAR ANGGOTA MONEV*\n\nBelum ada anggota yang terdaftar di grup ini.\nSilakan mendaftar dengan ketik:\n*!daftar [Nama Lengkap]*'
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
      const cleanNum = (u.whatsappNumber || '').split('@')[0];
      text += `${idx + 1}. *${u.name}* (@${cleanNum}) — ${statusIcon}\n`;
    });

    const attendedCount = attendedSet.size;
    text += `\n📊 *Progres Hari Ini:* ${attendedCount}/${users.length} anggota sudah absen.`;
    text += '\n\n💡 *Tips Admin:* Ketik *!hapus [Nama]* untuk menghapus anggota dari daftar.';

    await client.sendMessage(chatId, text);
    return;
  }

  // Perintah !hapus [Nama / Tag] (khusus Admin Grup)
  if (body.startsWith('!hapus')) {
    if (!isGroup) {
      await client.sendMessage(chatId, '⚠️ Perintah ini hanya bisa digunakan di dalam grup.');
      return;
    }

    const isAdmin = await isSenderAdmin(client, message, chatId, rawSenderId);
    if (!isAdmin) {
      await client.sendMessage(
        chatId,
        '⛔ *Akses Ditolak!*\n\nPerintah `!hapus` hanya dapat dijalankan oleh *Admin Grup* demi menjaga keamanan data peserta.'
      );
      return;
    }

    const targetQuery = body.replace('!hapus', '').trim();
    let targetUser = null;

    // 1. Cek apakah ada mention di pesan (misal: !hapus @Budi)
    if (message.mentionedIds && message.mentionedIds.length > 0) {
      const mentionedJid = typeof message.mentionedIds[0] === 'string'
        ? message.mentionedIds[0]
        : message.mentionedIds[0]._serialized;

      const cleanMentionNum = (mentionedJid || '').split('@')[0];
      targetUser = await User.findOne({
        groupId: chatId,
        $or: [
          { whatsappNumber: mentionedJid },
          { whatsappNumber: { $regex: cleanMentionNum } }
        ]
      });
    }

    // 2. Jika tidak mention, cari berdasarkan Nama (pencarian teks fleksibel)
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
      await client.sendMessage(
        chatId,
        '⚠️ Anggota tidak ditemukan!\n\nCara penggunaan:\n• *!hapus @tag_orangnya*\n• *!hapus [Nama Lengkap]* (Contoh: `!hapus Budi Santoso`)\n\nKetik *!anggota* untuk melihat daftar nama yang terdaftar.'
      );
      return;
    }

    const removedName = targetUser.name;
    const removedId = targetUser._id;

    // Hapus data pengguna & riwayat log absensinya dari database
    await User.deleteOne({ _id: removedId });
    await AttendanceLog.deleteMany({ user: removedId });

    await client.sendMessage(
      chatId,
      `✅ Anggota *${removedName}* berhasil dihapus dari sistem pengingat Monev grup ini.`
    );
    return;
  }

  // Resolusi nomor HP asli untuk perintah yang membutuhkan data user (!daftar dan !sudah)
  const senderId = await resolvePhoneNumber(client, rawSenderId);

  // Perintah !daftar [Nama]
  if (body.startsWith('!daftar')) {
    if (!isGroup) {
      await message.reply('⚠️ Perintah ini harus dijalankan di dalam grup WhatsApp Magangers.');
      return;
    }

    const name = body.replace('!daftar', '').trim();
    if (!name) {
      await message.reply('⚠️ Format salah! Gunakan: *!daftar [Nama Lengkap]*\nContoh: *!daftar Budi Santoso*');
      return;
    }

    // Cek apakah nomor sudah terdaftar (baik via nomor ter-resolve maupun ID mentah sebelumnya)
    const existingUser = await User.findOne({
      $or: [{ whatsappNumber: senderId }, { whatsappNumber: rawSenderId }]
    });

    if (existingUser) {
      // Perbarui nomor ke format asli jika sebelumnya tersimpan sebagai @lid
      if (existingUser.whatsappNumber !== senderId) {
        existingUser.whatsappNumber = senderId;
      }

      // Jika sudah terdaftar tapi grupnya berubah, perbarui groupId
      if (existingUser.groupId !== chatId || !existingUser.isActive) {
        existingUser.groupId = chatId;
        existingUser.name = name;
        existingUser.isActive = true;
        await existingUser.save();
        await client.sendMessage(
          chatId,
          `${getMentionHandle(senderId)} Data pendaftaranmu berhasil diperbarui untuk grup ini!`,
          { mentions: [senderId] }
        );
        return;
      }

      existingUser.name = name;
      await existingUser.save();
      await client.sendMessage(
        chatId,
        `${getMentionHandle(senderId)} Kamu sudah terdaftar sebelumnya dengan nama *${existingUser.name}* di grup ini.`,
        { mentions: [senderId] }
      );
      return;
    }

    // Daftarkan user baru dengan nomor yang sudah ter-resolve
    await User.create({
      name,
      whatsappNumber: senderId,
      groupId: chatId,
      isActive: true
    });

    const replyText = `${getMentionHandle(senderId)} Berhasil terdaftar! Sistem akan mengingatkanmu di grup ini jika kamu belum absen Monev.`;
    await client.sendMessage(chatId, replyText, { mentions: [senderId] });
    return;
  }

  // Perintah !sudah
  if (body.toLowerCase() === '!sudah') {
    if (!isGroup) {
      await message.reply('⚠️ Konfirmasi absen harus dilakukan di grup WhatsApp.');
      return;
    }

    // 1. Cari User berdasarkan whatsappNumber (mendukung senderId ter-resolve maupun ID lama)
    const user = await User.findOne({
      $or: [{ whatsappNumber: senderId }, { whatsappNumber: rawSenderId }]
    });

    if (!user) {
      await client.sendMessage(
        chatId,
        `${getMentionHandle(senderId)} Kamu belum terdaftar dalam sistem bot. Silakan daftar terlebih dahulu dengan ketik:\n*!daftar [Nama]*`,
        { mentions: [senderId] }
      );
      return;
    }

    // Perbarui nomor ke format asli jika sebelumnya tersimpan sebagai @lid
    if (user.whatsappNumber !== senderId) {
      user.whatsappNumber = senderId;
      await user.save();
    }

    const { startOfDay, endOfDay } = getJakartaDateRange();

    // Cek apakah sudah konfirmasi hari ini
    const existingLog = await AttendanceLog.findOne({
      user: user._id,
      date: { $gte: startOfDay, $lte: endOfDay }
    });

    if (existingLog) {
      await client.sendMessage(
        chatId,
        `${getMentionHandle(senderId)} Kamu sudah mengonfirmasi absen Monev untuk hari ini. Terima kasih! 👍`,
        { mentions: [senderId] }
      );
      return;
    }

    // 2. Buat AttendanceLog dengan tanggal hari ini
    await AttendanceLog.create({
      user: user._id,
      date: new Date(),
      status: 'confirmed'
    });

    // 3. Cek All-Clear di grup ini
    // Ambil semua user aktif di grup ini
    const activeUsersInGroup = await User.find({
      groupId: chatId,
      isActive: true
    });

    const totalActiveCount = activeUsersInGroup.length;
    const userIdsInGroup = activeUsersInGroup.map((u) => u._id);

    // Hitung berapa user di grup ini yang sudah memiliki AttendanceLog hari ini
    const distinctAttendedUsersToday = await AttendanceLog.distinct('user', {
      user: { $in: userIdsInGroup },
      date: { $gte: startOfDay, $lte: endOfDay }
    });

    const completedCount = distinctAttendedUsersToday.length;

    // Jika semua user aktif di grup sudah absen
    if (totalActiveCount > 0 && completedCount >= totalActiveCount) {
      const allClearMessage =
        '🎉 Mantep Gaiss! Semua anggota grup Magangers sudah absen Monev Maganghub hari ini.\n\n' +
        'Tetap semangat gaiss! Rezeki yang sudah tertakar, tidak mungkin tertukar. ✨';

      await client.sendMessage(chatId, allClearMessage);
    } else {
      const remaining = Math.max(0, totalActiveCount - completedCount);
      const ackMessage =
        `${getMentionHandle(senderId)} Absen Monev kamu hari ini berhasil dicatat! ✅\n` +
        `📊 Progress grup: *${completedCount}/${totalActiveCount}* anggota sudah absen (${remaining} orang lagi).`;

      await client.sendMessage(chatId, ackMessage, { mentions: [senderId] });
    }
    return;
  }

  // Perintah !keluar (anggota menghapus diri sendiri dari pengingat grup)
  if (body.toLowerCase() === '!keluar' || body.toLowerCase() === '!unregister') {
    if (!isGroup) {
      await client.sendMessage(chatId, '⚠️ Perintah ini hanya bisa digunakan di dalam grup.');
      return;
    }

    const user = await User.findOne({
      groupId: chatId,
      $or: [{ whatsappNumber: senderId }, { whatsappNumber: rawSenderId }]
    });

    if (!user) {
      await client.sendMessage(chatId, `${getMentionHandle(senderId)} Kamu belum terdaftar dalam sistem bot di grup ini.`);
      return;
    }

    const removedName = user.name;
    await User.deleteOne({ _id: user._id });
    await AttendanceLog.deleteMany({ user: user._id });

    await client.sendMessage(
      chatId,
      `✅ *${removedName}* telah berhasil keluar dan dihapus dari sistem pengingat grup ini.`
    );
    return;
  }
}

module.exports = {
  registerWhatsAppEvents
};
