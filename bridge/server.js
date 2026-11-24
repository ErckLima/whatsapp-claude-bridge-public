// claude-bridge: recebe mensagens do n8n e roda o Claude Code na pasta do grupo.
// Sem dependências externas: só Node 20+.

import http from "node:http";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.PORT || 3000);
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN || "";
const GRUPOS_DIR = process.env.GRUPOS_DIR || "/data/grupos";
const TIMEOUT_MS = Number(process.env.CLAUDE_TIMEOUT_MS || 180000);
const MAX_BODY = 25 * 1024 * 1024; // 25 MB (fotos em base64)
const CLAUDE_BIN = process.env.CLAUDE_BIN || "claude";
const MODELO = process.env.CLAUDE_MODEL || ""; // opcional, ex.: "sonnet"

if (!BRIDGE_TOKEN) {
  console.error("BRIDGE_TOKEN não definido. Abortando.");
  process.exit(1);
}

// Uma fila por grupo: duas mensagens do mesmo grupo nunca rodam ao mesmo tempo
// (o --continue precisa da conversa anterior terminada).
const filas = new Map();
function enfileirar(grupo, tarefa) {
  const anterior = filas.get(grupo) || Promise.resolve();
  const atual = anterior.catch(() => {}).then(tarefa);
  filas.set(grupo, atual);
  atual.finally(() => {
    if (filas.get(grupo) === atual) filas.delete(grupo);
  });
  return atual;
}

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function responder(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let tamanho = 0;
    const partes = [];
    req.on("data", (c) => {
      tamanho += c.length;
      if (tamanho > MAX_BODY) {
        reject(Object.assign(new Error("corpo grande demais"), { status: 413 }));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf8")));
    req.on("error", reject);
  });
}

const EXT = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "application/pdf": ".pdf",
  "audio/ogg": ".ogg",
  "audio/ogg; codecs=opus": ".ogg",
  "audio/mpeg": ".mp3",
};

function salvarAnexo(pastaGrupo, arquivo) {
  if (!arquivo || !arquivo.base64) return null;
  const pasta = path.join(pastaGrupo, "anexos");
  fs.mkdirSync(pasta, { recursive: true });
  const ext = EXT[(arquivo.mimetype || "").toLowerCase()] || "";
  const base = (arquivo.nome || "arquivo").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 60);
  const nome = `${Date.now()}-${base}${base.endsWith(ext) ? "" : ext}`;
  fs.writeFileSync(path.join(pasta, nome), Buffer.from(arquivo.base64, "base64"));
  return `anexos/${nome}`;
}

function rodarClaude(pastaGrupo, prompt, continuar) {
  return new Promise((resolve) => {
    const args = ["-p", prompt, "--output-format", "json"];
    if (continuar) args.push("--continue");
    if (MODELO) args.push("--model", MODELO);

    const filho = spawn(CLAUDE_BIN, args, {
      cwd: pastaGrupo,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    filho.stdout.on("data", (d) => (out += d));
    filho.stderr.on("data", (d) => (err += d));

    const timer = setTimeout(() => {
      filho.kill("SIGTERM");
      resolve({ ok: false, erro: `tempo esgotado (${TIMEOUT_MS / 1000}s)` });
    }, TIMEOUT_MS);

    filho.on("close", (code) => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(out);
        if (json.is_error) {
          resolve({ ok: false, erro: json.result || "erro do Claude", custo: json.total_cost_usd });
        } else {
          resolve({ ok: true, resposta: json.result || "", custo: json.total_cost_usd });
        }
      } catch {
        resolve({ ok: false, erro: `saída inválida (código ${code}): ${(err || out).slice(0, 500)}` });
      }
    });
    filho.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, erro: `não consegui iniciar o claude: ${e.message}` });
    });
  });
}

async function tratarMensagem(corpo) {
  const grupo = String(corpo.grupo || "");
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(grupo)) {
    return [400, { erro: "grupo inválido (use letras minúsculas, números e hífen)" }];
  }
  const pastaGrupo = path.join(GRUPOS_DIR, grupo);
  if (!fs.existsSync(path.join(pastaGrupo, "CLAUDE.md"))) {
    return [404, { erro: `grupo '${grupo}' não existe (falta ${grupo}/CLAUDE.md)` }];
  }

  let texto = String(corpo.texto || "").trim();
  let continuar = corpo.nova_conversa !== true;
  if (/^\/nova\b/i.test(texto)) {
    continuar = false;
    texto = texto.replace(/^\/nova\b/i, "").trim();
    if (!texto && !corpo.arquivo) {
      // Só "/nova": marca para a próxima mensagem começar do zero.
      fs.writeFileSync(path.join(pastaGrupo, ".nova-conversa"), "");
      return [200, { resposta: "Ok, a próxima mensagem começa uma conversa nova." }];
    }
  }
  const marcador = path.join(pastaGrupo, ".nova-conversa");
  if (fs.existsSync(marcador)) {
    continuar = false;
    fs.rmSync(marcador);
  }

  const anexo = salvarAnexo(pastaGrupo, corpo.arquivo);
  if (!texto && !anexo) return [400, { erro: "mensagem vazia" }];

  const linhas = [];
  if (corpo.remetente) linhas.push(`[Mensagem de ${corpo.remetente} no WhatsApp]`);
  if (texto) linhas.push(texto);
  if (anexo) linhas.push(`\nArquivo anexado (${corpo.arquivo.mimetype || "?"}): ${anexo}`);
  const prompt = linhas.join("\n");

  // Se for a primeira conversa do grupo, --continue falha; tenta de novo sem.
  let r = await rodarClaude(pastaGrupo, prompt, continuar);
  if (!r.ok && continuar && /no conversation found|nenhuma conversa/i.test(r.erro)) {
    r = await rodarClaude(pastaGrupo, prompt, false);
  }
  log(`[${grupo}]`, r.ok ? "ok" : `ERRO: ${r.erro}`, r.custo != null ? `custo≈$${r.custo}` : "");
  return r.ok ? [200, { resposta: r.resposta }] : [500, { erro: r.erro }];
}

const servidor = http.createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/saude") {
      return responder(res, 200, { ok: true });
    }
    if (req.method === "GET" && req.url === "/grupos") {
      if (req.headers["x-bridge-token"] !== BRIDGE_TOKEN) return responder(res, 401, { erro: "token inválido" });
      const grupos = fs.existsSync(GRUPOS_DIR)
        ? fs.readdirSync(GRUPOS_DIR).filter((g) => !g.startsWith("_") && fs.existsSync(path.join(GRUPOS_DIR, g, "CLAUDE.md")))
        : [];
      return responder(res, 200, { grupos });
    }
    if (req.method === "POST" && req.url === "/mensagem") {
      if (req.headers["x-bridge-token"] !== BRIDGE_TOKEN) return responder(res, 401, { erro: "token inválido" });
      let corpo;
      try {
        corpo = JSON.parse(await lerCorpo(req));
      } catch (e) {
        return responder(res, e.status || 400, { erro: e.status ? e.message : "JSON inválido" });
      }
      const grupo = String(corpo.grupo || "");
      const [status, obj] = await enfileirar(grupo, () => tratarMensagem(corpo));
      return responder(res, status, obj);
    }
    responder(res, 404, { erro: "rota não encontrada" });
  } catch (e) {
    log("erro inesperado:", e);
    responder(res, 500, { erro: "erro interno" });
  }
});

servidor.listen(PORT, () => log(`claude-bridge ouvindo na porta ${PORT}, grupos em ${GRUPOS_DIR}`));
