# Projeto Escala Huawei (API + Front no mesmo serviço)

Este projeto foi preparado para subir via **GitHub → Huawei (container)** sem erro de porta/comunicação, mantendo também execução local via Docker.

## Regras atendidas
- semana automática **segunda a domingo** (semana vigente);
- códigos disponíveis (sem `F` e sem `12H`):
  - `EXP`, `SR`, `FO`, `FO*`, `FOJ`, `MA`, `VE`, `LP`, `CFP_DIA`, `CFP_NOITE`, `OUTROS`;
- `OUTROS` é **digitável** e salva como `OUTROS: <texto>`;
- lançamentos **append-only** (não sobrescreve o que já foi salvo no banco);
- PDF final:
  - somente para **Alberto Franzini Neto** e **Eduardo Mosna Xavier**;
  - acesso protegido por chave (header `x-access-key`).

## Arquitetura
- **um único backend Express** serve:
  - API (`/api/...`)
  - frontend estático (`/public`)
- **MySQL** armazena:
  - `relatorios` (um relatório por semana, criado ao entrar)
  - `lancamentos` (registros por dia, append-only)

## Rodar local (Docker)

1) Crie o `.env`:

```bash
cp .env.example .env
```

2) Ajuste a chave e, se quiser, o nome do banco:

- `SUPERVISOR_KEY=...`
- `DB_NAME=escala`

3) Suba:

```bash
docker compose up --build
```

4) Teste:
- app: `http://localhost:8080`
- health: `http://localhost:8080/api/health`

## Deploy via GitHub → Huawei (container)

### 1) Porta
- o backend escuta a porta `process.env.PORT` (padrão `8080`).
- na Huawei, configure a variável `PORT` conforme o serviço exigir (se não exigir, pode deixar).

### 2) Variáveis de ambiente (mínimo)
Defina no serviço da Huawei:
- `SUPERVISOR_KEY` (obrigatória)
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`

> Observação: o projeto também aceita `DB_DATABASE` por compatibilidade.

### 3) Banco
- se a Huawei oferecer MySQL gerenciado, use as credenciais dela.
- se for rodar MySQL em container separado, garanta que o host/porta estejam acessíveis pelo container do app.

### 4) Build/Start
- build: usa o `Dockerfile`
- start: `node server.js`

## Pontos importantes para não dar erro
- **não fixe porta no frontend**: o `public/app.js` usa `:8080` apenas em `localhost`; em produção usa o mesmo host do site.
- **mesmo origin**: servindo front+api juntos, não há conflito de CORS.
- **variáveis alinhadas**: `docker-compose.yml`, `.env.example` e `server.js` usam `DB_NAME` e `SUPERVISOR_KEY` de forma consistente.
