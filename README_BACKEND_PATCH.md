# Patch Backend - escfiof

Inclui:
- GET /api/state (carrega estado da semana)
- PUT /api/state (salva estado da semana)
- GET /api/pdf (PDF final - somente Alberto e Eduardo Mosna Xavier; nome vem no header x-user-name)

Observações:
1) Para o PDF funcionar, instale a dependência no backend:
   npm i pdfkit

2) O frontend envia automaticamente:
   - x-access-key
   - x-user-name

3) Auth atual: a chave SUPERVISOR_KEY é a mesma usada para acessar state e PDF.
