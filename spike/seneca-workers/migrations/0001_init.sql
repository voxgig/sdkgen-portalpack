CREATE TABLE devapi_account (id TEXT PRIMARY KEY, status TEXT, init INTEGER);
CREATE TABLE devapi_planet (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  rkey TEXT NOT NULL,
  name TEXT,
  kind TEXT,
  diameter INTEGER
);
CREATE UNIQUE INDEX devapi_planet_acc ON devapi_planet (account_id, rkey);
