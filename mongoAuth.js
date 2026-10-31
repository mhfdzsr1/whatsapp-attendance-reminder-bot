const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const BaileysAuthSchema = new mongoose.Schema({
  _id: { type: String, required: true },
  data: { type: String, required: true },
  updatedAt: { type: Date, default: Date.now }
});

const BaileysAuth = mongoose.models.BaileysAuth || mongoose.model('BaileysAuth', BaileysAuthSchema);

/**
 * Pulihkan seluruh file auth dari MongoDB Atlas ke folder lokal
 */
async function restoreAuthFromMongo(authDir) {
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  const docs = await BaileysAuth.find({});
  if (docs.length > 0) {
    console.log(`📦 [BaileysAuth] Memulihkan ${docs.length} file sesi dari MongoDB Atlas...`);
    for (const doc of docs) {
      const filePath = path.join(authDir, doc._id);
      fs.writeFileSync(filePath, doc.data, 'utf8');
    }
  } else {
    console.log('📦 [BaileysAuth] Belum ada sesi tersimpan di MongoDB Atlas.');
  }
}

/**
 * Simpan seluruh file di folder auth ke MongoDB Atlas
 */
async function backupAuthToMongo(authDir) {
  if (!fs.existsSync(authDir)) return;
  try {
    const files = fs.readdirSync(authDir);
    for (const file of files) {
      const filePath = path.join(authDir, file);
      if (fs.statSync(filePath).isFile()) {
        const data = fs.readFileSync(filePath, 'utf8');
        await BaileysAuth.updateOne(
          { _id: file },
          { data, updatedAt: new Date() },
          { upsert: true }
        );
      }
    }
  } catch (err) {
    console.warn('⚠️ [BaileysAuth] Gagal backup sesi ke MongoDB:', err.message);
  }
}

/**
 * Hapus seluruh sesi jika terjadi logout
 */
async function clearAuth(authDir) {
  try {
    if (fs.existsSync(authDir)) {
      fs.rmSync(authDir, { recursive: true, force: true });
    }
    await BaileysAuth.deleteMany({});
    console.log('🗑️ [BaileysAuth] Sesi lama berhasil dibersihkan.');
  } catch (err) {
    console.warn('⚠️ Gagal membersihkan sesi:', err.message);
  }
}

module.exports = {
  restoreAuthFromMongo,
  backupAuthToMongo,
  clearAuth
};
