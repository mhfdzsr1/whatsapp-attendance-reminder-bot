/**
 * patch.js
 * Memperbaiki isu internal whatsapp-web.js v1.26.0 di lingkungan Cloud / Docker / Linux
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

  // 2. Pastikan loop tunggu memverifikasi WAWebSocketModel.Socket sebelum melanjutkan
  if (!content.includes('WAWebSocketModel")?.Socket')) {
    content = content.replace(
      /'window\.Debug\?\.VERSION\s*!=\s*undefined'/g,
      '\'window.Debug?.VERSION != undefined && !!window.require?.("WAWebSocketModel")?.Socket\''
    );
  }

  // 3. Lindungi pembacaan state socket dari TypeError jika model belum terdefinisi
  const targetNeedAuth = "let state = window.require('WAWebSocketModel').Socket.state;";
  const safeNeedAuth = "const socketModel = window.require && window.require('WAWebSocketModel'); let state = socketModel && socketModel.Socket ? socketModel.Socket.state : 'UNPAIRED';";
  if (content.includes(targetNeedAuth)) {
    content = content.replace(targetNeedAuth, safeNeedAuth);
  }

  // 4. Tangani error pada event framenavigated agar tidak menyebabkan unhandled rejection
  const targetFrameNav = 'await this.inject();\n        });';
  const safeFrameNav = 'try { await this.inject(); } catch (navErr) { console.warn("⚠️ [Client] Error saat inject pada framenavigated:", navErr.message); }\n        });';
  if (content.includes(targetFrameNav)) {
    content = content.replace(targetFrameNav, safeFrameNav);
  }

  fs.writeFileSync(clientPath, content, 'utf8');
  console.log('✅ [patch.js] Berhasil mem-patch whatsapp-web.js/src/Client.js');
} else {
  console.warn('⚠️ [patch.js] Client.js tidak ditemukan.');
}
