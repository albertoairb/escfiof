# Patch Backend (merge por usuário + PDF com todos)

Este patch corrige 2 pontos:

1) Salvamento para TODOS os oficiais:
   - PUT /api/state agora faz MERGE por usuário (header x-user-name)
   - não sobrescreve os dados dos demais oficiais

2) PDF final:
   - GET /api/pdf disponível SOMENTE para:
     - Alberto Franzini Neto
     - Eduardo Mosna Xavier
   - o PDF mostra TODOS os oficiais em tabela (colunas segunda->domingo)

Requisitos:
- Instalar PDFKit no backend:
  npm i pdfkit

Como aplicar:
- substituir o server.js pelo deste patch
- subir para o GitHub / Railway
