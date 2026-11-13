'use strict'

const {
  app, BrowserWindow, ipcMain, Tray, Menu, Notification,
  dialog, shell, nativeImage, nativeTheme, powerSaveBlocker
} = require('electron')
const path  = require('path')
const fs    = require('fs')
const os    = require('os')
const { fileURLToPath } = require('url')

// Evita duas instâncias do Physical Cloud competindo pelo mesmo deviceId e
// substituindo uma à outra no servidor. O app continua na bandeja ao fechar a janela.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  })
}

// ─── Estado global ────────────────────────────────────────────────────────────
let mainWindow      = null
let tray            = null
let isQuitting      = false
let powerBlockerId  = null   // previne sleep enquanto transferência ativa

// ─── Streams de leitura/escrita abertos ───────────────────────────────────────
// { handle -> { fileHandle, offset, size } }
const readFds  = new Map()
// { handle -> { fileHandle, path } }
const writeFds = new Map()
const pastasAutorizadas = new Set()
const INDEX_FILE = path.resolve(__dirname, 'src', 'index.html')

// ─── Utilitários ──────────────────────────────────────────────────────────────
function sanitize(name) {
  return name.replace(/[/\\:*?"<>|]/g, '_').substring(0, 255)
}

function guessMime(name) {
  const ext = name.split('.').pop().toLowerCase()
  const map = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp',
    mp4: 'video/mp4', mkv: 'video/x-matroska', mp3: 'audio/mpeg',
    wav: 'audio/wav', ogg: 'audio/ogg', zip: 'application/zip',
    rar: 'application/x-rar-compressed', txt: 'text/plain',
    html: 'text/html', json: 'application/json',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  }
  return map[ext] || 'application/octet-stream'
}

function uniquePath(dir, name) {
  let dest = path.join(dir, name)
  let n = 1
  while (fs.existsSync(dest)) {
    const dot = name.lastIndexOf('.')
    dest = path.join(dir, dot > 0
      ? name.slice(0, dot) + ` (${n})` + name.slice(dot)
      : `${name} (${n})`
    )
    n++
  }
  return dest
}

// Cria arquivos de stream sem operações síncronas e sem sobrescrever arquivos existentes.
async function openUniqueFile(dir, name) {
  let n = 0
  while (true) {
    const dot = name.lastIndexOf('.')
    const candidate = n === 0 ? name : (dot > 0
      ? name.slice(0, dot) + ` (${n})` + name.slice(dot)
      : `${name} (${n})`)
    const dest = path.join(dir, candidate)
    try {
      const fileHandle = await fs.promises.open(dest, 'wx')
      return { dest, fileHandle, name: candidate }
    } catch (e) {
      if (e && e.code === 'EEXIST') { n++; continue }
      throw e
    }
  }
}

function ok(data)   { return JSON.stringify({ success: true,  ...data }) }
function err(msg)   { return JSON.stringify({ success: false, error: msg }) }


function trustedSender(event) {
  try {
    if (!mainWindow || event.sender !== mainWindow.webContents || !event.senderFrame || event.senderFrame !== mainWindow.webContents.mainFrame) return false
    const url = new URL(event.senderFrame.url)
    return url.protocol === 'file:' && path.resolve(fileURLToPath(url)) === INDEX_FILE
  } catch (_) { return false }
}
function requireTrusted(event) {
  if (!trustedSender(event)) throw new Error('Origem IPC não autorizada.')
}
function isInsideDirectory(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))
}
function canonicalExistingPath(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null
  try { return fs.realpathSync(path.resolve(value)) } catch (_) { return null }
}
// Leitura/listagem só pode ocorrer dentro de uma pasta que o usuário escolheu
// explicitamente pelo diálogo nativo. A pasta pessoal inteira não é uma raiz autorizada.
function pathInsideAuthorizedFolders(value) {
  const resolved = canonicalExistingPath(value)
  if (!resolved) return null
  for (const root of pastasAutorizadas) {
    const canonicalRoot = canonicalExistingPath(root)
    if (canonicalRoot && isInsideDirectory(canonicalRoot, resolved)) return resolved
  }
  return null
}
function authorizedFolder(value) {
  const resolved = pathInsideAuthorizedFolders(value)
  if (!resolved) return null
  try { return fs.statSync(resolved).isDirectory() ? resolved : null } catch (_) { return null }
}
// Cria subpastas somente dentro de uma raiz que o usuário autorizou no
// seletor nativo. Cada componente é verificado com lstat/realpath para
// rejeitar symlinks e impedir escapes para fora da raiz.
async function ensureAuthorizedFolder(value) {
  if (typeof value !== 'string' || !value || value.includes('\0')) return null
  const target = path.resolve(value)
  for (const rootValue of pastasAutorizadas) {
    const root = canonicalExistingPath(rootValue)
    if (!root || !isInsideDirectory(root, target)) continue
    let current = root
    const relative = path.relative(root, target)
    const parts = relative ? relative.split(path.sep).filter(Boolean) : []
    try {
      for (const part of parts) {
        if (part === '.' || part === '..') return null
        current = path.join(current, part)
        try {
          const st = await fs.promises.lstat(current)
          if (st.isSymbolicLink() || !st.isDirectory()) return null
        } catch (error) {
          if (error.code !== 'ENOENT') throw error
          await fs.promises.mkdir(current)
          const st = await fs.promises.lstat(current)
          if (st.isSymbolicLink() || !st.isDirectory()) return null
        }
        const real = await fs.promises.realpath(current)
        if (!isInsideDirectory(root, real)) return null
        current = real
      }
      const finalStat = await fs.promises.stat(current)
      return finalStat.isDirectory() ? current : null
    } catch (_) {
      return null
    }
  }
  return null
}
function downloadsAppRoot() {
  return path.join(app.getPath('downloads'), 'Physical Cloud')
}
function pathInsideDownloadsApp(value) {
  const resolved = canonicalExistingPath(value)
  const root = canonicalExistingPath(downloadsAppRoot())
  return resolved && root && isInsideDirectory(root, resolved) ? resolved : null
}
function pathAllowedForOpen(value) {
  return pathInsideAuthorizedFolders(value) || pathInsideDownloadsApp(value)
}

// ─── Ícone da bandeja ─────────────────────────────────────────────────────────
function getTrayIcon(connected) {
  // Ícone 16×16 gerado via nativeImage para funcionar em todos OS
  const blue  = '#4a9eff'
  const grey  = '#888888'
  const color = connected ? blue : grey

  // Fallback: usa PNG do assets se existir
  const pngPath = path.join(__dirname, 'assets', 'icon.png')
  if (fs.existsSync(pngPath)) return nativeImage.createFromPath(pngPath)

  // PNG 16x16 inline (azul sólido — funciona como placeholder)
  const B64_ICON = 'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAAABHNCSVQICAgIfAhkiAAAAAlwSFlzAAALEwAACxMBAJqcGAAAABl0RVh0U29mdHdhcmUAd3d3Lmlua3NjYXBlLm9yZ5vuPBoAAABHSURBVCiRY/z//z8DMigqKsIIaMjq6uqMowaMGjBqwKgBww0AAAf/A/8BAAAA//8DAFBLAQItABQABgAIAAAAIQCZhnIf/wAAAHABAAAAAAAAAAAAAAAAHAAA'
  return nativeImage.createFromDataURL(`data:image/png;base64,${B64_ICON}`)
}

// ─── Criação da janela principal ──────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1100,
    height: 760,
    minWidth:  800,
    minHeight: 600,
    title: 'Physical Cloud',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload:             path.join(__dirname, 'preload.js'),
      contextIsolation:    true,
      nodeIntegration:     false,
      webSecurity:         true,
      sandbox:             true,
      backgroundThrottling: false,   // mantém timers/WS ativos quando na bandeja
    },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1a1a2e' : '#f5f5f5',
  })

  const bloquearNavegacaoExterna = (event, target) => {
    try { const u = new URL(target); if (u.protocol !== 'file:' || path.resolve(fileURLToPath(u)) !== INDEX_FILE) event.preventDefault() } catch (_) { event.preventDefault() }
  }
  mainWindow.webContents.on('will-navigate', bloquearNavegacaoExterna)
  mainWindow.webContents.on('will-redirect', bloquearNavegacaoExterna)
  mainWindow.webContents.on('will-attach-webview', event => event.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try { const u = new URL(url); if (u.protocol === 'https:' && ['physicalcloud.app', 'www.physicalcloud.app'].includes(u.hostname)) shell.openExternal(url) } catch (_) {}
    return { action: 'deny' }
  })
  mainWindow.loadFile(INDEX_FILE)

  // Fechar janela → minimiza para bandeja (não encerra)
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow.hide()
      if (process.platform === 'darwin') app.dock.hide()
      tray && tray.displayBalloon &&
        tray.displayBalloon({
          title: 'Physical Cloud',
          content: 'O app continua rodando em segundo plano. Clique no ícone para reabrir.',
          iconType: 'info',
        })
    }
  })
}

// ─── Bandeja do sistema ───────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(getTrayIcon(false))
  tray.setToolTip('Physical Cloud — aguardando conexão')

  const menu = Menu.buildFromTemplate([
    { label: 'Abrir Physical Cloud', click: () => { mainWindow.show(); if (process.platform === 'darwin') app.dock.show() } },
    { type:  'separator' },
    { label: 'Encerrar',             click: () => { isQuitting = true; app.quit() } },
  ])
  tray.setContextMenu(menu)

  tray.on('click', () => {
    if (mainWindow.isVisible()) {
      mainWindow.focus()
    } else {
      mainWindow.show()
      if (process.platform === 'darwin') app.dock.show()
    }
  })
}

// ─── App lifecycle ────────────────────────────────────────────────────────────
if (gotSingleInstanceLock) app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  createWindow()
  createTray()

  app.on('activate', () => {           // macOS: clique no dock
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
    else mainWindow.show()
  })
})

app.on('window-all-closed', () => {
  // Nunca encerra automaticamente — fica na bandeja
})

app.on('before-quit', () => { isQuitting = true })

// ─────────────────────────────────────────────────────────────────────────────
//  IPC HANDLERS — equivalentes ao @JavascriptInterface do Android
//  Todos os handlers "bridge:*" respondem ao preload.js
// ─────────────────────────────────────────────────────────────────────────────

// ── Informações do dispositivo ────────────────────────────────────────────────
ipcMain.on('bridge:getDeviceInfo', (event) => {
  if (!trustedSender(event)) { event.returnValue = err('Origem IPC não autorizada.'); return }
  event.returnValue = JSON.stringify({
    isApp:        true,
    platform:     'desktop',
    os:           process.platform,
    osVersion:    os.release(),
    manufacturer: '',
    model:        os.hostname(),
    deviceName:   os.hostname(),
  })
})

ipcMain.on('bridge:getDeviceName', (event) => {
  if (!trustedSender(event)) { event.returnValue = ''; return }
  event.returnValue = os.hostname()
})

// ── Toast / notificação nativa ────────────────────────────────────────────────
ipcMain.on('bridge:showToast', (event, msg) => {
  if (!trustedSender(event) || typeof msg !== 'string' || msg.length > 1000) return
  new Notification({ title: 'Physical Cloud', body: msg, silent: true }).show()
})

// ── Pasta selecionada ─────────────────────────────────────────────────────────
ipcMain.on('bridge:openFolderPicker', async (event, callbackName) => {
  if (!trustedSender(event) || (callbackName != null && (typeof callbackName !== 'string' || callbackName.length > 100))) return
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecionar pasta de destino',
    properties: ['openDirectory', 'createDirectory'],
  })
  let folderPath = null
  if (!result.canceled && result.filePaths[0]) {
    try {
      const selected = fs.realpathSync(result.filePaths[0])
      if (fs.statSync(selected).isDirectory()) {
        folderPath = selected
        pastasAutorizadas.add(selected)
      }
    } catch (_) {}
  }
  mainWindow.webContents.send('bridge:folderPickerResult', folderPath, callbackName)
})

// ── Metadados de arquivo ──────────────────────────────────────────────────────
ipcMain.on('bridge:getFileMetadata', (event, filePath) => {
  try {
    requireTrusted(event)
    const safePath = pathInsideAuthorizedFolders(filePath); if (!safePath) throw new Error('Caminho fora das pastas escolhidas pelo usuário ou inválido.')
    const stat = fs.statSync(safePath); if (!stat.isFile()) throw new Error('O caminho não é um arquivo regular.')
    event.returnValue = ok({
      fileName: path.basename(safePath),
      mimeType: guessMime(safePath),
      size:     stat.size,
    })
  } catch (e) {
    event.returnValue = err(e.message)
  }
})

// ── Leitura/escrita em blocos por IPC assíncrono ───────────────────────────────
// A leitura/escrita é limitada a blocos; o renderer não recebe o arquivo inteiro.
ipcMain.handle('bridge:openReadStream', async (event, filePath) => {
  try {
    requireTrusted(event)
    const safePath = pathInsideAuthorizedFolders(filePath); if (!safePath) throw new Error('Caminho fora das pastas escolhidas pelo usuário ou inválido.')
    const stat = await fs.promises.stat(safePath); if (!stat.isFile()) throw new Error('O caminho não é um arquivo regular.')
    const handle = `rs_${Date.now()}_${Math.random().toString(36).slice(2)}`
    const fd = await fs.promises.open(safePath, 'r')
    readFds.set(handle, { offset: 0, size: stat.size, fileHandle: fd })
    return ok({ handle, mimeType: guessMime(filePath), fileName: path.basename(safePath), totalSize: stat.size })
  } catch (e) { return err(e.message) }
})

ipcMain.handle('bridge:readStreamChunk', async (event, handle, chunkSize) => {
  if (!trustedSender(event) || typeof handle !== 'string') return err('Origem ou identificador inválido.')
  const entry = readFds.get(handle)
  if (!entry) return err(`Stream não encontrado: ${handle}`)
  try {
    const size = Math.max(1, Math.min(Number(chunkSize) || 512 * 1024, 1024 * 1024))
    const buf = Buffer.allocUnsafe(size)
    const { bytesRead } = await entry.fileHandle.read(buf, 0, size, entry.offset)
    entry.offset += bytesRead
    if (bytesRead <= 0) return ok({ base64: '', bytesRead: 0, done: true })
    return ok({ base64: buf.subarray(0, bytesRead).toString('base64'), bytesRead, done: entry.offset >= entry.size })
  } catch (e) { return err(e.message) }
})

ipcMain.handle('bridge:closeReadStream', async (event, handle) => {
  if (!trustedSender(event) || typeof handle !== 'string') return err('Origem ou identificador inválido.')
  const entry = readFds.get(handle)
  if (entry) {
    try { await entry.fileHandle.close() } catch (_) {}
    readFds.delete(handle)
  }
  return ok({})
})

ipcMain.handle('bridge:startFileWrite', async (event, fileName, folderPath) => {
  try {
    requireTrusted(event)
    const safeFolder = await ensureAuthorizedFolder(folderPath); if (!safeFolder) throw new Error('Selecione novamente uma pasta de destino autorizada.')
    if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255) throw new Error('Nome de arquivo inválido.')
    await fs.promises.mkdir(safeFolder, { recursive: true })
    const realFolder = await fs.promises.realpath(safeFolder)
    if (!pathInsideAuthorizedFolders(realFolder)) throw new Error('Pasta de destino deixou de estar autorizada.')
    const folderStat = await fs.promises.stat(realFolder)
    if (!folderStat.isDirectory()) return err('O destino selecionado não é uma pasta.')
    const safe = sanitize(fileName)
    const created = await openUniqueFile(realFolder, safe)
    const handle = `ws_${Date.now()}_${Math.random().toString(36).slice(2)}`
    writeFds.set(handle, { fileHandle: created.fileHandle, path: created.dest })
    return ok({ fileUri: created.dest, streamKey: handle, handle, name: created.name })
  } catch (e) { return err(e.message) }
})

ipcMain.handle('bridge:startDownloadWrite', async (event, fileName, _mimeType, relativeFolder = '') => {
  try {
    requireTrusted(event)
    if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255 || typeof relativeFolder !== 'string' || relativeFolder.length > 1024) throw new Error('Argumentos de gravação inválidos.')
    const safe = sanitize(fileName)
    const segments = String(relativeFolder || '').split(/[\\/]/).filter(part => part && part !== '.' && part !== '..').map(sanitize)
    const folder = path.join(downloadsAppRoot(), ...segments)
    await fs.promises.mkdir(folder, { recursive: true })
    const safeDownloadsRoot = await fs.promises.realpath(downloadsAppRoot())
    const safeFolder = await fs.promises.realpath(folder)
    if (!isInsideDirectory(safeDownloadsRoot, safeFolder)) throw new Error('Pasta de destino fora da área do aplicativo.')
    const created = await openUniqueFile(safeFolder, safe)
    const handle = `ws_${Date.now()}_${Math.random().toString(36).slice(2)}`
    writeFds.set(handle, { fileHandle: created.fileHandle, path: created.dest })
    return ok({ fileUri: created.dest, streamKey: handle, handle, name: created.name })
  } catch (e) { return err(e.message) }
})

ipcMain.handle('bridge:appendChunk', async (event, handle, base64Chunk) => {
  if (!trustedSender(event) || typeof handle !== 'string' || typeof base64Chunk !== 'string' || base64Chunk.length > 2 * 1024 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64Chunk)) return err('Origem ou bloco inválido.')
  const entry = writeFds.get(handle)
  if (!entry) return err(`Stream não encontrado: ${handle}`)
  try {
    const bytes = Buffer.from(base64Chunk, 'base64')
    let written = 0
    while (written < bytes.length) {
      const result = await entry.fileHandle.write(bytes, written, bytes.length - written, null)
      if (!result.bytesWritten) throw new Error('Não foi possível concluir a gravação do bloco.')
      written += result.bytesWritten
    }
    return ok({ written })
  } catch (e) { return err(e.message) }
})

ipcMain.handle('bridge:finishFileWrite', async (event, handle) => {
  if (!trustedSender(event) || typeof handle !== 'string') return err('Origem ou identificador inválido.')
  const entry = writeFds.get(handle)
  if (!entry) return err(`Stream não encontrado: ${handle}`)
  try {
    await entry.fileHandle.sync()
    await entry.fileHandle.close()
    writeFds.delete(handle)
    return ok({ uri: entry.path })
  } catch (e) { return err(e.message) }
})

ipcMain.handle('bridge:abortFileWrite', async (event, handle) => {
  if (!trustedSender(event) || typeof handle !== 'string') return err('Origem ou identificador inválido.')
  const entry = writeFds.get(handle)
  if (!entry) return ok({})
  try { await entry.fileHandle.close() } catch (_) {}
  writeFds.delete(handle)
  try { await fs.promises.unlink(entry.path) } catch (_) {}
  return ok({})
})

// ── Salvar arquivo (base64 completo — para arquivos pequenos) ─────────────────
ipcMain.on('bridge:saveFile', (event, base64Data, fileName, _mime, folderPath) => {
  try {
    requireTrusted(event)
    const safeFolder = authorizedFolder(folderPath); if (!safeFolder) throw new Error('Selecione uma pasta de destino autorizada.')
    if (typeof base64Data !== 'string' || base64Data.length > 24 * 1024 * 1024) throw new Error('Arquivo excede o limite do salvamento legado.')
    if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255) throw new Error('Nome de arquivo inválido.')
    const safe  = sanitize(fileName)
    const dest  = uniquePath(safeFolder, safe)
    fs.writeFileSync(dest, Buffer.from(base64Data, 'base64'), { flag: 'wx' })
    event.returnValue = ok({ uri: dest, name: safe })
  } catch (e) {
    event.returnValue = err(e.message)
  }
})

ipcMain.on('bridge:saveFileToDownloads', (event, base64Data, fileName) => {
  try {
    requireTrusted(event)
    if (typeof base64Data !== 'string' || base64Data.length > 24 * 1024 * 1024) throw new Error('Arquivo excede o limite do salvamento legado.')
    if (typeof fileName !== 'string' || !fileName.trim() || fileName.length > 255) throw new Error('Nome de arquivo inválido.')
    const safe       = sanitize(fileName)
    const downloads  = downloadsAppRoot()
    fs.mkdirSync(downloads, { recursive: true })
    const safeDownloads = fs.realpathSync(downloads)
    const dest       = uniquePath(safeDownloads, safe)
    fs.writeFileSync(dest, Buffer.from(base64Data, 'base64'), { flag: 'wx' })
    event.returnValue = ok({ path: dest, name: safe })
  } catch (e) {
    event.returnValue = err(e.message)
  }
})

// Listagem segura: lstat não segue links simbólicos. Ignoramos symlinks
// (inclusive links internos) para não expor metadados de destinos externos.
function listarEntradasDiretorioSemSymlink(safeFolder) {
  const entries = fs.readdirSync(safeFolder, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const fullPath = path.join(safeFolder, entry.name)
    let stat
    try { stat = fs.lstatSync(fullPath) } catch (_) { continue }
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) continue
    files.push({
      name: entry.name,
      uri: fullPath,
      mimeType: stat.isDirectory() ? 'inode/directory' : guessMime(entry.name),
      isDirectory: stat.isDirectory(),
      size: stat.isFile() ? stat.size : 0,
      lastModified: stat.mtimeMs,
    })
  }
  return files
}

// ── Listagem de diretório ─────────────────────────────────────────────────────
ipcMain.on('bridge:listDirectoryFiles', (event, folderPath) => {
  try {
    requireTrusted(event)
    const safeFolder = authorizedFolder(folderPath); if (!safeFolder) throw new Error('Pasta não autorizada.')
    const files = listarEntradasDiretorioSemSymlink(safeFolder)
    event.returnValue = JSON.stringify({ success: true, files, folderName: path.basename(safeFolder) })
  } catch (e) {
    event.returnValue = err(e.message)
  }
})

// ── Status da conexão → atualiza bandeja ─────────────────────────────────────
ipcMain.on('bridge:updateServiceStatus', (event, connected, deviceName) => {
  if (!trustedSender(event)) return
  if (!tray) return
  tray.setImage(getTrayIcon(connected))
  tray.setToolTip(connected
    ? `Physical Cloud — conectado a: ${String(deviceName || 'dispositivo').slice(0, 100)}`
    : 'Physical Cloud — aguardando conexão'
  )
})

// ── Progresso de transferência ────────────────────────────────────────────────
ipcMain.on('bridge:updateTransferProgress', (event, fileName, progress, done) => {
  if (!trustedSender(event)) return
  if (done) {
    // Libera bloqueio de sleep após transferência concluída
    if (powerBlockerId !== null) {
      powerSaveBlocker.stop(powerBlockerId)
      powerBlockerId = null
    }
    new Notification({
      title: 'Physical Cloud — Transferência concluída',
      body:  `Arquivo recebido: ${String(fileName || 'arquivo').slice(0, 180)}`,
      silent: false,
    }).show()
  } else if (powerBlockerId === null) {
    // Bloqueia sleep do sistema durante transferência
    powerBlockerId = powerSaveBlocker.start('prevent-app-suspension')
  }
})

// ── Abrir arquivo com app padrão ──────────────────────────────────────────────
ipcMain.on('bridge:openFile', (event, filePath) => {
  if (!trustedSender(event)) return
  const safePath = pathAllowedForOpen(filePath); if (!safePath) return
  shell.openPath(safePath).catch(() => {})
})

// ── Compartilhar arquivo (abre pasta no Explorer/Finder) ──────────────────────
ipcMain.on('bridge:shareFile', (event, filePath) => {
  if (!trustedSender(event)) return
  const safePath = pathAllowedForOpen(filePath); if (!safePath) return
  shell.showItemInFolder(safePath)
})
