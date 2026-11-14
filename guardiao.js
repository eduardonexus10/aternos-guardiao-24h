/**
 * Guardião do Servidor Aternos v2.0 (Híbrido: Painel Web + Bot Fantasma AFK)
 * Desenvolvido para hardware leve (Celeron 6305 / 8 GB RAM):
 *  - Liga o servidor via Chrome CDP (se necessário)
 *  - Conecta o Bot Fantasma Nativo (Protocolo 775 - Minecraft 26.1.2) gastando ~15 MB de RAM
 *  - Impede o cronômetro de fechamento do Aternos sem precisar reiniciar o servidor
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const readline = require('readline');
const { AternosGhostBot, pingServer } = require('./bot_nuvem');

const SERVER_URL = 'https://aternos.org/servers/9ocK5XJ0xz3duXS8/';
const MC_HOST = 'Edubrainex.aternos.me';
const MC_PORT = 34601;
const CDP_PORT = 9222;
const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PRIMARY_CHROME_PROFILE = 'C:\\Users\\eduar\\.gemini\\antigravity\\browser-profile';
const FALLBACK_CHROME_PROFILE = path.join(__dirname, 'chrome-profile');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function notifyBeep() {
    process.stdout.write('\x07');
}

function askQuestion(promptText) {
    return new Promise((resolve) => {
        const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
        rl.question(promptText, (answer) => {
            rl.close();
            resolve(answer.trim());
        });
    });
}

function getAllTabs() {
    return new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${CDP_PORT}/json`, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                try {
                    const tabs = JSON.parse(data);
                    resolve(Array.isArray(tabs) ? tabs : []);
                } catch (_) {
                    resolve([]);
                }
            });
        });
        req.on('error', () => resolve([]));
        req.setTimeout(2000, () => {
            req.destroy();
            resolve([]);
        });
    });
}

async function getAternosTab() {
    const tabs = await getAllTabs();
    if (!tabs.length) return null;
    return (
        tabs.find((t) => t.type === 'page' && t.url && (t.url.includes('aternos.org/server/') || t.url.includes('aternos.org/servers/'))) ||
        tabs.find((t) => t.type === 'page' && t.url && t.url.includes('aternos.org')) ||
        tabs.find((t) => t.type === 'page') ||
        null
    );
}

function spawnChrome(profileDir, startUrl) {
    if (!fs.existsSync(CHROME_PATH)) {
        console.error(`[Erro] Google Chrome não encontrado em: ${CHROME_PATH}`);
        return null;
    }
    const args = [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-allow-origins=*',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
        startUrl
    ];
    try {
        const child = spawn(CHROME_PATH, args, { detached: true, stdio: 'ignore' });
        child.unref();
        return child;
    } catch (e) {
        console.error('[Erro] Não foi possível iniciar o Chrome:', e.message);
        return null;
    }
}

async function ensureChromeOpen() {
    let tab = await getAternosTab();
    if (tab) return tab;

    console.log('[Guardião] Abrindo Google Chrome leve no painel do Aternos...');
    spawnChrome(PRIMARY_CHROME_PROFILE, SERVER_URL);

    for (let i = 0; i < 8; i++) {
        await sleep(1000);
        tab = await getAternosTab();
        if (tab) return tab;
    }

    // Se a porta 9222 não respondeu (ex: outro Chrome travou o perfil principal sem porta CDP), usa perfil dedicado
    console.log('[Guardião] Perfil principal ocupado ou sem porta de controle. Abrindo perfil dedicado do Guardião...');
    if (!fs.existsSync(FALLBACK_CHROME_PROFILE)) {
        fs.mkdirSync(FALLBACK_CHROME_PROFILE, { recursive: true });
    }
    spawnChrome(FALLBACK_CHROME_PROFILE, SERVER_URL);

    for (let i = 0; i < 12; i++) {
        await sleep(1000);
        tab = await getAternosTab();
        if (tab) return tab;
    }
    return null;
}

async function closeAternosChromeTab(tab) {
    if (!tab || !tab.id) return;
    await new Promise((resolve) => {
        const req = http.get(`http://127.0.0.1:${CDP_PORT}/json/close/${tab.id}`, () => resolve());
        req.on('error', () => resolve());
        req.setTimeout(1500, () => {
            req.destroy();
            resolve();
        });
    });
}

async function cdpSend(wsUrl, method, params = {}) {
    return new Promise((resolve, reject) => {
        if (!wsUrl) {
            return reject(new Error('WebSocket URL não informada'));
        }

        const ws = new WebSocket(wsUrl);
        const timeout = setTimeout(() => {
            try { ws.close(); } catch (_) {}
            reject(new Error(`Timeout CDP (${method})`));
        }, 12000);

        ws.onopen = () => {
            ws.send(JSON.stringify({ id: 1, method, params }));
        };

        ws.onmessage = (event) => {
            clearTimeout(timeout);
            try {
                const data = JSON.parse(event.data);
                if (data.id === 1) {
                    ws.close();
                    if (data.error) {
                        return reject(new Error(data.error.message || 'Erro CDP'));
                    }
                    if (data.result?.exceptionDetails) {
                        const errMsg = data.result.exceptionDetails.exception?.description || data.result.exceptionDetails.text || 'Erro JS na aba';
                        return reject(new Error(errMsg));
                    }
                    resolve(data.result);
                }
            } catch (err) {
                ws.close();
                reject(err);
            }
        };

        ws.onerror = (err) => {
            clearTimeout(timeout);
            reject(err);
        };
    });
}

async function evalInTab(tab, code) {
    if (!tab || !tab.webSocketDebuggerUrl) {
        throw new Error('Aba do Chrome não conectada');
    }
    const res = await cdpSend(tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
        expression: code,
        returnByValue: true,
        awaitPromise: true
    });
    return res?.result?.value;
}

async function getServerState(tab) {
    const code = `(() => {
        function isVisible(el) {
            return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length) && window.getComputedStyle(el).display !== 'none');
        }

        const href = window.location.href;
        const pathname = window.location.pathname || '';
        if (href.includes('/go/') || href.includes('/login')) {
            return { needsLogin: true, url: href };
        }

        const isMainServerPage = (
            pathname === '/server/' ||
            pathname === '/server' ||
            pathname === '/servers/9ocK5XJ0xz3duXS8/' ||
            pathname === '/servers/9ocK5XJ0xz3duXS8'
        );
        if (!isMainServerPage) {
            window.location.href = '${SERVER_URL}';
            return { redirecting: true, from: pathname };
        }

        const statusEl = document.querySelector('.statuslabel-label');
        const status = statusEl ? statusEl.innerText.trim() : 'Desconhecido';

        const timeEl = document.querySelector('.server-status-label-left.queue-time, .server-status-label-left');
        const countdown = timeEl ? timeEl.innerText.trim() : '';

        let countdownSeconds = null;
        if (countdown && countdown.includes(':')) {
            const parts = countdown.replace(/[^0-9:]/g, '').split(':');
            if (parts.length >= 2) {
                countdownSeconds = (parseInt(parts[0], 10) * 60) + parseInt(parts[1], 10);
            }
        }

        let players = { current: 0, max: 4 };
        const bodyText = document.body.innerText || '';
        const match = bodyText.match(/(?:Jogadores|Players)[\\s\\S]{0,40}?(\\d+)\\s*\\/\\s*(\\d+)/i);
        if (match) {
            players = { current: parseInt(match[1], 10), max: parseInt(match[2], 10) };
        }

        const startBtn = document.querySelector('#start');
        const restartBtn = document.querySelector('#restart');
        const stopBtn = document.querySelector('#stop');
        const extendBtn = document.querySelector('#extend, .btn-extend, [data-action="extend"]');
        const confirmBtn = document.querySelector('#confirm, .btn-confirm, .queue-confirm, [data-action="confirm"]');
        const modalStartBtn = document.querySelector('dialog button.btn-success, .modal button.btn-success');
        const adblockContinueBtn = [...document.querySelectorAll('button, a.btn, div.btn')].find((el) => {
            if (!isVisible(el)) return false;
            const txt = (el.innerText || '').trim().toLowerCase();
            return (txt === 'continuar' || txt === 'continue' || txt.includes('continuar sem') || txt.includes('continue anyway')) &&
                   document.body.innerText.toLowerCase().includes('adblocker');
        });

        const isOnline = (
            status.toLowerCase().includes('conectado') ||
            status.toLowerCase().includes('online') ||
            isVisible(stopBtn)
        );

        return {
            status,
            isOnline,
            countdown,
            countdownSeconds,
            players,
            canStart: isVisible(startBtn),
            canRestart: isVisible(restartBtn),
            canStop: isVisible(stopBtn),
            canExtend: isVisible(extendBtn),
            hasConfirm: isVisible(confirmBtn),
            hasModalStart: isVisible(modalStartBtn),
            hasAdblockPrompt: Boolean(adblockContinueBtn),
            isRewardedAdActive: window.location.hash.includes('goog_rewarded')
        };
    })()`;

    try {
        return await evalInTab(tab, code);
    } catch (_) {
        return null;
    }
}

async function safeRun(fn, fallback = null) {
    try {
        return await fn();
    } catch (err) {
        console.log(`\n[Aviso] Falha temporária de comunicação com a aba (${err.message}). Tentando novamente...`);
        return fallback;
    }
}

async function clickStart(tab) {
    return await safeRun(() => evalInTab(tab, `(() => {
        function isVisible(el) {
            return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length) && window.getComputedStyle(el).display !== 'none');
        }
        const modalBtns = [...document.querySelectorAll('dialog button.btn-success, .modal button.btn-success, dialog .btn-success, .modal .btn-success')];
        const modalBtn = modalBtns.find(isVisible);
        if (modalBtn) { modalBtn.click(); return 'modal_clicked'; }
        const btn = document.querySelector('#start');
        if (btn && isVisible(btn)) { btn.click(); return 'start_clicked'; }
        return 'not_found';
    })()`), 'error');
}

async function clickExtendOrRestart(tab) {
    return await safeRun(() => evalInTab(tab, `(() => {
        const ext = document.querySelector('#extend, .btn-extend, [data-action="extend"]');
        if (ext && ext.offsetParent !== null) { ext.click(); return 'extended'; }
        const btn = document.querySelector('#restart');
        if (btn && btn.offsetParent !== null) { btn.click(); return 'restarted'; }
        return 'none';
    })()`), 'none');
}

async function clickRestart(tab) {
    return await safeRun(() => evalInTab(tab, `(() => {
        const btn = document.querySelector('#restart');
        if (btn) { btn.click(); return true; }
        return false;
    })()`), false);
}

async function clickStop(tab) {
    return await safeRun(() => evalInTab(tab, `(() => {
        const btn = document.querySelector('#stop');
        if (btn) { btn.click(); return true; }
        return false;
    })()`), false);
}

async function clickConfirmQueue(tab) {
    return await safeRun(() => evalInTab(tab, `(() => {
        const btn = document.querySelector('#confirm, .btn-confirm, .queue-confirm, [data-action="confirm"]');
        if (btn) { btn.click(); return true; }
        return false;
    })()`), false);
}

async function clickAdblockContinue(tab) {
    return await safeRun(() => evalInTab(tab, `(() => {
        function isVisible(el) {
            return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length) && window.getComputedStyle(el).display !== 'none');
        }
        const btn = [...document.querySelectorAll('button, a.btn, div.btn')].find((el) => {
            if (!isVisible(el)) return false;
            const txt = (el.innerText || '').trim().toLowerCase();
            return txt === 'continuar' || txt === 'continue' || txt.includes('continuar sem') || txt.includes('continue anyway');
        });
        if (btn) { btn.click(); return true; }
        return false;
    })()`), false);
}

async function handleRewardedAd() {
    const tabs = await getAllTabs();
    const targets = tabs.filter((t) =>
        t.webSocketDebuggerUrl &&
        ((t.type === 'page' && t.url && t.url.includes('aternos.org')) ||
         (t.type === 'iframe' && t.url && (t.url.includes('safeframe') || t.url.includes('aternos'))))
    );

    const actions = [];
    for (const target of targets) {
        try {
            if (target.type === 'page') {
                await cdpSend(target.webSocketDebuggerUrl, 'Page.bringToFront').catch(() => {});
            }
            await cdpSend(target.webSocketDebuggerUrl, 'Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});

            if (target.type === 'iframe' && target.url.includes('safeframe')) {
                const res = await cdpSend(target.webSocketDebuggerUrl, 'Runtime.evaluate', {
                    expression: `(() => {
                        const confirmDlg = document.querySelector('#close-confirmation-dialog');
                        const resumeBtn = document.querySelector('#resume-ad-button');
                        if (confirmDlg && confirmDlg.offsetParent !== null && resumeBtn) {
                            resumeBtn.click();
                            return 'resumed';
                        }
                        const closeBtn = document.querySelector('#close-button');
                        const dismissEl = document.querySelector('#dismiss-button-element');
                        const countdown = document.querySelector('#count-down-container');
                        const dismissOuter = document.querySelector('#dismiss-button');
                        const readyToClose = (
                            (closeBtn && !closeBtn.classList.contains('disabled')) ||
                            (dismissEl && dismissEl.offsetParent !== null) ||
                            (countdown && countdown.offsetParent === null && dismissOuter)
                        );
                        if (readyToClose) {
                            if (dismissOuter) dismissOuter.click();
                            if (closeBtn) closeBtn.click();
                            if (dismissEl) dismissEl.click();
                            return 'closed';
                        }
                        if (countdown || dismissOuter) return 'counting';
                        return null;
                    })()`,
                    returnByValue: true
                });
                const val = res?.result?.value;
                if (val) actions.push(val);
            }
        } catch (_) {
            // Ignora frames cross-origin transitórios durante recarregamento do anúncio
        }
    }
    return actions;
}

// Modo 2: Apenas Bot Fantasma AFK (zero Chrome, consome ~15 MB de RAM)
async function runBotMode(options = {}) {
    const smartLeave = options.smartLeave ?? true;
    const autoReturn = options.autoReturn ?? true;

    console.clear();
    console.log('===============================================================');
    console.log('        GUARDIÃO ATERNOS v2.0 - MODO BOT FANTASMA AFK');
    console.log('===============================================================');
    console.log(` Servidor : ${MC_HOST}:${MC_PORT} (Minecraft 26.1.2 / Protocolo 775)`);
    console.log(` Modo     : ${smartLeave ? 'Inteligente (sai se entrar gente, volta se esvaziar)' : 'Contínuo (fica no servidor segurando aberto)'}`);
    console.log(' Memória  : ~15 MB de RAM (Chrome fechado!)');
    console.log(' Pressione Ctrl+C para desligar o Bot.\n');

    const bot = new AternosGhostBot({
        host: MC_HOST,
        port: MC_PORT,
        username: 'Guardiao_AFK',
        smartLeave: smartLeave && autoReturn
    });

    bot.start();

    return new Promise((resolve) => {
        process.on('SIGINT', () => {
            bot.stop('Encerrado pelo usuário (Ctrl+C).');
            resolve();
        });
    });
}

// Modo 1: Supremo (Liga via Chrome -> Conecta Bot Fantasma -> Fecha Chrome!)
async function runSupremeMode() {
    console.clear();
    console.log('===============================================================');
    console.log('       GUARDIÃO ATERNOS v2.0 - MODO SUPREMO (AUTO-LIGAR)');
    console.log('===============================================================');
    console.log(' 1. Verifica se o servidor já está aberto (sem abrir o Chrome).');
    console.log(' 2. Se estiver Offline, abre o Chrome só para clicar em Iniciar.');
    console.log(' 3. Assim que ficar Online, conecta o Bot Fantasma e FECHA o Chrome!\n');

    const firstPing = await pingServer(MC_HOST, MC_PORT, 4000);
    if (firstPing.online) {
        console.log('[Sucesso] O servidor JÁ está Online! Pulando Chrome e conectando Bot Fantasma...\n');
        notifyBeep();
        await sleep(1000);
        return runBotMode({ smartLeave: true });
    }

    console.log('[Info] Servidor está Offline. Iniciando Chrome para ligar pelo painel...');
    let tab = await ensureChromeOpen();
    if (!tab) {
        console.error('[Erro] Não foi possível abrir o Chrome com controle CDP na porta 9222.');
        console.error('Dica: Feche todas as janelas do Chrome abertas e tente novamente.');
        await askQuestion('\nPressione Enter para voltar ao menu...');
        return;
    }

    let warnedLogin = false;
    let lastStartClickAt = 0;

    while (true) {
        // Verifica também via ping direto se já abriu a porta do jogo
        const directPing = await pingServer(MC_HOST, MC_PORT, 3000);
        if (directPing.online) {
            console.log('\n[Sucesso] Servidor detectado ONLINE na porta 34601!');
            console.log('[Otimização] Fechando a aba do Chrome para liberar ~500 MB de RAM...');
            await closeAternosChromeTab(tab);
            notifyBeep();
            await sleep(1500);
            return runBotMode({ smartLeave: true });
        }

        tab = (await getAternosTab()) || tab;
        const state = await getServerState(tab);

        if (!state) {
            process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Aguardando página do Aternos responder...   `);
            await sleep(3000);
            continue;
        }

        if (state.needsLogin) {
            if (!warnedLogin) {
                console.log('\n[AÇÃO NECESSÁRIA] Faça login na sua conta do Aternos na janela do Chrome que abriu!');
                console.log('Assim que você entrar na página do servidor, o Guardião continua sozinho.');
                notifyBeep();
                warnedLogin = true;
            }
            await sleep(4000);
            continue;
        }

        if (state.redirecting) {
            console.log('\n[Info] Redirecionando para o painel do servidor...');
            await sleep(3000);
            continue;
        }

        if (state.hasModalStart) {
            console.log('\n[Info] Janela de confirmação / publicidade detectada! Clicando em Iniciar...');
            await clickStart(tab);
            lastStartClickAt = Date.now();
            await sleep(5000);
            continue;
        }

        if (state.hasAdblockPrompt) {
            console.log('\n[Aviso] Mensagem de adblocker detectada. Clicando em Continuar...');
            await clickAdblockContinue(tab);
            await sleep(3000);
            continue;
        }

        if (state.isRewardedAdActive) {
            const adActions = await handleRewardedAd();
            process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Aguardando anúncio recompensado do Aternos (${adActions.join(',') || 'em andamento'})...   `);
            await sleep(3000);
            continue;
        }

        if (state.hasConfirm) {
            console.log('\n[Fila] Botão de confirmação de fila detectado! Clicando automaticamente...');
            await clickConfirmQueue(tab);
            notifyBeep();
            await sleep(4000);
            continue;
        }

        if (state.isOnline) {
            console.log('\n[Sucesso] Painel indicou Servidor Online! Fechando aba do Chrome e ativando Bot Fantasma...');
            await closeAternosChromeTab(tab);
            notifyBeep();
            await sleep(2000);
            return runBotMode({ smartLeave: true });
        }

        if (state.canStart || state.status.toLowerCase().includes('offline')) {
            const sinceLastClick = Date.now() - lastStartClickAt;
            if (sinceLastClick > 18000) {
                console.log(`\n[${new Date().toLocaleTimeString()}] Servidor Offline. Clicando em 'Iniciar'...`);
                await clickStart(tab);
                lastStartClickAt = Date.now();
                await sleep(4000);
            } else {
                process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Aguardando transição do Aternos (${Math.ceil((18000 - sinceLastClick) / 1000)}s)...   `);
                await sleep(3000);
            }
            continue;
        }

        process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Status no painel: [${state.status}] | Aguardando iniciar...   `);
        await sleep(3000);
    }
}

// Modo 3: Vigília Web Clássica (mantida e corrigida)
async function runKeeper(targetMinutes = 30) {
    console.clear();
    console.log('===============================================================');
    console.log('         GUARDIÃO ATERNOS v2.0 - VIGÍLIA WEB CLÁSSICA');
    console.log('===============================================================');
    console.log(` Meta de vigília: ${targetMinutes === 9999 ? 'Contínuo (Até você entrar)' : targetMinutes + ' minutos'}`);
    console.log(' Pressione Ctrl+C a qualquer momento para fechar o Guardião.\n');

    let tab = await ensureChromeOpen();
    if (!tab) {
        console.error('[Erro] Não foi possível encontrar a aba do Aternos no Chrome.');
        await askQuestion('\nPressione Enter para voltar...');
        return;
    }

    const startTime = Date.now();
    const maxDurationMs = targetMinutes * 60 * 1000;
    let renewals = 0;
    let warnedLogin = false;

    while (true) {
        const elapsedMs = Date.now() - startTime;
        if (targetMinutes !== 9999 && elapsedMs >= maxDurationMs) {
            console.log(`\n[Info] Tempo limite de vigília (${targetMinutes} minutos) atingido.`);
            break;
        }

        tab = (await getAternosTab()) || tab;
        const state = await getServerState(tab);

        if (!state) {
            process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Aguardando conexão com a aba do Aternos...   `);
            await sleep(3000);
            continue;
        }

        if (state.needsLogin) {
            if (!warnedLogin) {
                console.log('\n[AÇÃO NECESSÁRIA] Faça login na sua conta do Aternos no Chrome que foi aberto.');
                warnedLogin = true;
            }
            await sleep(4000);
            continue;
        }

        if (state.redirecting) {
            console.log('\n[Info] Navegando para a página principal do servidor...');
            await sleep(3000);
            continue;
        }

        if (state.hasModalStart) {
            console.log('\n[Atenção] Janela de confirmação detectada! Confirmando...');
            await clickStart(tab);
            await sleep(4000);
            continue;
        }

        if (state.hasAdblockPrompt) {
            console.log('\n[Aviso] Mensagem de adblocker detectada. Clicando em Continuar...');
            await clickAdblockContinue(tab);
            await sleep(3000);
            continue;
        }

        if (state.isRewardedAdActive) {
            const adActions = await handleRewardedAd();
            process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Aguardando anúncio recompensado (${adActions.join(',') || 'em andamento'})...   `);
            await sleep(3000);
            continue;
        }

        if (state.hasConfirm) {
            console.log('\n[Atenção] Confirmação de fila detectada! Confirmando automaticamente...');
            await clickConfirmQueue(tab);
            notifyBeep();
            await sleep(3000);
            continue;
        }

        if (!state.isOnline && (state.canStart || state.status.toLowerCase().includes('offline'))) {
            console.log(`\n[${new Date().toLocaleTimeString()}] Servidor Offline. Clicando em 'Iniciar'...`);
            await clickStart(tab);
            await sleep(4000);
            continue;
        }

        if (state.isOnline) {
            if (state.players && state.players.current > 0) {
                console.log('\n\n===============================================================');
                console.log(` [SUCESSO] ${state.players.current} jogador(es) detectado(s) no servidor!`);
                console.log(' O Aternos não desligará mais enquanto houver gente jogando.');
                console.log('===============================================================\n');
                notifyBeep();
                break;
            }

            const secs = state.countdownSeconds;
            const timeStr = state.countdown || (secs !== null ? `${secs}s` : 'N/A');
            const remainingMeta = targetMinutes === 9999 ? '∞' : `${Math.ceil((maxDurationMs - elapsedMs) / 60000)}m`;

            process.stdout.write(`\r[${new Date().toLocaleTimeString()}] ONLINE | Jogadores: 0/${state.players.max} | Tempo Aternos: ${timeStr} | Vigília: ${remainingMeta} | Renovações: ${renewals}   `);

            if (secs !== null && secs <= 45 && secs > 0) {
                console.log(`\n[Guardião] Faltam ${secs}s! Tentando estender/renovar tempo...`);
                const action = await clickExtendOrRestart(tab);
                console.log(`[Guardião] Ação executada: ${action}`);
                renewals++;
                notifyBeep();
                await sleep(5000);
                continue;
            }
        } else {
            const elapsedMin = Math.floor(elapsedMs / 60000);
            process.stdout.write(`\r[${new Date().toLocaleTimeString()}] Status: [${state.status}] | Aguardando ficar online... (${elapsedMin}m)   `);
        }

        await sleep(3000);
    }
}

async function showCloudGuide() {
    console.clear();
    console.log('===============================================================');
    console.log('    COMO DEIXAR O SERVIDOR ATERNOS 24/7 COM O PC DESLIGADO');
    console.log('===============================================================');
    console.log('');
    console.log(' POR QUE O PC PODE FICAR DESLIGADO?');
    console.log(' O Aternos fecha o servidor quando há 0 jogadores. Como já criamos');
    console.log(' o Bot Fantasma nativo (bot_nuvem.js) para o seu servidor na');
    console.log(' versão 26.1.2, você pode rodá-lo DE GRAÇA na nuvem!');
    console.log('');
    console.log(' OPÇÃO A - GITHUB ACTIONS (100% Grátis, sem cartão, roda 24/7):');
    console.log('  1. Crie uma conta grátis em github.com e um repositório privado.');
    console.log('  2. Envie os arquivos da pasta C:\\Users\\eduar\\Otimizacoes\\AternosKeeper');
    console.log('     (incluindo a pasta oculta .github\\workflows\\guardiao-24h.yml).');
    console.log('  3. No GitHub, vá na aba "Actions" e clique em "Run workflow".');
    console.log('  4. IMPORTANTE: No painel do Aternos (Opções), deixe "Pirata (Cracked)"');
    console.log('     ativado para o bot entrar sem conta Mojang.');
    console.log('');
    console.log(' OPÇÃO B - RENDER.COM / KOYEB / SQUARECLOUD:');
    console.log('  1. Suba a pasta AternosKeeper no GitHub e conecte no Render.com');
    console.log('     (Web Service grátis, comando start: "npm start").');
    console.log('  2. Coloque o link gerado no UptimeRobot.com (a cada 5 min).');
    console.log('');
    console.log(' RESUMO DE USO DIÁRIO:');
    console.log('  - Dê 1 clique para ligar o servidor (pelo PC ou pelo celular).');
    console.log('  - O Bot na Nuvem entra em segundos e SEGURA o servidor aberto');
    console.log('    para sempre, mesmo se você DESLIGAR seu PC da tomada!');
    console.log('');
    console.log(' Guia completo salvo em:');
    console.log(`  ${path.join(__dirname, 'LEIA_ME_PC_DESLIGADO.md')}`);
    console.log('===============================================================');
    await askQuestion('\nPressione Enter para voltar ao menu...');
}

async function showMenu() {
    while (true) {
        console.clear();
        console.log('===============================================================');
        console.log('               GUARDIÃO DO SERVIDOR ATERNOS v2.0');
        console.log('===============================================================');
        console.log(` Servidor: ${MC_HOST}:${MC_PORT} (Minecraft 26.1.2)`);

        const ping = await pingServer(MC_HOST, MC_PORT, 2500);
        if (ping.online) {
            console.log(` Status Direto: [ONLINE] | Jogadores: [${ping.players.online}/${ping.players.max}] | Versão: ${ping.version}`);
        } else {
            console.log(` Status Direto: [OFFLINE / Fechado] (${ping.error || ping.statusLabel})`);
        }

        console.log('---------------------------------------------------------------');
        console.log(' Escolha uma opção:');
        console.log('');
        console.log(' [1] MODO SUPREMO (Liga pelo Chrome -> Ativa Bot AFK -> Fecha Chrome)');
        console.log(' [2] MODO BOT FANTASMA DIRETO (Servidor já aberto -> 0 Chrome, ~15MB RAM)');
        console.log(' [3] MODO BOT INTELIGENTE (Sai quando você entra, volta se esvaziar)');
        console.log(' [4] MODO VIGÍLIA WEB CLÁSSICO (Mantém pelo Chrome: 30m / 60m / Contínuo)');
        console.log(' [5] INICIAR / REINICIAR / PARAR SERVIDOR (Via Chrome)');
        console.log(' [6] GUIA: COMO DEIXAR ABERTO 24/7 COM O PC DESLIGADO (Nuvem Grátis)');
        console.log(' [0] Sair');
        console.log('===============================================================');

        const opt = await askQuestion('\nOpção escolhida: ');

        if (opt === '1') {
            await runSupremeMode();
        } else if (opt === '2') {
            await runBotMode({ smartLeave: true });
        } else if (opt === '3') {
            await runBotMode({ smartLeave: true, autoReturn: true });
        } else if (opt === '4') {
            console.log('\n [1] 30 Minutos  [2] 60 Minutos  [3] Contínuo (até entrar jogador)');
            const sub = await askQuestion('Escolha a duração: ');
            if (sub === '1') await runKeeper(30);
            else if (sub === '2') await runKeeper(60);
            else if (sub === '3') await runKeeper(9999);
        } else if (opt === '5') {
            console.log('\n [1] Iniciar Servidor  [2] Reiniciar  [3] Parar');
            const sub = await askQuestion('Ação: ');
            const curTab = await ensureChromeOpen();
            if (!curTab) {
                console.log('[Erro] Não foi possível conectar ao Chrome.');
                await askQuestion('Enter para continuar...');
                continue;
            }
            if (sub === '1') {
                await clickStart(curTab);
                console.log('Comando Iniciar enviado!');
            } else if (sub === '2') {
                await clickRestart(curTab);
                console.log('Comando Reiniciar enviado!');
            } else if (sub === '3') {
                await clickStop(curTab);
                console.log('Comando Parar enviado!');
            }
            await sleep(1500);
        } else if (opt === '6') {
            await showCloudGuide();
        } else if (opt === '0') {
            process.exit(0);
        }
    }
}

const args = process.argv.slice(2);
if (args.includes('--supreme')) {
    runSupremeMode();
} else if (args.includes('--bot')) {
    runBotMode({ smartLeave: args.includes('--auto-leave') });
} else if (args.includes('--ping')) {
    pingServer(MC_HOST, MC_PORT).then((s) => console.log(JSON.stringify(s, null, 2)));
} else if (args.includes('--keep')) {
    const idx = args.indexOf('--keep');
    const mins = parseInt(args[idx + 1], 10) || 30;
    runKeeper(mins);
} else if (args.includes('--start')) {
    ensureChromeOpen().then((tab) => clickStart(tab)).then(() => console.log('Iniciado!'));
} else if (args.includes('--restart')) {
    ensureChromeOpen().then((tab) => clickRestart(tab)).then(() => console.log('Reiniciado!'));
} else if (args.includes('--status')) {
    ensureChromeOpen().then((tab) => getServerState(tab)).then((s) => console.log(JSON.stringify(s, null, 2)));
} else {
    showMenu();
}
