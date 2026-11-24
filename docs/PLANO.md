# Guia de implantação: WhatsApp → n8n → Claude Code

Este guia sobe o **claude-bridge** num VPS que já tem **Evolution API** e **n8n**, e liga tudo para você
conversar com o Claude Code por grupos do WhatsApp.

Funciona em qualquer VPS com Docker. Há instruções para **Easypanel**, **Dokploy** e **Docker Compose puro**.

---

## 1. Visão geral

```
WhatsApp (grupo)
   │
   ▼
Evolution API ──webhook──▶ n8n ──HTTP interno──▶ claude-bridge ──▶ Claude Code (claude -p)
   ▲                         │                        │
   └──────sendText───────────┘◀──────resposta─────────┘
```

| Serviço | O que faz |
|---|---|
| **Evolution** | Recebe e envia mensagens do WhatsApp |
| **n8n** | Filtra (só grupos cadastrados e remetentes permitidos), repassa ao Claude e devolve a resposta |
| **claude-bridge** | API pequena (pasta `bridge/`) que roda o Claude Code na pasta do grupo |

**Cada grupo do WhatsApp = uma pasta** em `/data/grupos/<nome>/` dentro do claude-bridge, com:
- `CLAUDE.md`: as instruções daquele tipo de conversa;
- `.claude/settings.json`: o que o Claude pode fazer ali (ler, escrever, usar curl, pesquisar…);
- arquivos do grupo (anotações, planilhas, `anexos/` com as fotos recebidas).

O histórico de cada grupo fica separado (`claude -p --continue` roda dentro da pasta do grupo).
Mandar `/nova` no grupo começa uma conversa do zero.

Grupos de exemplo incluídos:
- `meu-claude`: assistente geral, com pesquisa na web e notas;
- `viagem`: divide gastos de uma viagem num CSV e calcula quem deve para quem;
- `minha-api`: modelo para registrar coisas numa API sua (gastos, tarefas, pedidos…);
- `_modelo`: base para criar novos (pastas que começam com `_` são ignoradas).

---

## 2. Pré-requisitos

- [ ] Um VPS com Docker e um painel (Easypanel, Dokploy…) ou acesso SSH.
- [ ] **Evolution API** com uma instância conectada ao WhatsApp. Este guia usa a **v2** (diferenças da v1 na seção 13).
- [ ] **n8n** no mesmo servidor.
- [ ] O **endereço interno** de cada serviço na rede Docker (veja a seção 5).
- [ ] A **API key** do Evolution e o **nome da instância**.
- [ ] Uma assinatura do Claude (Pro ou Max) e o Claude Code instalado **no seu computador**, só para gerar o token:
      `npm install -g @anthropic-ai/claude-code`.

---

## 3. Passo 1: gerar o token do Claude (no seu computador)

```bash
claude setup-token
```

Abre o navegador, você faz login e ele mostra um token começando com `sk-ant-oat01-…`. Vale por cerca de 1 ano
e usa a sua assinatura, não a API paga.

> Guarde o token só nas variáveis de ambiente do painel. Nunca coloque em repositório nem mande em chat.

**Se depois der erro 401 "Invalid bearer token"** (há relatos desse problema com o setup-token), use o plano B
no fim do passo 3.

---

## 4. Passo 2: gerar o token do bridge

É uma senha que o n8n usa para falar com o claude-bridge:

```bash
openssl rand -hex 32
```

Ela vai em dois lugares: nas variáveis do claude-bridge e no fluxo do n8n.

---

## 5. Passo 3: subir o claude-bridge

Escolha o seu caso. Em todos eles:

| Item | Valor |
|---|---|
| Código | este repositório (ou um fork seu), pasta **`bridge/`**, com `Dockerfile` |
| Porta interna | `3000` |
| Volume | montado em **`/data`** (grupos, históricos e anexos; sem ele tudo some a cada deploy) |
| Domínio público | **nenhum**. O serviço só precisa ser acessível pela rede interna |
| Rede | a **mesma** do n8n (o n8n precisa chegar nele pelo nome) |

Variáveis de ambiente:

```
BRIDGE_TOKEN=<token do passo 2>
CLAUDE_CODE_OAUTH_TOKEN=<token do passo 1>
CLAUDE_TIMEOUT_MS=180000
TZ=America/Sao_Paulo
# opcionais
CLAUDE_MODEL=sonnet
MINHA_API_URL=
MINHA_API_TOKEN=
```

### 5A. Easypanel

1. Abra o **mesmo projeto** do n8n e do Evolution → **+ Service** → **App** → nome `claude-bridge`.
2. **Source**: GitHub → seu repositório, branch `main`, **Build Path: `/bridge`**.
   (Repositório privado: conecte o GitHub em *Settings → GitHub* antes.)
3. **Environment**: cole as variáveis acima.
4. **Mounts** → *Add Volume* → nome `dados`, **Mount Path `/data`**.
5. **Domains**: não crie domínio (apague se o painel criar um).
6. **Deploy**.

Endereço interno: `http://<projeto>_claude-bridge:3000` (o mesmo padrão vale para os outros serviços,
ex.: `http://<projeto>_n8n:5678`).

### 5B. Dokploy

1. No projeto onde está o n8n → **Create Service → Application** → nome `claude-bridge`.
2. **Provider**: GitHub (ou Git) → seu repositório, branch `main`.
3. **Build Type: Dockerfile**, com o caminho do Dockerfile `bridge/Dockerfile` e o contexto `bridge`
   (os nomes exatos dos campos podem variar com a versão do Dokploy).
4. **Environment**: cole as variáveis acima.
5. **Advanced → Volumes/Mounts**: volume montado em `/data`.
6. **Domains**: não crie domínio.
7. **Deploy**.

Endereço interno: o Dokploy dá a cada aplicação um **nome interno** (aparece na tela do serviço, às vezes
com um sufixo aleatório). Use esse nome: `http://<nome-interno>:3000`. As aplicações do Dokploy ficam na rede
`dokploy-network`; se o n8n ou o Evolution foram criados como *Compose*, confira se também estão nessa rede.

### 5C. Docker Compose (sem painel)

```bash
git clone https://github.com/<voce>/whatsapp-claude-bridge-public.git
cd whatsapp-claude-bridge-public
cp bridge/.env.example bridge/.env   # preencha
# descubra a rede do seu n8n: docker network ls
REDE_DOCKER=<rede-do-n8n> docker compose up -d --build
```

Endereço interno: `http://claude-bridge:3000`.

### Testar o Claude dentro do contêiner

Abra o terminal/console do serviço (ou `docker exec -it <container> sh`) e rode:

```bash
cd /data/grupos/meu-claude && claude -p "diga oi"
```

- Respondeu? Siga para o passo 4.
- Erro 401 / pedindo login → **plano B**: rode `claude` (modo interativo) no console, faça o `/login`
  copiando a URL para o navegador e colando o código de volta. As credenciais ficam no volume
  (`/data/claude-config`) e sobrevivem a novos deploys. Depois remova `CLAUDE_CODE_OAUTH_TOKEN`.

Teste a API, ainda no console:

```bash
curl -s -X POST localhost:3000/mensagem \
  -H "X-Bridge-Token: $BRIDGE_TOKEN" -H "Content-Type: application/json" \
  -d '{"grupo":"meu-claude","texto":"quanto é 17 x 23?"}'
```

---

## 6. Passo 4: criar os grupos no WhatsApp e pegar os IDs

1. Crie os grupos no celular. Se o número conectado no Evolution é **o seu**, crie um grupo só com você
   (o WhatsApp pede ao menos 1 participante: adicione alguém e remova depois).
2. Pegue o ID (JID) de cada grupo, de dentro de qualquer contêiner da mesma rede:
   ```bash
   curl -s "http://<endereco-do-evolution>:8080/group/fetchAllGroups/<INSTANCIA>?getParticipants=false" \
     -H "apikey: <APIKEY>"
   ```
   Procure o `subject` (nome do grupo) e anote o `id`, algo como `120363012345678901@g.us`.
   (Alternativa: depois do passo 6, mande uma mensagem e veja o `remoteJid` na execução do n8n.)

---

## 7. Passo 5: importar o fluxo no n8n

1. n8n → *Workflows* → *Import from file* → `n8n/whatsapp-claude.json`.
2. No nó **Filtrar e montar**, edite o bloco `CONFIG` no topo:
   - `bridgeUrl`: endereço interno do claude-bridge (passo 3)
   - `bridgeToken`: token do passo 2
   - `evolutionUrl`, `evolutionApiKey`, `instancia`
   - `numeroProprio`: `true` se o Evolution está no seu número; `false` se é um número separado (o "bot")
   - `grupos`: `'<JID do grupo>': '<nome da pasta>'`, um por linha
   - `remetentesPermitidos`: no modo número separado, os números liberados (`5511...@s.whatsapp.net`)
3. Salve e **ative** o workflow.
4. Anote a URL do webhook com o endereço interno do n8n: `http://<endereco-do-n8n>:5678/webhook/evolution-claude`.

> Os segredos ficam no nó Code. Para uso pessoal é aceitável; para algo mais organizado, mova para
> *Credentials* (Header Auth) do n8n.

---

## 8. Passo 6: apontar o webhook do Evolution para o n8n

**Pelo Evolution Manager** (v2): instância → *Events* → *Webhook*:
- Enabled: **on**
- URL: `http://<endereco-do-n8n>:5678/webhook/evolution-claude`
- Webhook by Events: **off**
- **Webhook Base64: on** (sem isso fotos chegam sem conteúdo)
- Eventos: **MESSAGES_UPSERT**

**Ou pela API** (v2):
```bash
curl -s -X POST "http://<endereco-do-evolution>:8080/webhook/set/<INSTANCIA>" \
  -H "apikey: <APIKEY>" -H "Content-Type: application/json" \
  -d '{"webhook":{"enabled":true,"url":"http://<endereco-do-n8n>:5678/webhook/evolution-claude","byEvents":false,"base64":true,"events":["MESSAGES_UPSERT"]}}'
```

> O Evolution aceita **uma** URL de webhook por instância. Se a instância já alimenta outro fluxo,
> use um fluxo "roteador" no n8n que repassa para os dois.

---

## 9. Passo 7: testar

1. No grupo `meu-claude`, mande: `oi, tá funcionando?`
2. A resposta chega começando com 🤖.
3. Se não chegar:
   - n8n → *Executions*: não apareceu nada? O webhook do Evolution não está chegando (passo 6).
   - Parou no **Filtrar e montar** sem saída: o JID não está em `grupos`, ou `numeroProprio` está errado.
   - Erro no **Enviar ao Claude**: veja os logs do claude-bridge.
   - Erro no **Responder no WhatsApp**: URL, apikey ou instância do Evolution.

---

## 10. Criar um novo tipo de conversa

1. No console do claude-bridge:
   ```bash
   cp -r /data/grupos/_modelo /data/grupos/academia
   vi /data/grupos/academia/CLAUDE.md                 # o que esse grupo faz
   vi /data/grupos/academia/.claude/settings.json     # o que o Claude pode usar
   ```
   Ou crie a pasta em `bridge/modelos/grupos/` no seu fork e faça deploy: o `entrypoint.sh` copia pastas
   novas para o volume sem mexer nas que já existem.
2. Crie o grupo no WhatsApp, pegue o JID e adicione em `grupos` no n8n.

Permissões úteis no `settings.json`:
- `"WebSearch", "WebFetch"`: pesquisar na web
- `"Bash(curl:*)"`: chamar APIs
- `"Bash(node:*)"`: rodar scripts (contas, gerar arquivos)
- O que não estiver em `allow` é negado automaticamente (não há ninguém para aprovar no meio do caminho).

Para usar uma API sua, veja o grupo `minha-api`: o token entra como variável de ambiente
(`MINHA_API_TOKEN`) e o `CLAUDE.md` manda usar `$MINHA_API_TOKEN`, então o segredo nunca fica em arquivo.

---

## 11. Segurança

- O Claude roda **isolado no contêiner**, com usuário sem privilégios: não enxerga os outros serviços nem o VPS.
- O claude-bridge **não tem domínio público** e exige `X-Bridge-Token`. **Não exponha esse serviço na internet.**
- O n8n só repassa mensagens de grupos cadastrados (e, no modo número separado, só de remetentes liberados).
- Respostas começam com `🤖 `; mensagens com esse prefixo são ignoradas, evitando laço.
- Nunca use `--dangerously-skip-permissions` nem libere `Bash` irrestrito nos grupos: qualquer pessoa que
  consiga escrever num grupo cadastrado estaria dando comandos para o Claude.
- Tokens: só nas variáveis de ambiente e no n8n. Nunca no repositório.

---

## 12. Sobre o WhatsApp

O Evolution, no modo padrão (Baileys), conecta como o WhatsApp Web, por um protocolo **não oficial**. Isso
pode violar os termos do WhatsApp e levar ao banimento do número. Uso pessoal e com pouco volume reduz o
risco, mas não zera. Se for usar, prefira um número secundário. O Evolution também suporta a Cloud API
oficial da Meta (número business, com regras e custos próprios).

---

## 13. Diferenças se o Evolution for v1

| | v2 (padrão aqui) | v1 |
|---|---|---|
| Enviar texto | `{"number": "...", "text": "..."}` | `{"number": "...", "textMessage": {"text": "..."}}` |
| Configurar webhook | `{"webhook": {"enabled", "url", "byEvents", "base64", "events"}}` | `{"url", "webhook_by_events", "webhook_base64", "events"}` no nível de cima |
| Evento | `messages.upsert` | `messages.upsert` |

Na v1, ajuste o corpo do nó **Responder no WhatsApp** para o formato `textMessage`.

---

## 14. Ideias para expandir

1. **Áudio**: transcrever antes de mandar ao Claude, com um serviço Whisper no próprio VPS
   (ex.: `faster-whisper-server`) ou uma API. Entra como um nó a mais no n8n para `audioMessage`.
2. **Painel de grupos**: uma página simples (ou formulário do n8n) para cadastrar grupo → pasta e editar o
   `CLAUDE.md`. O bridge já tem `GET /grupos` para listar.
3. **Apps com API**: transformar o CSV do grupo `viagem` num app web (mais um serviço no VPS) e o grupo passa
   a chamar a API, como no `minha-api`.
4. **Respostas com arquivo**: o Claude gerar PDF/planilha e o n8n enviar pelo `sendMedia` do Evolution.

---

## 15. Referência da API do claude-bridge

`POST /mensagem` (header `X-Bridge-Token`)
```json
{
  "grupo": "meu-claude",
  "texto": "mensagem",
  "remetente": "Nome",
  "arquivo": { "base64": "...", "mimetype": "image/jpeg", "nome": "foto" },
  "nova_conversa": false
}
```
Resposta: `{"resposta": "..."}` ou `{"erro": "..."}`.

- `GET /saude`: `{"ok": true}`
- `GET /grupos` (com token): lista as pastas de grupo válidas

| Variável | Padrão | Para quê |
|---|---|---|
| `BRIDGE_TOKEN` | (obrigatória) | senha entre n8n e bridge |
| `CLAUDE_CODE_OAUTH_TOKEN` | | token da assinatura (`claude setup-token`) |
| `CLAUDE_TIMEOUT_MS` | `180000` | tempo máximo por resposta |
| `CLAUDE_MODEL` | | força um modelo (ex.: `sonnet`) |
| `TZ` | `America/Sao_Paulo` | fuso usado por `date` nos grupos |
| `PORT` | `3000` | porta interna |
| `GRUPOS_DIR` | `/data/grupos` | onde ficam os grupos |
