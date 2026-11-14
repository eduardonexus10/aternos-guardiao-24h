/**
 * Bot Fantasma Anti-AFK para Minecraft 26.1.2 (Protocolo 775)
 * Funciona com consumo mínimo de RAM (< 20 MB), localmente ou na nuvem 24/7
 * sem precisar manter o jogo ou o navegador Chrome abertos.
 */

const net = require('net');
const dns = require('dns');
const zlib = require('zlib');
const crypto = require('crypto');
const http = require('http');

const DEFAULT_HOST = process.env.MC_HOST || 'Edubrainex.aternos.me';
const DEFAULT_PORT = parseInt(process.env.MC_PORT || '34601', 10);
const DEFAULT_BOT_NAME = process.env.MC_BOT_NAME || 'Guardiao_AFK';
const PROTOCOL_VERSION = 775; // Minecraft 26.1.2

// Resolve o IPv4 atual direto do DNS (evita cache antigo quando o Aternos sai do proxy de boot)
function resolveHostIp(host) {
    if (net.isIP(host)) return Promise.resolve(host);
    return new Promise((resolve) => {
        dns.resolve4(host, (err, addresses) => {
            if (!err && addresses && addresses.length > 0) {
                resolve(addresses[0]);
            } else {
                resolve(host);
            }
        });
    });
}

// Codifica um inteiro no formato VarInt (LEB128 32-bit) do Minecraft
function encodeVarInt(value) {
    const bytes = [];
    let val = value >>> 0;
    while (true) {
        if ((val & ~0x7F) === 0) {
            bytes.push(val);
            break;
        }
        bytes.push((val & 0x7F) | 0x80);
        val >>>= 7;
    }
    return Buffer.from(bytes);
}

// Decodifica um VarInt a partir de um Buffer e retorna { value, size } ou null se incompleto
function decodeVarInt(buf, offset = 0) {
    let numRead = 0;
    let result = 0;
    let read;
    do {
        if (offset + numRead >= buf.length) return null;
        read = buf[offset + numRead];
        const value = read & 0x7F;
        result |= value << (7 * numRead);
        numRead++;
        if (numRead > 5) {
            throw new Error('VarInt excedeu o tamanho máximo de 5 bytes');
        }
    } while ((read & 0x80) !== 0);
    return { value: result | 0, size: numRead };
}

function encodeString(str) {
    const strBuf = Buffer.from(str, 'utf8');
    return Buffer.concat([encodeVarInt(strBuf.length), strBuf]);
}

function encodeUShort(port) {
    const buf = Buffer.alloc(2);
    buf.writeUInt16BE(port, 0);
    return buf;
}

// Gera UUID offline determinístico (padrão Minecraft OfflinePlayer)
function generateOfflineUuid(username) {
    const hash = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest();
    hash[6] = (hash[6] & 0x0f) | 0x30; // versão 3
    hash[8] = (hash[8] & 0x3f) | 0x80; // variante RFC 4122
    return hash;
}

// Extrai texto legível mesmo quando o motivo de desconexão vem em NBT binário ou JSON
function extractReadableReason(payload) {
    if (!payload || payload.length === 0) return 'Sem detalhes informados';
    const raw = payload.toString('utf8').replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim();
    try {
        const lenInfo = decodeVarInt(payload, 0);
        if (lenInfo && lenInfo.value > 0 && lenInfo.size + lenInfo.value <= payload.length) {
            const str = payload.subarray(lenInfo.size, lenInfo.size + lenInfo.value).toString('utf8');
            const parsed = JSON.parse(str);
            if (typeof parsed === 'string') return parsed;
            if (parsed.text) return parsed.text + (parsed.extra ? parsed.extra.map(e => e.text || '').join('') : '');
            if (parsed.translate) return parsed.translate;
        }
    } catch (_) {
        // Ignora erro de JSON caso seja NBT binário (Play/Config Disconnect)
    }
    return raw || 'Desconectado pelo servidor';
}

// Monta um pacote respeitando o threshold de compressão atual
function framePacket(packetId, payload, compressionThreshold = -1) {
    const body = Buffer.concat([encodeVarInt(packetId), payload || Buffer.alloc(0)]);
    if (compressionThreshold < 0) {
        return Buffer.concat([encodeVarInt(body.length), body]);
    }
    if (body.length >= compressionThreshold) {
        const compressed = zlib.deflateSync(body);
        const inner = Buffer.concat([encodeVarInt(body.length), compressed]);
        return Buffer.concat([encodeVarInt(inner.length), inner]);
    }
    const inner = Buffer.concat([encodeVarInt(0), body]);
    return Buffer.concat([encodeVarInt(inner.length), inner]);
}

// Realiza um Status Ping (NextState = 1) rápido para saber se o servidor está online e quantos jogadores há
async function pingServer(host = DEFAULT_HOST, port = DEFAULT_PORT, timeoutMs = 6000) {
    const targetIp = await resolveHostIp(host);
    return new Promise((resolve) => {
        const socket = new net.Socket();
        let buffer = Buffer.alloc(0);
        let resolved = false;

        const finish = (result) => {
            if (resolved) return;
            resolved = true;
            socket.destroy();
            resolve(result);
        };

        socket.setTimeout(timeoutMs);
        socket.on('timeout', () => finish({ online: false, error: 'Tempo esgotado (timeout)' }));
        socket.on('error', (err) => finish({ online: false, error: err.message }));

        socket.connect(port, targetIp, () => {
            const handshake = Buffer.concat([
                encodeVarInt(PROTOCOL_VERSION),
                encodeString(host),
                encodeUShort(port),
                encodeVarInt(1) // NextState = Status
            ]);
            socket.write(framePacket(0x00, handshake, -1));
            socket.write(framePacket(0x00, Buffer.alloc(0), -1));
        });

        socket.on('data', (chunk) => {
            buffer = Buffer.concat([buffer, chunk]);
            try {
                const pktLen = decodeVarInt(buffer, 0);
                if (!pktLen || buffer.length < pktLen.size + pktLen.value) return;

                const frame = buffer.subarray(pktLen.size, pktLen.size + pktLen.value);
                const pktId = decodeVarInt(frame, 0);
                if (!pktId || pktId.value !== 0x00) {
                    return finish({ online: false, error: 'Resposta inesperada do servidor' });
                }
                const strLen = decodeVarInt(frame, pktId.size);
                if (!strLen || frame.length < pktId.size + strLen.size + strLen.value) return;

                const jsonStr = frame.subarray(pktId.size + strLen.size, pktId.size + strLen.size + strLen.value).toString('utf8');
                const data = JSON.parse(jsonStr);
                const playersOnline = data.players?.online ?? 0;
                const playersMax = data.players?.max ?? 0;
                const versionName = data.version?.name || 'Desconhecida';
                const descStr = JSON.stringify(data.description || '').toLowerCase();
                const isExplicitOffline =
                    versionName.toLowerCase().includes('offline') ||
                    versionName.toLowerCase().includes('online') ||
                    descStr.includes('offline') ||
                    descStr.includes('aternos.org/connect') ||
                    (playersMax === 0 && playersOnline === 0);
                const isStartingProxy =
                    !isExplicitOffline && (
                        versionName.startsWith('MINECRAFT_') ||
                        Boolean(data.modinfo)
                    );
                const isOfflinePlaceholder = isExplicitOffline || isStartingProxy;

                finish({
                    online: !isOfflinePlaceholder,
                    starting: isStartingProxy,
                    statusLabel: isStartingProxy ? 'Iniciando (Proxy Aternos)' : (isOfflinePlaceholder ? 'Offline (Aternos parado)' : 'Online'),
                    version: versionName,
                    protocol: data.version?.protocol ?? null,
                    players: { online: playersOnline, max: playersMax },
                    sample: data.players?.sample || [],
                    description: data.description
                });
            } catch (err) {
                finish({ online: false, error: err.message });
            }
        });
    });
}

class AternosGhostBot {
    constructor(options = {}) {
        this.host = options.host || DEFAULT_HOST;
        this.port = options.port || DEFAULT_PORT;
        this.username = options.username || DEFAULT_BOT_NAME;
        this.smartLeave = options.smartLeave !== undefined ? Boolean(options.smartLeave) : true;
        this.reconnectDelayMs = options.reconnectDelayMs || 6000;
        this.maxRunMs = options.maxMinutes ? options.maxMinutes * 60 * 1000 : 0;
        this.onLog = options.onLog || ((msg) => console.log(`[${new Date().toLocaleTimeString()}] ${msg}`));
        this.checkingPlayers = false;
        this.standbyLogCount = 0;

        this.socket = null;
        this.recvBuffer = Buffer.alloc(0);
        this.state = 'DISCONNECTED'; // DISCONNECTED, LOGIN, CONFIGURATION, PLAY
        this.compressionThreshold = -1;
        this.antiAfkTimer = null;
        this.pingCheckTimer = null;
        this.watchdogTimer = null;
        this.reconnectTimer = null;
        this.stopped = false;
        this.startTimestamp = Date.now();
        this.connectedSince = null;
        this.lastPacketReceivedAt = 0;
        this.x = 0;
        this.y = 64;
        this.z = 0;
        this.yaw = 0;
        this.pitch = 0;
        this.hasSpawnPos = false;
        this.stats = {
            state: 'Desconectado',
            reconnects: 0,
            keepAlives: 0,
            lastEvent: 'Inicializado',
            playersOnline: 0
        };
    }

    log(msg) {
        this.stats.lastEvent = msg;
        this.onLog(msg);
    }

    sendPacket(packetId, payload = Buffer.alloc(0)) {
        if (!this.socket || this.socket.destroyed) return;
        try {
            const framed = framePacket(packetId, payload, this.compressionThreshold);
            this.socket.write(framed);
        } catch (err) {
            this.log(`Erro ao enviar pacote 0x${packetId.toString(16)}: ${err.message}`);
        }
    }

    start() {
        this.stopped = false;
        this.startTimestamp = Date.now();
        this.log(`Iniciando Bot Fantasma '${this.username}' para ${this.host}:${this.port} (Protocolo ${PROTOCOL_VERSION})...`);
        this.connectCycle();
    }

    stop(reason = 'Parado pelo usuário') {
        this.stopped = true;
        this.cleanupSocket();
        clearTimeout(this.reconnectTimer);
        this.stats.state = 'Encerrado';
        this.log(reason);
    }

    cleanupSocket() {
        clearInterval(this.antiAfkTimer);
        clearInterval(this.pingCheckTimer);
        clearInterval(this.watchdogTimer);
        this.antiAfkTimer = null;
        this.pingCheckTimer = null;
        this.watchdogTimer = null;
        if (this.socket) {
            this.socket.removeAllListeners();
            this.socket.destroy();
            this.socket = null;
        }
        this.recvBuffer = Buffer.alloc(0);
        this.compressionThreshold = -1;
        this.state = 'DISCONNECTED';
        this.connectedSince = null;
        this.hasSpawnPos = false;
    }

    scheduleReconnect(reason, customDelayMs = null, silent = false) {
        if (this.stopped) return;
        this.cleanupSocket();
        this.stats.state = 'Aguardando reconexão';

        if (this.maxRunMs > 0 && Date.now() - this.startTimestamp >= this.maxRunMs) {
            this.log('Tempo limite configurado atingido. Encerrando execução de forma limpa.');
            this.stopped = true;
            return;
        }

        const delayMs = customDelayMs || this.reconnectDelayMs;
        if (!silent) {
            this.log(`${reason} | Tentando novamente em ${Math.round(delayMs / 1000)}s...`);
        }
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = setTimeout(() => {
            if (!this.stopped) {
                this.stats.reconnects++;
                this.connectCycle();
            }
        }, delayMs);
    }

    async connectCycle() {
        if (this.stopped) return;

        if (this.maxRunMs > 0 && Date.now() - this.startTimestamp >= this.maxRunMs) {
            this.log('Tempo máximo da sessão atingido. Encerrando.');
            this.stopped = true;
            return;
        }

        // Verifica antes se o servidor Aternos já está ligado
        const status = await pingServer(this.host, this.port, 5000);
        if (!status.online) {
            return this.scheduleReconnect(`Servidor offline (${status.error || status.statusLabel})`);
        }

        this.stats.playersOnline = status.players.online;

        // No modo inteligente, se já existe um jogador humano jogando, o bot fica em standby fora do servidor
        if (this.smartLeave && status.players.online > 0) {
            if (this.standbyLogCount % 10 === 0) {
                this.log(`Jogador real no mundo (${status.players.online}/${status.players.max}). Bot em standby fora do servidor para você dormir/jogar em paz...`);
            }
            this.standbyLogCount++;
            this.scheduleReconnect('Aguardando todos os jogadores saírem para o bot reassumir', 6000, true);
            this.stats.state = 'Standby (Jogador humano online)';
            return;
        }
        this.standbyLogCount = 0;

        this.connectTcp();
    }

    async connectTcp() {
        this.cleanupSocket();
        this.state = 'LOGIN';
        this.stats.state = 'Conectando...';

        const targetIp = await resolveHostIp(this.host);
        if (this.stopped) return;

        const socket = new net.Socket();
        this.socket = socket;
        this.lastPacketReceivedAt = Date.now();
        socket.setTimeout(30000);

        // Watchdog independente de escrita: reconecta se o servidor parar de enviar pacotes por > 35s
        this.watchdogTimer = setInterval(() => {
            if (this.stopped || this.state === 'DISCONNECTED') return;
            if (Date.now() - this.lastPacketReceivedAt > 35000) {
                this.scheduleReconnect('Sem pacotes recebidos do servidor há 35s (watchdog)');
            }
        }, 10000);

        socket.connect(this.port, targetIp, () => {
            this.log(`TCP conectado em ${this.host}:${this.port} (${targetIp}). Fazendo Login como '${this.username}'...`);

            // 1. Handshake (NextState = 2 -> Login)
            const handshake = Buffer.concat([
                encodeVarInt(PROTOCOL_VERSION),
                encodeString(this.host),
                encodeUShort(this.port),
                encodeVarInt(2)
            ]);
            this.sendPacket(0x00, handshake);

            // 2. Serverbound Hello (0x00) -> Username + Offline UUID (16 bytes)
            const hello = Buffer.concat([
                encodeString(this.username),
                generateOfflineUuid(this.username)
            ]);
            this.sendPacket(0x00, hello);
        });

        socket.on('data', (chunk) => {
            this.lastPacketReceivedAt = Date.now();
            this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
            this.processBuffer();
        });

        socket.on('timeout', () => {
            this.scheduleReconnect('Timeout de comunicação com o servidor');
        });

        socket.on('error', (err) => {
            this.scheduleReconnect(`Erro de rede: ${err.message}`);
        });

        socket.on('close', () => {
            if (!this.stopped && this.state !== 'DISCONNECTED') {
                this.scheduleReconnect('Conexão encerrada pelo servidor');
            }
        });
    }

    processBuffer() {
        while (this.recvBuffer.length > 0 && !this.stopped && this.socket) {
            let packetLenInfo;
            try {
                packetLenInfo = decodeVarInt(this.recvBuffer, 0);
            } catch (err) {
                this.scheduleReconnect(`Erro ao ler tamanho de pacote: ${err.message}`);
                return;
            }
            if (!packetLenInfo) break;

            const totalNeeded = packetLenInfo.size + packetLenInfo.value;
            if (this.recvBuffer.length < totalNeeded) break;

            const frame = this.recvBuffer.subarray(packetLenInfo.size, totalNeeded);
            this.recvBuffer = this.recvBuffer.subarray(totalNeeded);

            let rawPacket = frame;
            if (this.compressionThreshold >= 0) {
                const dataLenInfo = decodeVarInt(frame, 0);
                if (!dataLenInfo) continue;
                const compressedPart = frame.subarray(dataLenInfo.size);
                if (dataLenInfo.value === 0) {
                    rawPacket = compressedPart;
                } else {
                    try {
                        rawPacket = zlib.inflateSync(compressedPart);
                    } catch (err) {
                        this.scheduleReconnect(`Falha ao descompactar pacote zlib: ${err.message}`);
                        return;
                    }
                }
            }

            const packetIdInfo = decodeVarInt(rawPacket, 0);
            if (!packetIdInfo) continue;

            const packetId = packetIdInfo.value;
            const payload = rawPacket.subarray(packetIdInfo.size);
            this.handlePacket(packetId, payload);
        }
    }

    handlePacket(packetId, payload) {
        if (this.state === 'LOGIN') {
            if (packetId === 0x00) {
                // CLIENTBOUND_LOGIN_DISCONNECT
                const reason = extractReadableReason(payload);
                this.scheduleReconnect(`Recusado no Login: ${reason}`);
                return;
            }
            if (packetId === 0x01) {
                // CLIENTBOUND_HELLO (Encryption Request -> servidor exige conta original)
                this.log('AVISO: O servidor Aternos está com modo "Original" ativado (online-mode=true). Para o Bot Fantasma entrar, ative "Pirata / Cracked" nas Opções do Aternos.');
                this.scheduleReconnect('Servidor exige autenticação Mojang');
                return;
            }
            if (packetId === 0x02) {
                // CLIENTBOUND_LOGIN_FINISHED -> envia SERVERBOUND_LOGIN_ACKNOWLEDGED (0x03)
                this.sendPacket(0x03, Buffer.alloc(0));
                this.state = 'CONFIGURATION';
                this.stats.state = 'Configurando...';
                this.sendClientInformation();
                return;
            }
            if (packetId === 0x03) {
                // CLIENTBOUND_LOGIN_COMPRESSION
                const thresh = decodeVarInt(payload, 0);
                if (thresh) {
                    this.compressionThreshold = thresh.value;
                }
                return;
            }
            if (packetId === 0x04) {
                // CLIENTBOUND_CUSTOM_QUERY
                const tx = decodeVarInt(payload, 0);
                if (tx) {
                    const ans = Buffer.concat([encodeVarInt(tx.value), Buffer.from([0x00])]);
                    this.sendPacket(0x02, ans);
                }
                return;
            }
            if (packetId === 0x05) {
                // CLIENTBOUND_COOKIE_REQUEST
                const strLen = decodeVarInt(payload, 0);
                if (strLen) {
                    const key = payload.subarray(strLen.size, strLen.size + strLen.value).toString('utf8');
                    this.sendPacket(0x04, Buffer.concat([encodeString(key), Buffer.from([0x00])]));
                }
                return;
            }
        }

        if (this.state === 'CONFIGURATION') {
            if (packetId === 0x00) {
                // CLIENTBOUND_COOKIE_REQUEST
                const strLen = decodeVarInt(payload, 0);
                if (strLen) {
                    const key = payload.subarray(strLen.size, strLen.size + strLen.value).toString('utf8');
                    this.sendPacket(0x01, Buffer.concat([encodeString(key), Buffer.from([0x00])]));
                }
                return;
            }
            if (packetId === 0x02) {
                // CLIENTBOUND_DISCONNECT
                const reason = extractReadableReason(payload);
                this.scheduleReconnect(`Desconectado na Configuração: ${reason}`);
                return;
            }
            if (packetId === 0x03) {
                // CLIENTBOUND_FINISH_CONFIGURATION -> responde SERVERBOUND_FINISH_CONFIGURATION (0x03)
                this.sendPacket(0x03, Buffer.alloc(0));
                this.state = 'PLAY';
                this.connectedSince = Date.now();
                this.stats.state = 'Online no Servidor (Anti-AFK Ativo)';
                this.log(`SUCESSO! '${this.username}' entrou no servidor! O Aternos NÃO desligará enquanto o bot estiver conectado.`);
                this.startPlayLoops();
                return;
            }
            if (packetId === 0x04) {
                // CLIENTBOUND_KEEP_ALIVE -> responde SERVERBOUND_KEEP_ALIVE (0x04)
                this.sendPacket(0x04, payload.subarray(0, 8));
                return;
            }
            if (packetId === 0x05) {
                // CLIENTBOUND_PING -> responde SERVERBOUND_PONG (0x05)
                this.sendPacket(0x05, payload.subarray(0, 4));
                return;
            }
            if (packetId === 0x09) {
                // CLIENTBOUND_RESOURCE_PACK_PUSH -> aceita para não ser kickado
                if (payload.length >= 16) {
                    const uuid = payload.subarray(0, 16);
                    this.sendPacket(0x06, Buffer.concat([uuid, encodeVarInt(3)])); // ACCEPTED
                    this.sendPacket(0x06, Buffer.concat([uuid, encodeVarInt(0)])); // SUCCESSFULLY_LOADED
                }
                return;
            }
            if (packetId === 0x0E) {
                // CLIENTBOUND_SELECT_KNOWN_PACKS -> responde 0 packs (SERVERBOUND_SELECT_KNOWN_PACKS = 0x07)
                this.sendPacket(0x07, encodeVarInt(0));
                return;
            }
            if (packetId === 0x13) {
                // CLIENTBOUND_CODE_OF_CONDUCT -> aceita (SERVERBOUND_ACCEPT_CODE_OF_CONDUCT = 0x09)
                this.sendPacket(0x09, Buffer.alloc(0));
                return;
            }
        }

        if (this.state === 'PLAY') {
            // Detecção instantânea de entrada de jogador (Player Info Update 0x46 ou System Chat 0x79 após os primeiros 3s)
            if (this.smartLeave && (packetId === 0x46 || packetId === 0x79) && this.connectedSince && (Date.now() - this.connectedSince > 3000)) {
                setTimeout(() => this.checkPlayersAndLeaveIfHuman(), 400);
            }
            if (packetId === 0x0B) {
                // CLIENTBOUND_CHUNK_BATCH_FINISHED -> responde SERVERBOUND_CHUNK_BATCH_RECEIVED (0x0B)
                const floatBuf = Buffer.alloc(4);
                floatBuf.writeFloatBE(20.0, 0);
                this.sendPacket(0x0B, floatBuf);
                return;
            }
            if (packetId === 0x20) {
                // CLIENTBOUND_DISCONNECT
                const reason = extractReadableReason(payload);
                this.scheduleReconnect(`Desconectado do jogo: ${reason}`);
                return;
            }
            if (packetId === 0x2C) {
                // CLIENTBOUND_KEEP_ALIVE -> responde imediatamente SERVERBOUND_KEEP_ALIVE (0x1C)
                this.sendPacket(0x1C, payload.subarray(0, 8));
                this.stats.keepAlives++;
                return;
            }
            if (packetId === 0x31) {
                // CLIENTBOUND_LOGIN -> confirma PLAYER_LOADED (0x2C)
                this.sendPacket(0x2C, Buffer.alloc(0));
                return;
            }
            if (packetId === 0x3D) {
                // CLIENTBOUND_PING -> responde SERVERBOUND_PONG (0x2D)
                this.sendPacket(0x2D, payload.subarray(0, 4));
                return;
            }
            if (packetId === 0x48) {
                // CLIENTBOUND_PLAYER_POSITION -> lê teleportId (VarInt) + PositionMoveRotation e confirma
                const tpId = decodeVarInt(payload, 0);
                if (tpId) {
                    this.sendPacket(0x00, encodeVarInt(tpId.value));
                    const off = tpId.size;
                    if (payload.length >= off + 56) {
                        this.x = payload.readDoubleBE(off);
                        this.y = payload.readDoubleBE(off + 8);
                        this.z = payload.readDoubleBE(off + 16);
                        this.yaw = payload.readFloatBE(off + 48);
                        this.pitch = payload.readFloatBE(off + 52);
                        this.hasSpawnPos = true;
                        this.sendMovePosRot(this.x, this.y, this.z, this.yaw, this.pitch, true);
                    }
                    this.sendPacket(0x2C, Buffer.alloc(0)); // SERVERBOUND_PLAYER_LOADED
                }
                return;
            }
            if (packetId === 0x76) {
                // CLIENTBOUND_START_CONFIGURATION -> volta para CONFIGURATION (0x10)
                clearInterval(this.antiAfkTimer);
                clearInterval(this.pingCheckTimer);
                this.sendPacket(0x10, Buffer.alloc(0));
                this.state = 'CONFIGURATION';
                this.stats.state = 'Reconfigurando...';
                this.sendClientInformation();
                return;
            }
        }
    }

    sendClientInformation() {
        // SERVERBOUND_CLIENT_INFORMATION (0x00 em Configuration): distância mínima (2 chunks) p/ economizar servidor
        const payload = Buffer.concat([
            encodeString('pt_BR'),
            Buffer.from([0x02]),       // viewDistance = 2
            encodeVarInt(0),           // chatMode = enabled
            Buffer.from([0x01]),       // chatColors = true
            Buffer.from([0x7F]),       // displayedSkinParts = all
            encodeVarInt(1),           // mainHand = right
            Buffer.from([0x00, 0x00]), // enableTextFiltering = false, allowServerListings = false
            encodeVarInt(0)            // particleStatus = all
        ]);
        this.sendPacket(0x00, payload);
    }

    // Envia posição e rotação completas para manter o jogador ativo no mundo
    sendMovePosRot(x, y, z, yaw, pitch, onGround = true) {
        const buf = Buffer.alloc(33);
        buf.writeDoubleBE(x, 0);
        buf.writeDoubleBE(y, 8);
        buf.writeDoubleBE(z, 16);
        buf.writeFloatBE(yaw, 24);
        buf.writeFloatBE(pitch, 28);
        buf.writeUInt8(onGround ? 0x01 : 0x00, 32);
        this.sendPacket(0x1F, buf); // SERVERBOUND_MOVE_PLAYER_POS_ROT (0x1F)
    }

    startPlayLoops() {
        clearInterval(this.antiAfkTimer);
        clearInterval(this.pingCheckTimer);
        let afkCycles = 0;

        // Envia pequenos movimentos de cabeça e aceno de mão a cada 15s para evitar kick de AFK
        this.antiAfkTimer = setInterval(() => {
            if (this.state !== 'PLAY' || this.stopped) return;

            this.yaw = (this.yaw + 35) % 360;
            this.pitch = Math.sin(this.yaw * 0.05) * 12;

            if (this.hasSpawnPos) {
                this.sendMovePosRot(this.x, this.y, this.z, this.yaw, this.pitch, true);
            } else {
                const rotBuf = Buffer.alloc(9);
                rotBuf.writeFloatBE(this.yaw, 0);
                rotBuf.writeFloatBE(this.pitch, 4);
                rotBuf.writeUInt8(0x01, 8); // onGround = true
                this.sendPacket(0x20, rotBuf);        // SERVERBOUND_MOVE_PLAYER_ROT (0x20)
            }

            this.sendPacket(0x3F, encodeVarInt(0));   // SERVERBOUND_SWING (0x3F - mão principal)
            this.sendPacket(0x0D, Buffer.alloc(0));   // SERVERBOUND_CLIENT_TICK_END (0x0D)

            afkCycles++;
            if (afkCycles === 1 || afkCycles % 5 === 0) {
                const uptimeSec = this.connectedSince ? Math.floor((Date.now() - this.connectedSince) / 1000) : 0;
                this.log(`Anti-AFK ativo há ${uptimeSec}s (ciclo #${afkCycles}, KeepAlives: ${this.stats.keepAlives}).`);
            }

            if (this.maxRunMs > 0 && Date.now() - this.startTimestamp >= this.maxRunMs) {
                this.stop('Tempo limite da sessão na nuvem atingido. Encerrando limpo para reinício.');
            }
        }, 15000);

        // Checagem contínua de integridade no DNS/servidor real (e modo --auto-leave a cada 8s)
        this.pingCheckTimer = setInterval(() => {
            this.checkPlayersAndLeaveIfHuman();
        }, 8000);
    }

    async checkPlayersAndLeaveIfHuman() {
        if (this.checkingPlayers || this.state !== 'PLAY' || this.stopped) return;
        this.checkingPlayers = true;
        try {
            const status = await pingServer(this.host, this.port, 3500);
            if (this.state !== 'PLAY' || this.stopped) return;
            if (!status.online) {
                this.scheduleReconnect(`Servidor real ainda não está online (${status.statusLabel}). Reconectando...`);
                return;
            }
            this.stats.playersOnline = status.players.online;
            if (status.players.online === 0) {
                this.scheduleReconnect('Servidor real reportou 0 jogadores (IP mudou após o boot). Reconectando no IP real...');
                return;
            }
            if (this.smartLeave && status.players.online >= 2) {
                this.standbyLogCount = 0;
                this.scheduleReconnect(`Jogador real entrou no mundo (${status.players.online}/${status.players.max})! Saindo imediatamente para liberar a cama/sono`);
            }
        } finally {
            this.checkingPlayers = false;
        }
    }
}

// Execução direta via linha de comando ou serviço de nuvem
if (require.main === module) {
    const args = process.argv.slice(2);

    const getArg = (flag, fallback) => {
        const idx = args.indexOf(flag);
        return idx !== -1 && args[idx + 1] ? args[idx + 1] : fallback;
    };

    const host = getArg('--host', DEFAULT_HOST);
    const port = parseInt(getArg('--port', String(DEFAULT_PORT)), 10);
    const username = getArg('--name', DEFAULT_BOT_NAME);
    const maxMinutes = parseInt(getArg('--max-minutes', process.env.MAX_MINUTES || '0'), 10);
    const smartLeave = !args.includes('--no-auto-leave') && process.env.SMART_LEAVE !== 'false';

    if (args.includes('--ping-only')) {
        pingServer(host, port).then((res) => {
            console.log(JSON.stringify(res, null, 2));
            process.exit(0);
        });
    } else {
        const bot = new AternosGhostBot({ host, port, username, smartLeave, maxMinutes });

        // Servidor HTTP opcional (usado por Render/Koyeb/UptimeRobot ou flag --web)
        const webPort = process.env.PORT || (args.includes('--web') ? 8080 : null);
        if (webPort) {
            const server = http.createServer((req, res) => {
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify({
                    bot: bot.username,
                    target: `${bot.host}:${bot.port}`,
                    uptimeSeconds: Math.floor((Date.now() - bot.startTimestamp) / 1000),
                    ...bot.stats
                }, null, 2));
            });
            server.listen(webPort, () => {
                console.log(`[Web/Nuvem] Painel de status ativo na porta ${webPort}`);
            });
        }

        bot.start();

        process.on('SIGINT', () => {
            bot.stop('Encerrando Bot Fantasma (Ctrl+C)...');
            process.exit(0);
        });
    }
}

module.exports = { AternosGhostBot, pingServer };
