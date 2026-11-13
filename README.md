# Physical Cloud — Versão Desktop

App de transferência P2P de arquivos entre dispositivos via WebRTC/WebSocket.
Funciona em Windows, macOS e Linux.

---

## Pré-requisitos

- **Node.js** 18 ou superior → https://nodejs.org
- **npm** (já vem com o Node.js)

---

## Instalação e execução rápida (desenvolvimento)

```bash
# 1. Instalar dependências (só na primeira vez)
npm install

# 2. Rodar em modo desenvolvimento
npm start
```

---

## Gerar instalador / executável

```bash
# Windows (.exe via NSIS)
npm run build:win

# macOS (.dmg)
npm run build:mac

# Linux (.AppImage)
npm run build:linux

# Todos de uma vez (requer ambiente com as três plataformas)
npm run build:all
```

O instalador ficará na pasta `dist/`.

---

## Diferenças em relação à versão Android

| Funcionalidade         | Android                        | Desktop (esta versão)              |
|------------------------|--------------------------------|------------------------------------|
| Seleção de pasta       | SAF (Storage Access Framework) | Diálogo nativo do OS               |
| Salvar arquivos        | SAF URIs                       | Caminhos do sistema de arquivos    |
| Segundo plano          | Foreground Service + WakeLock  | Bandeja do sistema (system tray)   |
| Notificações           | NotificationCompat             | Notificações nativas do OS         |
| Drag-and-drop          | Compartilhamento via Intent    | Arrastar arquivos para a janela    |
| Sleep durante transfer | WakeLock                       | powerSaveBlocker do Electron       |
| Sem conexão no fundo   | WakeLock PARTIAL               | App fica na bandeja, sempre ativo  |

---

## Funcionalidades Desktop extras

- **Drag-and-drop**: arraste arquivos diretamente para a janela do app para enviá-los
- **Bandeja do sistema**: fechar a janela não encerra o app — ele fica na bandeja
- **Notificação de arquivo recebido**: notificação nativa ao concluir transferência
- **Atalho Ctrl+W**: minimiza para bandeja (não encerra)
- **Sem otimização de bateria**: no desktop o processo nunca é suspenso pelo OS

---

## Ícone personalizado

Para usar seu próprio ícone, substitua os arquivos:

- `assets/icon.png` — 256×256 px (Linux e fallback)
- `assets/icon.ico` — para Windows (pode gerar em https://icoconvert.com)
- `assets/icon.icns` — para macOS (pode gerar com `iconutil` no Mac)

---

## Estrutura do projeto

```
PhysicalCloud-Desktop/
├── main.js              ← Processo principal Electron (janela, bandeja, IPC)
├── preload.js           ← Bridge segura Node ↔ Renderer (expõe AndroidBridge)
├── package.json         ← Dependências e config de build
├── assets/
│   └── icon.png         ← Ícone do app
└── src/
    ├── index.html           ← UI principal (compartilhada com Android)
    ├── electron-bridge.js   ← Adaptações de desktop (drag-drop, atalhos, etc.)
    ├── android-bridge.js    ← Bridge JS (funciona igual ao Android)
    ├── PhysicalCloud.js     ← Lógica principal
    ├── PhysicalCloud-transfer.js
    ├── PhysicalCloud-webrtc.js
    ├── PhysicalCloud-auto.js
    ├── PhysicalCloud-feedback.js
    └── PhysicalCloud.css
```
