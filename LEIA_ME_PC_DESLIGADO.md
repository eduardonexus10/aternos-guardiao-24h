# Como Deixar seu Servidor Aternos Aberto 24/7 Sem o PC Ligado

## Por que o Guardião antigo não abria (e o que foi corrigido)
1. **Atalho quebrado:** O atalho na Área de Trabalho apontava para `Testes Minecraft\Guardiao_Aternos.bat`, uma pasta que foi apagada. Agora ele aponta para `C:\Users\eduar\Otimizacoes\AternosKeeper\Guardiao_Aternos.bat`.
2. **Falhas no script web:** O script antigo só reconhecia o status `"Conectado"` (ignorando `"Online"`) e clicava em `#restart` a cada 5 minutos, derrubando o servidor em vez de segurá-lo aberto.
3. **Novo Bot Fantasma Nativo (`bot_nuvem.js`):** Criamos um cliente de Minecraft real em **Node.js puro** compatível com o seu **Minecraft 26.1.2 (Protocolo 775)** que entra no servidor `Edubrainex.aternos.me:34601` como o jogador `Guardiao_AFK` consumindo apenas ~15 MB de RAM. Com 1 jogador ativo mexendo a cabeça a cada 20 segundos, **o Aternos não inicia o cronômetro de fechamento**!

---

## Como manter o servidor aberto COM O PC TOTALMENTE DESLIGADO

> **Importante (como funciona o Aternos):**
> - **Para ligar o servidor do zero (Offline → Online):** O site `aternos.org` usa proteção anti-robô da Cloudflare que bloqueia servidores de nuvem gratuitos de apertarem o botão "Iniciar" automaticamente sem um navegador humano.
> - **Para manter aberto 24/7 depois de ligado:** O servidor do jogo (`Edubrainex.aternos.me:34601`) **NÃO** tem Cloudflare e aceita o **Bot Fantasma** de qualquer lugar da nuvem!
> - **Na prática:** Você dá **1 clique em Iniciar** (no PC ou até pelo navegador do celular), o Bot da Nuvem entra em até 15 segundos e **segura o servidor aberto para sempre mesmo se você desligar o PC da tomada**.

### Pré-requisito obrigatório no Painel do Aternos (1 vez só)
1. Entre em `https://aternos.org/options/` no seu servidor.
2. Ative a opção **Pirata (Cracked)** (pois o Bot Fantasma usa conta offline `Guardiao_AFK`, assim como o TLauncher).
3. Garanta que o máximo de jogadores seja pelo menos **2 ou mais** (o seu está em **4**, perfeito!).

---

### Método 1 (Mais Fácil e 100% Grátis): GitHub Actions
Roda diretamente nos servidores em nuvem do GitHub sem precisar de cartão de crédito:
1. Crie uma conta gratuita em [github.com](https://github.com) (se ainda não tiver) e crie um repositório **Privado** chamado `aternos-guardiao`.
2. Envie todo o conteúdo da pasta `C:\Users\eduar\Otimizacoes\AternosKeeper` para esse repositório (atenção especial para incluir a pasta oculta `.github\workflows\guardiao-24h.yml`).
3. No GitHub, abra a aba **Actions** → **Guardião Aternos 24/7 (Sem PC Ligado)** → clique em **Run workflow**.
4. Pronto! Ele rodará na nuvem em ciclos contínuos de 5h15min, renovando automaticamente pelo `schedule` sem depender do seu PC ligado.

*(Dica: contas grátis do GitHub têm 2.000 minutos/mês em repositórios privados; em repositórios **Públicos**, os minutos do GitHub Actions são **ilimitados** — mas lembre-se de que qualquer pessoa que achar um repo público vê o endereço do seu servidor).*

---

### Método 2 (24/7 Ilimitado e Gratuito): Render.com + UptimeRobot
Se quiser rodar indefinidamente sem limite mensal de minutos:
1. Suba a pasta `AternosKeeper` em um repositório privado no GitHub.
2. Crie uma conta grátis no [render.com](https://render.com) → **New Web Service** → conecte o repositório.
   - **Build Command:** *(deixe vazio)*
   - **Start Command:** `npm start`
3. Crie uma conta grátis no [uptimerobot.com](https://uptimerobot.com) e crie um monitor HTTP apontando para a URL que o Render gerou (ex: `https://seu-guardiao.onrender.com`) a cada **5 minutos** — isso impede o plano grátis do Render de dormir!
4. Enquanto estiver no ar, o `Guardiao_AFK` ficará vigiando `Edubrainex.aternos.me:34601` 24 horas por dia com seu PC desligado.

---

### Método 3 (Alternativa Grátis no Bolso): Pelo próprio Celular Android (Termux)
Se você tiver Android:
1. Instale o **Termux** (via F-Droid).
2. Rode `pkg install nodejs` e copie o arquivo `bot_nuvem.js` para o celular.
3. Rode `node bot_nuvem.js` — gasta menos bateria que o WhatsApp e mantém o servidor aberto enquanto você está longe do PC!

---

## Como usar no PC (Atalho da Área de Trabalho)
Clique duas vezes em **Guardião Aternos** na Área de Trabalho e escolha:
- **[1] MODO SUPREMO (Recomendado no PC):** Abre o Chrome só para apertar "Iniciar" no Aternos, conecta o `Guardiao_AFK` assim que o servidor abrir e **fecha o Chrome sozinho** para economizar ~500 MB de RAM no seu Celeron!
- **[2] MODO BOT FANTASMA DIRETO:** Se você já ligou o servidor pelo celular/navegador, conecta o Bot direto gastando apenas ~15 MB de RAM.
- **[3] MODO BOT INTELIGENTE:** Segura o servidor aberto quando está vazio, sai quando alguém entra e volta automaticamente se todo mundo sair.
