DROP TABLE IF EXISTS settings;
DROP TABLE IF EXISTS products;
DROP TABLE IF EXISTS cards;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS sessions;

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE products (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price INTEGER NOT NULL,
  cover TEXT DEFAULT '',
  created_at INTEGER NOT NULL
);

CREATE TABLE cards (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL,
  code TEXT NOT NULL,
  used INTEGER DEFAULT 0,
  order_no TEXT,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_cards_product ON cards(product_id, used);
CREATE UNIQUE INDEX idx_cards_code ON cards(product_id, code);

CREATE TABLE orders (
  id TEXT PRIMARY KEY,
  order_no TEXT UNIQUE NOT NULL,
  product_id TEXT NOT NULL,
  product_name TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount INTEGER NOT NULL,
  contact TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending',
  cards_json TEXT DEFAULT '[]',
  created_at INTEGER NOT NULL,
  paid_at INTEGER
);
CREATE INDEX idx_orders_no ON orders(order_no);
CREATE INDEX idx_orders_status ON orders(status);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  username TEXT NOT NULL,
  expire INTEGER NOT NULL
);

INSERT INTO settings(key, value) VALUES
  ('siteName', '自动发卡'),
  ('siteNotice', '欢迎光临，支付后自动发货。'),
  ('contact', '客服 QQ：10000'),
  ('adminUsername', 'admin'),
  ('adminPassword', 'admin888');
