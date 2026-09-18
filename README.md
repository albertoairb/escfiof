# Escala Semanal de Praças do EM – 4º BPM/M

## Regras principais
- login por nome completo ou nome de guerra, sem diferenciar maiúsculas/minúsculas
- usuário especial `p1` / `aux123`: somente consulta e PDF
- escala atual sempre editável; usuário comum altera somente a própria linha
- administradores mantêm as permissões atuais
- autopreenchimento a partir de sexta-feira às 17h, somente CAP PM ou superior, apenas campos vazios: EXP de segunda a sexta e FO no sábado/domingo
- alerta visual de feriado no topo para feriados nacionais, estaduais de São Paulo e municipais da cidade de São Paulo; o alerta não preenche a escala
- todos os autenticados podem visualizar o PDF atual e a ESCALA ANTERIOR ORIGINAL
- na virada semanal, a escala corrente é congelada como ESCALA ANTERIOR ORIGINAL antes da limpeza dos lançamentos
- mantém apenas uma semana anterior; a primeira ponte histórica é o PDF final de 14/09/2026 a 20/09/2026

## Rodar local (Docker)
1) copie `.env.example` para `.env`
2) `docker compose up -d --build`
3) abra `http://localhost:8080`
