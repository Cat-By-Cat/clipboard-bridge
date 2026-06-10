const { app, BrowserWindow, clipboard, dialog, ipcMain } = require('electron');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

let mainWindow;
let lastHash = null;
let suppressNext = false;

function keyFromSyncKey(syncKey) {
  return crypto.createHash('sha256').update(syncKey, 'utf8').digest();
}

function encryptText(syncKey, text) {
  const key = keyFromSyncKey(syncKey);
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final(), cipher.getAuthTag()]);
  return {
    ciphertext: encrypted.toString('base64'),
    nonce: nonce.toString('base64'),
  };
}

function decryptText(syncKey, ciphertext, nonce) {
  const key = keyFromSyncKey(syncKey);
  const encrypted = Buffer.from(ciphertext, 'base64');
  const iv = Buffer.from(nonce, 'base64');
  const tag = encrypted.subarray(encrypted.length - 16);
  const body = encrypted.subarray(0, encrypted.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    title: 'Clipboard Bridge',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

ipcMain.handle('native:invoke', async (_event, command, args = {}) => {
  switch (command) {
    case 'device_name':
      return os.hostname() || 'Desktop';
    case 'platform':
      return process.platform === 'darwin' ? 'macos' : process.platform;
    case 'device_public_key':
      return crypto.createHash('sha256').update(`${os.hostname()}-${process.platform}`, 'utf8').digest('base64');
    case 'poll_clipboard': {
      if (suppressNext) {
        suppressNext = false;
        return null;
      }
      const text = clipboard.readText();
      if (!text) return null;
      const contentHash = sha256Hex(text);
      if (lastHash === contentHash) return null;
      lastHash = contentHash;
      const encrypted = encryptText(args.syncKey, text);
      return { ...encrypted, contentHash };
    }
    case 'apply_remote_clipboard': {
      const text = decryptText(args.syncKey, args.ciphertext, args.nonce);
      lastHash = sha256Hex(text);
      suppressNext = true;
      clipboard.writeText(text);
      return null;
    }
    case 'encrypt_and_pick_file': {
      const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'] });
      if (result.canceled || !result.filePaths.length) return null;
      const filePath = result.filePaths[0];
      const bytes = await fs.readFile(filePath);
      const metadata = JSON.stringify({ name: path.basename(filePath), size: bytes.length });
      const encrypted = encryptText(args.syncKey, metadata);
      return { encryptedMetadata: encrypted.ciphertext, bytes: Array.from(bytes) };
    }
    default:
      throw new Error(`Unknown native command: ${command}`);
  }
});
