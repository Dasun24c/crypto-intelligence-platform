-- Extensions and one schema per area (data model §1). Forward-only: never edit an applied migration.
CREATE EXTENSION IF NOT EXISTS timescaledb;
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS app;
CREATE SCHEMA IF NOT EXISTS market;
CREATE SCHEMA IF NOT EXISTS analysis;
CREATE SCHEMA IF NOT EXISTS ai;
CREATE SCHEMA IF NOT EXISTS alerts;
CREATE SCHEMA IF NOT EXISTS ops;

-- Nobody but the owner creates objects in the public schema.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
