/**
 * electron-bridge.js
 * Adaptações de desktop para o Physical Cloud.
 *
 * Equivalente ao injectAndroidCapabilities() do MainActivity.kt, mas
 * para Electron. Roda no renderer depois que android-bridge.js já foi
 * carregado (e já configurou os listeners de WebSocket/WebRTC).
 *
 * Carregado por index.html logo após android-bridge.js.
 */

(function () {
  'use strict'

  // Só executa se o bridge Electron estiver ativo
  if (!window.AndroidBridge || !window.isDesktopApp) return

  console.log('[ElectronBridge] Inicializando adaptações de desktop…')

  // ─── Injeta as funções de conveniência que o web app chama ──────────────
  // (equivalente ao window.android* injetado por injectAndroidCapabilities)

  window.androidOpenFolderPicker = function (callbackName) {
    AndroidBridge.openFolderPicker(callbackName)
  }

  window.androidSaveFile = function (base64Data, fileName, mimeType, folderUri) {
    return AndroidBridge.saveFile(base64Data, fileName, mimeType, folderUri)
  }

  window.androidRequestBatteryExemption = function () {
    // Sem relevância no desktop
  }

  // Stream de escrita
  window.androidStartFileWrite = function (fileName, folderUri) {
    return AndroidBridge.startFileWrite(fileName, folderUri)
  }
  window.androidAppendChunk = function (fileUri, base64Chunk) {
    return AndroidBridge.appendChunk(fileUri, base64Chunk)
  }
  window.androidFinishFileWrite = function (fileUri) {
    return AndroidBridge.finishFileWrite(fileUri)
  }

  // Listagem de diretório
  window.androidListDirectoryFiles = function (folderUri) {
    return AndroidBridge.listDirectoryFiles(folderUri)
  }

  // Progresso de transferência
  window.androidUpdateTransferProgress = function (fileName, progress, done) {
    AndroidBridge.updateTransferProgress(fileName, progress || -1, done || false)
  }

  // ─── Esconde elementos exclusivos da versão web / Android ───────────────
  function esconderElementosNaoDesktop () {
    // Aviso "instale o app" — no desktop NÃO faz sentido
    var btnApp = document.getElementById('btn-abrir-app-futuro')
    if (btnApp) btnApp.style.display = 'none'

    // Aviso "versão web — conexão em segundo plano" — não se aplica no desktop
    var avisoWeb = document.querySelector('.aviso-web')
    if (avisoWeb) avisoWeb.style.display = 'none'
  }

  // Roda imediatamente se DOM já pronto, ou aguarda
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', esconderElementosNaoDesktop)
  } else {
    esconderElementosNaoDesktop()
  }

  // ─── Drag-and-drop de arquivos na janela ──────────────────────────────────
  // No Electron, arquivos arrastados para a janela têm a propriedade .path
  // (caminho absoluto no sistema de arquivos). Usamos isso para disparar o
  // mesmo fluxo que o "compartilhar" do Android usa.
  document.addEventListener('dragover', function (e) {
    e.preventDefault()
    e.stopPropagation()
  })

  document.addEventListener('drop', function (e) {
    e.preventDefault()
    e.stopPropagation()

    // O File nativo recebido pelo evento de drop já permite leitura por stream.
    // Não enviamos file.path ao processo principal: isso evitará transformar
    // qualquer caminho arbitrário do renderer em uma autorização de leitura IPC.
    const files = Array.from(e.dataTransfer.files).filter(file =>
      file && typeof file.name === 'string' && typeof file.stream === 'function'
    )
    if (!files.length) return

    document.querySelector('.nav-item[data-tab="nuvem"]')?.click()
    setTimeout(() => {
      window.dispatchEvent(new CustomEvent('android:send-files', { detail: { files } }))
    }, 300)
  })

  // ─── Atalhos de teclado de desktop ──────────────────────────────────────
  document.addEventListener('keydown', function (e) {
    // Ctrl+W fecha para a bandeja (não encerra)
    if ((e.ctrlKey || e.metaKey) && e.key === 'w') {
      e.preventDefault()
      window.close()
    }
    // F5 / Ctrl+R — reload desabilitado em produção
    if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'r')) {
      // Permite apenas em dev (window.location.reload() já funciona normalmente)
    }
  })

  // ─── Sinaliza bridge pronto ──────────────────────────────────────────────
  window.dispatchEvent(new CustomEvent('android:bridge-ready'))
  console.log('[ElectronBridge] Bridge Electron pronto ✓')
})()
