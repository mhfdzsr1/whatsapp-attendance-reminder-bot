/**
 * patch.js
 * Otomatis memperbaiki bug internal whatsapp-web.js v1.26.0 di lingkungan Cloud / Docker
 * 1. Menunggu Socket siap sebelum ExposeAuthStore (mencegah TypeError reading 'Socket')
 * 2. Memicu event AppStateHasSynced jika socket sudah sync (mencegah bot menggantung saat restore sesi)
 * 3. Menambahkan retry saat terjadi 'Execution context was destroyed' / page reload
 */

const fs = require('fs');
const path = require('path');

const clientPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');

if (fs.existsSync(clientPath)) {
  let content = fs.readFileSync(clientPath, 'utf8');

  // 1. Tambahkan wrapper inject retry jika belum ada
  if (!content.includes('Execution context was destroyed')) {
    content = content.replace(
      'async inject() {',
      `async inject() {
        try {
            return await this._injectInternal();
        } catch (err) {
            if (err.message && (err.message.includes('Execution context was destroyed') || err.message.includes('Session closed'))) {
                console.log('🔄 [Client] WhatsApp Web melakukan navigasi/reload halaman. Mencoba inject ulang dalam 2 detik...');
                await new Promise((r) => setTimeout(r, 2000));
                return this.inject();
            }
            throw err;
        }
    }

    async _injectInternal() {`
    );
  }

  // 2. Pastikan menunggu Socket siap sebelum ExposeAuthStore
  if (!content.includes('WAWebSocketModel")?.Socket')) {
    content = content.replace(
      `'window.Debug?.VERSION != undefined && (window.AuthStore != undefined || window.require?.("WAWebSocketModel") != undefined)'`,
      `'window.Debug?.VERSION != undefined && !!window.require?.("WAWebSocketModel")?.Socket'`
    );
  }

  // 3. Tambahkan trigger jika socket.hasSynced sudah true
  if (!content.includes('if (socket.hasSynced) {')) {
    content = content.replace(
      `socket.on('change:hasSynced', () => {
                window.onAppStateHasSyncedEvent();
            });`,
      `socket.on('change:hasSynced', () => {
                window.onAppStateHasSyncedEvent();
            });
            if (socket.hasSynced) {
                window.onAppStateHasSyncedEvent();
            }`
    );
  }

  fs.writeFileSync(clientPath, content, 'utf8');
  console.log('✅ [patch.js] Berhasil mem-patch whatsapp-web.js/src/Client.js');
} else {
  console.warn('⚠️ [patch.js] Client.js tidak ditemukan.');
}
