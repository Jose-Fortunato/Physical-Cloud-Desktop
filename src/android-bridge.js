/**
 * android-bridge.js
 * Integração entre o Physical Cloud (JS) e o app Android nativo.
 *
 * BLOCOS IMPLEMENTADOS:
 *   1 — Escrita em stream (evita OOM em arquivos grandes)
 *   2 — Atualiza notificação do serviço via ACTION_UPDATE_STATUS
 *   4 — AndroidDirectoryHandle.values() lista arquivos via SAF
 *   5 — android:shared-files preenche `arquivos` para disparar envio
 */

(function () {
    "use strict";

    // ─── Só executa dentro do app Android ────────────────────────────────
    if (!window.AndroidBridge) return;

    console.log("[AndroidBridge] Inicializando integração nativa…");

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCO 2 — Atualiza notificação persistente do serviço
    // ═══════════════════════════════════════════════════════════════════════

    function atualizarNotificacaoServico(connected, deviceName) {
        try {
            AndroidBridge.updateServiceStatus(connected, deviceName || "");
        } catch (e) {
            console.warn("[AndroidBridge] updateServiceStatus indisponível:", e);
        }
    }

    // Escuta eventos de conexão para atualizar a notificação
    window.addEventListener("physicalcloud:canal-aberto", function (ev) {
        const sessaoId = ev.detail && ev.detail.sessaoId;
        const sessoes = window.PhysicalCloud && window.PhysicalCloud.sessoes;
        const nome = sessoes && sessaoId ? (sessoes.get(sessaoId) || {}).nome : null;

        // Atualiza notificação nativa
        atualizarNotificacaoServico(true, nome || "dispositivo");

        // Vibração haptica leve ao conectar
        try { AndroidBridge.vibrate(50); } catch (e) { /* ignora */ }
    });

    window.addEventListener("physicalcloud:canal-fechado", function () {
        atualizarNotificacaoServico(false, "");
    });

    // Vibração ao receber arquivo
    window.addEventListener("physicalcloud:transfer-concluido", function (ev) {
        if (ev.detail && ev.detail.direcao === "recebimento") {
            try { AndroidBridge.vibrate(80); } catch (e) { /* ignora */ }
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCO E — Notificação de progresso de transferência
    // ═══════════════════════════════════════════════════════════════════════

    // Escuta evento de progresso emitido por PhysicalCloud-transfer.js
    // O evento deve ter: { nome, progresso (0-100), direcao }
    window.addEventListener("physicalcloud:transfer-progresso", function (ev) {
        if (!ev.detail) return;
        const { nome, progresso, direcao } = ev.detail;
        if (direcao !== "recebimento") return; // só notifica no receptor
        try {
            if (typeof window.androidUpdateTransferProgress === "function") {
                window.androidUpdateTransferProgress(nome || "arquivo", Math.round(progresso || 0), false);
            }
        } catch (e) { /* ignora */ }
    });

    // Cancela a notificação de progresso ao concluir
    window.addEventListener("physicalcloud:transfer-concluido", function (ev) {
        if (ev.detail && ev.detail.direcao === "recebimento") {
            try { AndroidBridge.vibrate(80); } catch (e) { /* ignora */ }
            try {
                if (typeof window.androidUpdateTransferProgress === "function") {
                    window.androidUpdateTransferProgress(ev.detail.nome || "arquivo", 100, true);
                }
            } catch (e) { /* ignora */ }
        }
    });

    // ═══════════════════════════════════════════════════════════════════════
    // Nome do dispositivo nativo
    // ═══════════════════════════════════════════════════════════════════════

    try {
        const nomeNativo = AndroidBridge.getDeviceName();
        if (nomeNativo) {
            if (!localStorage.getItem("physicalCloudNomeDispositivo")) {
                localStorage.setItem("physicalCloudNomeDispositivo", nomeNativo);
            }
        }
    } catch (e) { /* ignora */ }

    // ═══════════════════════════════════════════════════════════════════════
    // Integração com o seletor de pasta nativo Android
    // ═══════════════════════════════════════════════════════════════════════

    if (typeof window.showDirectoryPicker !== "function") {
        window.showDirectoryPicker = function () {
            return new Promise(function (resolve, reject) {
                const callbackKey = "_dirPickerCb_" + Date.now() + "_" + Math.random().toString(36).slice(2);
                const timeout = setTimeout(() => {
                    window.removeEventListener("android:folder-picked", handler);
                    reject(new Error("Tempo esgotado ao selecionar a pasta."));
                }, 5 * 60 * 1000);
                function handler(ev) {
                    if (ev.detail?.callbackName !== callbackKey) return;
                    clearTimeout(timeout);
                    window.removeEventListener("android:folder-picked", handler);
                    const uri = ev.detail?.uri;
                    if (!uri) { reject(new DOMException("Seleção cancelada", "AbortError")); return; }
                    resolve(new AndroidDirectoryHandle(uri));
                }
                window.addEventListener("android:folder-picked", handler);
                try { AndroidBridge.openFolderPicker(callbackKey); }
                catch (error) {
                    clearTimeout(timeout);
                    window.removeEventListener("android:folder-picked", handler);
                    reject(error);
                }
            });
        };
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCO 4 — AndroidDirectoryHandle com values() implementado via SAF
    // ═══════════════════════════════════════════════════════════════════════

    class AndroidDirectoryHandle {
        constructor(uri) {
            this._uri = uri;
            this.kind = "directory";
            this.name = uri.split("/").pop() || "pasta";
        }

        async queryPermission({ mode } = {}) {
            return "granted";
        }

        async requestPermission({ mode } = {}) {
            return "granted";
        }

        async getFileHandle(fileName, { create } = {}) {
            const handle = new AndroidFileHandle(this._uri, fileName);
            handle._uri = this._uri.replace(/[\\/]$/, "") + "/" + fileName;
            return handle;
        }

        async getDirectoryHandle(dirName, { create } = {}) {
            return new AndroidDirectoryHandle(this._uri.replace(/[\\/]$/, "") + "/" + dirName);
        }

        /**
         * BLOCO 4: Lista os arquivos da pasta via SAF Bridge.
         * Retorna FileSystemFileHandle e FileSystemDirectoryHandle sintéticos.
         */
        async *values() {
            try {
                const resultStr = AndroidBridge.listDirectoryFiles(this._uri);
                const result = JSON.parse(resultStr);

                if (!result.success) {
                    throw new Error(result.error || "Não foi possível listar a pasta selecionada.");
                }

                for (const entry of result.files) {
                    if (entry.isDirectory) {
                        const dirHandle = new AndroidDirectoryHandle(entry.uri);
                        dirHandle.name = entry.name;
                        yield dirHandle;
                    } else {
                        const fileHandle = new AndroidFileHandle(this._uri, entry.name);
                        fileHandle._uri = entry.uri;
                        fileHandle._size = entry.size;
                        fileHandle._mimeType = entry.mimeType;
                        fileHandle._lastModified = entry.lastModified;
                        yield fileHandle;
                    }
                }
            } catch (e) {
                console.error("[AndroidBridge] Erro em values():", e);
                throw e;
            }
        }

        // Suporte a entries() e keys() (alias de values para compatibilidade)
        async *entries() {
            for await (const handle of this.values()) {
                yield [handle.name, handle];
            }
        }

        async *keys() {
            for await (const handle of this.values()) {
                yield handle.name;
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCO 1 — AndroidFileHandle com escrita em stream (sem acúmulo em RAM)
    // ═══════════════════════════════════════════════════════════════════════

    function parseBridgeResult(value) {
        if (typeof value === "string") return JSON.parse(value);
        return value;
    }

    /** File-like object backed by a native InputStream. It reads only on demand. */
    function createStreamingBridgeFile(uri, fileName, size, mimeType, lastModified) {
        const tamanhoNumerico = Number(size);
        const sizeKnown = Number.isSafeInteger(tamanhoNumerico) && tamanhoNumerico >= 0;
        return {
            name: fileName || "arquivo",
            // File-like: size 0 preserva compatibilidade com a UI, enquanto
            // sizeKnown=false informa ao protocolo que o total é desconhecido.
            size: sizeKnown ? tamanhoNumerico : 0,
            sizeKnown,
            type: mimeType || "application/octet-stream",
            lastModified: Number(lastModified) || Date.now(),
            stream() {
                let handle = null;
                let closed = false;
                const closeNative = async () => {
                    if (closed) return;
                    closed = true;
                    if (handle) {
                        try { await AndroidBridge.closeReadStream(handle); } catch (_) {}
                        handle = null;
                    }
                };
                return new ReadableStream({
                    async pull(controller) {
                        try {
                            if (closed) return;
                            if (!handle) {
                                const opened = parseBridgeResult(await AndroidBridge.openReadStream(uri));
                                if (!opened || !opened.success || !opened.handle) throw new Error(opened?.error || "Não foi possível abrir o arquivo para leitura.");
                                handle = opened.handle;
                            }
                            const result = parseBridgeResult(await AndroidBridge.readStreamChunk(handle, 512 * 1024));
                            if (!result || !result.success) throw new Error(result?.error || "Falha ao ler um bloco do arquivo.");
                            if (result.bytesRead > 0 && result.base64) {
                                const binary = atob(result.base64);
                                const bytes = new Uint8Array(binary.length);
                                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                                controller.enqueue(bytes);
                            }
                            if (result.done || result.bytesRead === 0) {
                                await closeNative();
                                controller.close();
                            }
                        } catch (error) {
                            await closeNative();
                            controller.error(error);
                        }
                    },
                    async cancel() { await closeNative(); }
                });
            }
        };
    }
    window.PhysicalCloudCreateBridgeFile = createStreamingBridgeFile;

    const CHUNK_SIZE = 256 * 1024; // 256 KB por chunk

    class AndroidFileHandle {
        constructor(folderUri, fileName) {
            this._folderUri = folderUri;
            this._fileName = fileName;
            this.kind = "file";
            this.name = fileName;
            // Campos extras populados por values()
            this._uri = null;
            this._size = 0;
            this._mimeType = null;
            this._lastModified = 0;
        }

        /**
         * Retorna um File sintético (usado pelo explorador remoto para leitura).
         */
        async getFile() {
            if (!this._uri) this._uri = this._folderUri.replace(/[\\/]$/, "") + "/" + this._fileName;
            if (!this._size) {
                const metadata = parseBridgeResult(await AndroidBridge.getFileMetadata(this._uri));
                if (!metadata || !metadata.success) throw new Error(metadata?.error || "Não foi possível obter os metadados do arquivo.");
                this._size = metadata.size;
                this._mimeType = metadata.mimeType;
                this._fileName = metadata.fileName || this._fileName;
            }
            return createStreamingBridgeFile(
                this._uri, this._fileName, this._size, this._mimeType, this._lastModified
            );
        }

        /**
         * BLOCO 1: Cria um WritableStream que envia cada chunk imediatamente
         * ao Kotlin via appendChunk — sem acumular tudo na memória JS.
         */
        async createWritable() {
            const folderUri = this._folderUri;
            const fileName = this._fileName;
            let fileUri = null;
            let pendingBuffer = null; // Uint8Array para chunks menores que CHUNK_SIZE
            let pendingOffset = 0;

            // Inicia o arquivo no Kotlin e obtém seu URI
            const startStr = await AndroidBridge.startFileWrite(fileName, folderUri);
            const startResult = parseBridgeResult(startStr);
            if (!startResult.success) {
                throw new Error("[AndroidBridge] startFileWrite falhou: " + startResult.error);
            }
            fileUri = startResult.fileUri || startResult.streamKey;
            const streamKey = startResult.streamKey || startResult.handle || startResult.fileUri;
            this._uri = startResult.fileUri || fileUri;
            this._fileName = startResult.name || this._fileName;

            // Buffer temporário para montar chunks de exatamente CHUNK_SIZE
            pendingBuffer = new Uint8Array(CHUNK_SIZE);
            pendingOffset = 0;

            /**
             * Envia os bytes acumulados no pendingBuffer ao Kotlin.
             */
            async function flushBuffer(force = false) {
                if (pendingOffset === 0) return;
                if (!force && pendingOffset < CHUNK_SIZE) return; // aguarda completar

                const slice = pendingBuffer.subarray(0, pendingOffset);
                const base64 = arrayBufferToBase64(slice.buffer.slice ? slice.buffer.slice(0, pendingOffset) : slice.buffer);
                const appendStr = await AndroidBridge.appendChunk(streamKey, base64);
                const appendResult = parseBridgeResult(appendStr);
                if (!appendResult.success) {
                    throw new Error("[AndroidBridge] appendChunk falhou: " + appendResult.error);
                }
                pendingOffset = 0;
            }

            /**
             * Aceita chunk de qualquer tamanho e divide em pedaços de CHUNK_SIZE.
             */
            async function processBytes(incoming) {
                let pos = 0;
                while (pos < incoming.length) {
                    const space = CHUNK_SIZE - pendingOffset;
                    const toCopy = Math.min(space, incoming.length - pos);
                    pendingBuffer.set(incoming.subarray(pos, pos + toCopy), pendingOffset);
                    pendingOffset += toCopy;
                    pos += toCopy;

                    if (pendingOffset >= CHUNK_SIZE) {
                        await flushBuffer(true);
                    }
                }
            }

            return {
                async write(chunk) {
                    let bytes;
                    if (chunk instanceof ArrayBuffer) {
                        bytes = new Uint8Array(chunk);
                    } else if (chunk instanceof Uint8Array) {
                        bytes = chunk;
                    } else if (typeof chunk === "string") {
                        bytes = new TextEncoder().encode(chunk);
                    } else if (chunk && chunk.type === "write" && chunk.data) {
                        const data = chunk.data;
                        if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
                        else if (data instanceof Uint8Array) bytes = data;
                        else bytes = new TextEncoder().encode(String(data));
                    } else {
                        return; // tipo desconhecido — ignora
                    }
                    await processBytes(bytes);
                },

                async close() {
                    // Envia os bytes restantes no buffer
                    if (pendingOffset > 0) {
                        await flushBuffer(true);
                    }
                    const finishStr = await AndroidBridge.finishFileWrite(streamKey);
                    const finishResult = parseBridgeResult(finishStr);
                    if (!finishResult.success) throw new Error(finishResult.error || "Não foi possível finalizar a gravação.");
                },

                async abort() {
                    pendingOffset = 0;
                    // Remove o arquivo parcial em vez de deixá-lo como se estivesse completo.
                    try {
                        if (typeof AndroidBridge.abortFileWrite === "function") await AndroidBridge.abortFileWrite(streamKey);
                        else await AndroidBridge.finishFileWrite(streamKey);
                    } catch (e) { /* libera recursos mesmo se o provedor falhar */ }
                }
            };
        }
    }

    // ═══════════════════════════════════════════════════════════════════════
    // Utilitários
    // ═══════════════════════════════════════════════════════════════════════

    function arrayBufferToBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        // Processa em chunks para evitar stack overflow em btoa() com arrays grandes
        const BTOA_CHUNK = 8192;
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i += BTOA_CHUNK) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + BTOA_CHUNK));
        }
        return btoa(binary);
    }

    function guessMimeType(fileName) {
        const ext = fileName.split(".").pop().toLowerCase();
        const map = {
            pdf: "application/pdf",
            jpg: "image/jpeg", jpeg: "image/jpeg",
            png: "image/png", gif: "image/gif", webp: "image/webp",
            mp4: "video/mp4", mkv: "video/x-matroska",
            mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
            zip: "application/zip", rar: "application/x-rar-compressed",
            txt: "text/plain", html: "text/html",
            json: "application/json",
            doc: "application/msword",
            docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            xls: "application/vnd.ms-excel",
            xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        };
        return map[ext] || "application/octet-stream";
    }

    // ═══════════════════════════════════════════════════════════════════════
    // BLOCO 5 — android:shared-files: preenche a variável `arquivos` para
    //           disparar o envio no PhysicalCloud-transfer.js
    // ═══════════════════════════════════════════════════════════════════════

    // FIX 1: leitura em stream incremental para evitar OOM com arquivos grandes.
    // Usa openReadStream + readStreamChunk (512 KB por vez) + closeReadStream.
    // O método antigo readFileAsBase64 agora recusa arquivos > 50 MB no Kotlin.
    async function lerArquivoEmStream(uriStr) {
        const metadata = parseBridgeResult(await AndroidBridge.getFileMetadata(uriStr));
        if (!metadata || !metadata.success) throw new Error(metadata?.error || "Não foi possível obter os dados do arquivo compartilhado.");
        return createStreamingBridgeFile(
            uriStr, metadata.fileName, metadata.size, metadata.mimeType, metadata.lastModified
        );
    }

    window.addEventListener("android:shared-files", async function (ev) {
        const uris = (ev.detail && ev.detail.uris) || [];
        if (!uris.length) return;

        const files = [];
        for (const uriStr of uris) {
            try {
                const file = await lerArquivoEmStream(uriStr);
                if (file) files.push(file);
            } catch (e) {
                console.error("[AndroidBridge] Erro ao processar URI compartilhado:", e);
            }
        }

        if (files.length > 0) {
            // Vai para a aba de transferência
            document.querySelector('.nav-item[data-tab="nuvem"]')?.click();

            setTimeout(() => {
                // Preenche a variável global `arquivos` usada pelo PhysicalCloud-transfer.js
                // e dispara o evento que inicia o envio
                window.dispatchEvent(new CustomEvent("android:send-files", {
                    detail: { files }
                }));
            }, 500);
        }
    });

    // O UI orquestrador (index.html) escuta este evento e chama iniciarEnvioArquivos
    window.addEventListener("android:send-files", function (ev) {
        const files = ev.detail && ev.detail.files;
        if (!files || !files.length) return;

        // Tenta a função global primeiro; se não existir, despacha evento alternativo
        if (typeof window.iniciarEnvioArquivos === "function") {
            window.iniciarEnvioArquivos(files);
        } else {
            // Fallback: dispara evento que o PhysicalCloud-transfer.js escuta
            window.dispatchEvent(new CustomEvent("physicalcloud:iniciar-envio", {
                detail: { arquivos: files }
            }));
        }
    });

    console.log("[AndroidBridge] Integração nativa pronta ✓");
})();
