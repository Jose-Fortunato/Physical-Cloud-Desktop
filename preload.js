'use strict'
/**
 * preload.js — Ponte segura entre o processo principal (Node) e o renderer (web).
 *
 * Expõe window.AndroidBridge com a mesma superfície de API do bridge Android,
 * para que todo o código web existente funcione sem modificações.
 *
 * Também expõe window.isAndroidApp = true e window.isDesktopApp = true.
 */

const { contextBridge, ipcRenderer } = require('electron')

// ─── Flags de plataforma ──────────────────────────────────────────────────────
contextBridge.exposeInMainWorld('isAndroidApp', true)   // ativa android-bridge.js
contextBridge.exposeInMainWorld('isDesktopApp', true)   // adaptações de desktop
contextBridge.exposeInMainWorld('androidVersion', 999)  // compat check no web app

// ─── Repassa o resultado do folder picker como CustomEvent ───────────────────
ipcRenderer.on('bridge:folderPickerResult', (_event, folderPath, callbackName) => {
  window.dispatchEvent(new CustomEvent('android:folder-picked', {
    detail: { uri: folderPath, callbackName },
  }))
})

// ─── Bridge completo — mesma API do @JavascriptInterface Android ─────────────
contextBridge.exposeInMainWorld('AndroidBridge', {

  // ── Informações do dispositivo ──────────────────────────────────────────
  getDeviceInfo: ()         => ipcRenderer.sendSync('bridge:getDeviceInfo'),
  getDeviceName: ()         => ipcRenderer.sendSync('bridge:getDeviceName'),

  // ── Toast / feedback háptico ────────────────────────────────────────────
  showToast:  (msg)         => ipcRenderer.send('bridge:showToast', msg),
  vibrate:    (_ms)         => { /* no-op no desktop */ },

  // ── Seletor de pasta ────────────────────────────────────────────────────
  openFolderPicker: (callbackName) =>
    ipcRenderer.send('bridge:openFolderPicker', callbackName),

  // ── Metadados de arquivo ────────────────────────────────────────────────
  getFileMetadata: (filePath) =>
    ipcRenderer.sendSync('bridge:getFileMetadata', filePath),

  // ── FIX 1: Stream de leitura incremental ────────────────────────────────
  openReadStream:   (filePath)        => ipcRenderer.invoke('bridge:openReadStream', filePath),
  readStreamChunk:  (handle, size)    => ipcRenderer.invoke('bridge:readStreamChunk', handle, size),
  closeReadStream:  (handle)          => ipcRenderer.invoke('bridge:closeReadStream', handle),

  // ── Escrita em stream assíncrona ────────────────────────────────────────
  startFileWrite:   (name, folder)    => ipcRenderer.invoke('bridge:startFileWrite', name, folder),
  startDownloadWrite: (name, mime, relativeFolder) => ipcRenderer.invoke('bridge:startDownloadWrite', name, mime, relativeFolder),
  appendChunk:      (handle, b64)     => ipcRenderer.invoke('bridge:appendChunk', handle, b64),
  finishFileWrite:  (handle)          => ipcRenderer.invoke('bridge:finishFileWrite', handle),
  abortFileWrite:   (handle)          => ipcRenderer.invoke('bridge:abortFileWrite', handle),

  // ── Salvar arquivo (base64 completo) ────────────────────────────────────
  saveFile: (b64, name, mime, folder) =>
    ipcRenderer.sendSync('bridge:saveFile', b64, name, mime, folder),
  saveFileToDownloads: (b64, name) =>
    ipcRenderer.sendSync('bridge:saveFileToDownloads', b64, name),

  // ── Listagem de diretório ───────────────────────────────────────────────
  listDirectoryFiles: (folder) =>
    ipcRenderer.sendSync('bridge:listDirectoryFiles', folder),

  // ── Status da conexão → bandeja ─────────────────────────────────────────
  updateServiceStatus: (connected, deviceName) =>
    ipcRenderer.send('bridge:updateServiceStatus', connected, deviceName),

  // ── Progresso de transferência ──────────────────────────────────────────
  updateTransferProgress: (name, progress, done) =>
    ipcRenderer.send('bridge:updateTransferProgress', name, progress, done),

  // ── Bateria (sem relevância no desktop) ─────────────────────────────────
  requestBatteryExemption:    () => { /* no-op */ },
  isBatteryOptimizationIgnored: () => true,

  // ── Abrir / compartilhar arquivo ─────────────────────────────────────────
  openFile:  (filePath, mime) => ipcRenderer.send('bridge:openFile',  filePath, mime),
  shareFile: (filePath, mime) => ipcRenderer.send('bridge:shareFile', filePath, mime),
})
