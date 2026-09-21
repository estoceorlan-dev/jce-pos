CREATE TABLE users (
 id uuid PRIMARY KEY, username text NOT NULL UNIQUE CHECK(username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
 display_name text NOT NULL CHECK(length(display_name) BETWEEN 1 AND 120), password_hash text NOT NULL,
 disabled boolean NOT NULL DEFAULT false, must_change_password boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE roles (code text PRIMARY KEY, name text NOT NULL, version integer NOT NULL DEFAULT 1, id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());
CREATE TABLE permissions (code text PRIMARY KEY);
CREATE TABLE role_permissions (role_code text REFERENCES roles(code), permission_code text REFERENCES permissions(code), PRIMARY KEY(role_code,permission_code));
CREATE TABLE user_roles (user_id uuid REFERENCES users(id), role_code text REFERENCES roles(code), PRIMARY KEY(user_id,role_code));
CREATE TABLE branch_users (user_id uuid REFERENCES users(id), branch_id uuid REFERENCES branches(id), PRIMARY KEY(user_id,branch_id));
INSERT INTO permissions(code) VALUES ('catalog.read'),('catalog.manage'),('prices.manage'),('partners.read'),('partners.manage'),('contacts.read'),('users.manage'),('branches.manage'),('settings.manage'),('settings.global'),('history.read');
INSERT INTO roles(code,name,version) VALUES ('admin','Administrator / Owner',1),('manager','Manager / Branch Manager',1),('cashier','Cashier',1),('inventory','Inventory Staff',1);
INSERT INTO role_permissions SELECT 'admin',code FROM permissions;
INSERT INTO role_permissions VALUES
 ('manager','catalog.read'),('manager','prices.manage'),('manager','partners.read'),('manager','partners.manage'),('manager','contacts.read'),('manager','users.manage'),('manager','settings.manage'),('manager','history.read'),
 ('cashier','catalog.read'),('cashier','partners.read'),
 ('inventory','catalog.read'),('inventory','partners.read'),('inventory','partners.manage');
CREATE TABLE user_sessions (
 token_hash text PRIMARY KEY CHECK(length(token_hash)=64), user_id uuid NOT NULL REFERENCES users(id),
 branch_id uuid REFERENCES branches(id), locked boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
);
CREATE INDEX session_user_idx ON user_sessions(user_id);
CREATE INDEX session_expiry_idx ON user_sessions(expires_at);
CREATE TABLE login_throttles (key_hash text PRIMARY KEY, attempts integer NOT NULL, reset_at timestamptz NOT NULL);
CREATE TABLE login_logs (id uuid PRIMARY KEY, user_id uuid REFERENCES users(id), success boolean NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX login_user_time_idx ON login_logs(user_id,occurred_at);
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON login_logs FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON login_logs FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change();

CREATE TABLE business_settings (singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), value jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1, id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());
INSERT INTO business_settings DEFAULT VALUES;
CREATE TABLE branch_settings (branch_id uuid PRIMARY KEY REFERENCES branches(id), value jsonb NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1, id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid());
CREATE TABLE settings_history (id uuid PRIMARY KEY, branch_id uuid REFERENCES branches(id), actor_id uuid NOT NULL REFERENCES users(id), version integer NOT NULL, value jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now());
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON settings_history FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON settings_history FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change();
CREATE TABLE registers (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id), terminal_id uuid NOT NULL REFERENCES terminals(id), code text NOT NULL, archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, UNIQUE(branch_id,code));

-- All authorization changes serialize on this lock, including direct runtime SQL.
CREATE FUNCTION lock_authorization() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN PERFORM pg_advisory_xact_lock(74012003); RETURN NULL; END; $$;
CREATE FUNCTION preserve_administrator() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.users) AND NOT EXISTS(SELECT 1 FROM public.users u JOIN public.user_roles r ON r.user_id=u.id WHERE r.role_code='admin' AND NOT u.disabled) THEN
  RAISE EXCEPTION 'At least one active administrator is required' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE TRIGGER auth_lock BEFORE INSERT OR UPDATE OR DELETE ON users FOR EACH STATEMENT EXECUTE FUNCTION lock_authorization();
CREATE TRIGGER auth_lock BEFORE INSERT OR UPDATE OR DELETE ON user_roles FOR EACH STATEMENT EXECUTE FUNCTION lock_authorization();
CREATE TRIGGER auth_lock BEFORE INSERT OR UPDATE OR DELETE ON branch_users FOR EACH STATEMENT EXECUTE FUNCTION lock_authorization();
CREATE TRIGGER auth_lock BEFORE INSERT OR UPDATE OR DELETE ON role_permissions FOR EACH STATEMENT EXECUTE FUNCTION lock_authorization();
CREATE CONSTRAINT TRIGGER recovery_admin AFTER INSERT OR UPDATE OR DELETE ON users DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION preserve_administrator();
CREATE CONSTRAINT TRIGGER recovery_admin AFTER INSERT OR UPDATE OR DELETE ON user_roles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION preserve_administrator();
CREATE FUNCTION revoke_user_sessions() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 UPDATE public.user_sessions SET revoked_at=now() WHERE user_id=COALESCE(NEW.user_id,OLD.user_id) AND revoked_at IS NULL;
 RETURN NULL;
END; $$;
CREATE TRIGGER revoke_membership AFTER INSERT OR UPDATE OR DELETE ON branch_users FOR EACH ROW EXECUTE FUNCTION revoke_user_sessions();
CREATE TRIGGER revoke_roles AFTER INSERT OR UPDATE OR DELETE ON user_roles FOR EACH ROW EXECUTE FUNCTION revoke_user_sessions();
CREATE FUNCTION revoke_changed_user() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NEW.password_hash IS DISTINCT FROM OLD.password_hash OR NEW.disabled IS DISTINCT FROM OLD.disabled THEN
  UPDATE public.user_sessions SET revoked_at=now() WHERE user_id=NEW.id AND revoked_at IS NULL;
 END IF; RETURN NEW;
END; $$;
CREATE TRIGGER revoke_credentials AFTER UPDATE ON users FOR EACH ROW EXECUTE FUNCTION revoke_changed_user();
