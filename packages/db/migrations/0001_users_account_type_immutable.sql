-- ADR 0008 / D17: o tipo de conta é imutável. Único trigger da v1 (o drizzle-kit não gera
-- triggers, por isso esta migration é "custom": drizzle-kit generate --custom).
CREATE FUNCTION users_account_type_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.account_type IS DISTINCT FROM OLD.account_type THEN
    RAISE EXCEPTION 'account_type é imutável (ADR 0008)'
      USING ERRCODE = 'check_violation', CONSTRAINT = 'users_account_type_immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER users_account_type_immutable
  BEFORE UPDATE OF account_type ON users
  FOR EACH ROW EXECUTE FUNCTION users_account_type_immutable();
