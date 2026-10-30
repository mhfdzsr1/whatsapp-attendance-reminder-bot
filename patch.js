/**
 * patch.js
 * Otomatis memperbaiki 3 isu internal whatsapp-web.js v1.26.0 di lingkungan Cloud / Docker
 */

const fs = require('fs');
const path = require('path');

const clientPath = path.join(__dirname, 'node_modules', 'whatsapp-web.js', 'src', 'Client.js');

if (fs.existsSync(clientPath)) {
  let content = fs.readFileSync(clientPath, 'utf8');

  // 1. Tambahkan wrapper inject retry saat page reload
  if (!content.includes('_injectInternal')) {
    const replacementInject = [
      'async inject(reinject = false) {',
      '        try {',
      '            return await this._injectInternal(reinject);',
      '        } catch (err) {',
      '            if (err.message && (err.message.includes("Execution context was destroyed") || err.message.includes("Session closed"))) {',
      '                console.log("🔄 [Client] WhatsApp Web me-reload halaman. Mencoba inject ulang dalam 2 detik...");',
      '                await new Promise((r) => setTimeout(r, 2000));',
      '                return this.inject(reinject);',
      '            }',
      '            throw err;',
      '        }',
      '    }',
      '',
      '    async _injectInternal(reinject = false) {'
    ].join('\n');

    content = content.replace(/async\s+inject\s*\([^)]*\)\s*\{/, replacementInject);
  }

  // 2. Tunggu Socket WAWebSocketModel siap sebelum ExposeAuthStore
  if (!content.includes('WAWebSocketModel").Socket')) {
    const replacementWait = 'await this.pupPage.waitForFunction(\'window.Debug?.VERSION != undefined && window.require && window.require("WAWebSocketModel") && window.require("WAWebSocketModel").Socket\', {timeout: this.options.authTimeoutMs});';
    content = content.replace(/await\s+this\.pupPage\.waitForFunction\(\s*['"]window\.Debug\?\.VERSION\s*!=\s*undefined['"]\s*,\s*\{\s*timeout:\s*this\.options\.authTimeoutMs\s*\}\s*\);/, replacementWait);
  }

  // 3. Picu AppStateHasSynced jika socket sudah sync saat restore sesi
  if (!content.includes('AppState.hasSynced')) {
    const replacementSync = "window.AuthStore.AppState.on('change:hasSynced', () => { window.onAppStateHasSyncedEvent(); }); if (window.AuthStore.AppState && window.AuthStore.AppState.hasSynced) { window.onAppStateHasSyncedEvent(); }";
    content = content.replace(/window\.AuthStore\.AppState\.on\(\s*['"]change:hasSynced['"]\s*,\s*\(\)\s*=>\s*\{\s*window\.onAppStateHasSyncedEvent\(\);\s*\}\s*\);/, replacementSync);
  }

  // 4. Blokir resource media (audio, video) dan font untuk hemat RAM di cloud 512MB
  if (!content.includes('setRequestInterception')) {
    const targetPage = 'this.pupPage = page;';
    const replacementPage = [
      'this.pupPage = page;',
      '        try {',
      '            await page.setRequestInterception(true);',
      '            page.on("request", (r) => {',
      '                const rt = r.resourceType();',
      '                if (rt === "media" || rt === "font") {',
      '                    r.abort();',
      '                } else {',
      '                    r.continue();',
      '                }',
      '            });',
      '        } catch (e) {}'
    ].join('\n');

    content = content.replace(targetPage, replacementPage);
  }

  fs.writeFileSync(clientPath, content, 'utf8');
  console.log('✅ [patch.js] Berhasil mem-patch whatsapp-web.js/src/Client.js');
} else {
  console.warn('⚠️ [patch.js] Client.js tidak ditemukan.');
}
