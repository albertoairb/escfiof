-- ===============================
-- BANCO: ESCALA SEMANAL
-- ===============================

-- (opcional) criar banco se não existir
CREATE DATABASE IF NOT EXISTS escala
  DEFAULT CHARACTER SET utf8mb4
  DEFAULT COLLATE utf8mb4_unicode_ci;

USE escala;

-- ===============================
-- TABELA: relatorios
-- ===============================
CREATE TABLE IF NOT EXISTS relatorios (
  id INT NOT NULL AUTO_INCREMENT,
  titulo VARCHAR(255) NOT NULL,
  semana_inicio DATE NOT NULL,
  semana_fim DATE NOT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ===============================
-- TABELA: lancamentos (append-only)
-- ===============================
CREATE TABLE IF NOT EXISTS lancamentos (
  id INT NOT NULL AUTO_INCREMENT,
  relatorio_id INT NOT NULL,
  data_dia DATETIME NOT NULL,
  codigo VARCHAR(50) NOT NULL,
  observacao TEXT NULL,
  criado_em DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_lanc_relatorio (relatorio_id),
  KEY idx_lanc_data (data_dia),
  CONSTRAINT fk_lanc_relatorio
    FOREIGN KEY (relatorio_id) REFERENCES relatorios(id)
    ON DELETE CASCADE
    ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;