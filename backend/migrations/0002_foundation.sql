-- Infrastructure only: domain documents and financial/stock ledgers arrive
-- with their modules. Never put store records or demo accounts in migrations.
CREATE TABLE installations (
  id uuid PRIMARY KEY,
  singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branches (
  id uuid PRIMARY KEY,
  code text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 160),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE branch_ownership (
  branch_id uuid PRIMARY KEY REFERENCES branches(id),
  installation_id uuid NOT NULL REFERENCES installations(id),
  UNIQUE (branch_id, installation_id)
);

CREATE FUNCTION require_branch_owner() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.branch_ownership WHERE branch_id = NEW.id) THEN
    RAISE EXCEPTION 'Branch requires an owner installation' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER branch_has_owner AFTER INSERT ON branches
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_branch_owner();

CREATE TABLE terminals (
  id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, code),
  UNIQUE (id, branch_id, installation_id),
  FOREIGN KEY (branch_id, installation_id) REFERENCES branch_ownership(branch_id, installation_id)
);

CREATE TABLE document_sequences (
  branch_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  series text NOT NULL CHECK (series ~ '^[A-Z0-9][A-Z0-9_-]{0,31}$'),
  last_number bigint NOT NULL CHECK (last_number > 0),
  PRIMARY KEY (branch_id, series),
  FOREIGN KEY (branch_id, installation_id) REFERENCES branch_ownership(branch_id, installation_id)
);

CREATE TABLE document_numbers (
  document_id uuid PRIMARY KEY,
  branch_id uuid NOT NULL,
  installation_id uuid NOT NULL,
  series text NOT NULL,
  number bigint NOT NULL CHECK (number > 0),
  allocated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (branch_id, series, number),
  FOREIGN KEY (branch_id, series) REFERENCES document_sequences(branch_id, series),
  FOREIGN KEY (branch_id, installation_id) REFERENCES branch_ownership(branch_id, installation_id)
);

CREATE TABLE idempotency_requests (
  installation_id uuid NOT NULL REFERENCES installations(id),
  operation text NOT NULL CHECK (operation ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  request_key uuid NOT NULL,
  request_hash text NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (installation_id, operation, request_key),
  CHECK ((response IS NULL) = (completed_at IS NULL)),
  CHECK (response IS NULL OR octet_length(response::text) <= 65536)
);

CREATE TABLE audit_logs (
  id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES installations(id),
  branch_id uuid,
  actor_id uuid,
  request_id uuid NOT NULL,
  action text NOT NULL CHECK (action ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  entity_id uuid NOT NULL,
  entity_version integer NOT NULL CHECK (entity_version > 0),
  reason_code text CHECK (reason_code ~ '^[A-Z][A-Z0-9_]{0,63}$'),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (branch_id, installation_id) REFERENCES branch_ownership(branch_id, installation_id)
);
CREATE INDEX audit_branch_time_idx ON audit_logs(branch_id, occurred_at, id);
CREATE INDEX audit_entity_idx ON audit_logs(entity_type, entity_id, occurred_at);
CREATE INDEX audit_request_idx ON audit_logs(request_id);

CREATE TABLE sync_queue (
  event_id uuid PRIMARY KEY,
  installation_id uuid NOT NULL REFERENCES installations(id),
  branch_id uuid,
  aggregate_type text NOT NULL CHECK (aggregate_type ~ '^[a-z][a-z0-9_]{0,39}$'),
  aggregate_id uuid NOT NULL,
  aggregate_version integer NOT NULL CHECK (aggregate_version > 0),
  schema_version integer NOT NULL CHECK (schema_version > 0),
  event_type text NOT NULL CHECK (event_type ~ '^[a-z][a-z0-9_.-]{0,79}$'),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object' AND octet_length(payload::text) <= 65536),
  occurred_at timestamptz NOT NULL,
  checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'acknowledged')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  acknowledged_at timestamptz,
  CHECK ((status = 'acknowledged') = (acknowledged_at IS NOT NULL)),
  UNIQUE (installation_id, aggregate_type, aggregate_id, aggregate_version, event_type),
  FOREIGN KEY (branch_id, installation_id) REFERENCES branch_ownership(branch_id, installation_id)
);
CREATE INDEX sync_delivery_idx ON sync_queue(status, created_at, event_id);
CREATE INDEX sync_branch_idx ON sync_queue(branch_id, created_at);

-- Defense in depth alongside runtime privilege restrictions. Reuse these
-- triggers on each later stock/financial ledger; migrations alone own DDL.
CREATE FUNCTION reject_immutable_change() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  RAISE EXCEPTION 'Immutable record cannot be changed' USING ERRCODE = '55000';
END;
$$;

CREATE FUNCTION guard_sequence_increase() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (NEW.branch_id, NEW.installation_id, NEW.series) IS DISTINCT FROM
     (OLD.branch_id, OLD.installation_id, OLD.series) OR NEW.last_number <> OLD.last_number + 1 THEN
    RAISE EXCEPTION 'Document sequence must advance by one' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER sequence_increase BEFORE UPDATE ON document_sequences
FOR EACH ROW EXECUTE FUNCTION guard_sequence_increase();
CREATE TRIGGER sequence_no_delete BEFORE DELETE ON document_sequences
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER sequence_no_truncate BEFORE TRUNCATE ON document_sequences
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change();

CREATE FUNCTION guard_idempotency_completion() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF OLD.completed_at IS NOT NULL OR NEW.response IS NULL OR NEW.completed_at IS NULL
     OR (NEW.installation_id, NEW.operation, NEW.request_key, NEW.request_hash, NEW.created_at)
        IS DISTINCT FROM (OLD.installation_id, OLD.operation, OLD.request_key, OLD.request_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'Invalid idempotency transition' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER idempotency_completion BEFORE UPDATE ON idempotency_requests
FOR EACH ROW EXECUTE FUNCTION guard_idempotency_completion();
CREATE TRIGGER idempotency_no_delete BEFORE DELETE ON idempotency_requests
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER idempotency_no_truncate BEFORE TRUNCATE ON idempotency_requests
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change();

-- A crash/rollback can never leave a committed, in-progress claim.
CREATE FUNCTION require_completed_idempotency() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.idempotency_requests WHERE installation_id = NEW.installation_id
      AND operation = NEW.operation AND request_key = NEW.request_key AND completed_at IS NULL) THEN
    RAISE EXCEPTION 'Idempotency claim must complete in its transaction' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER idempotency_completed AFTER INSERT ON idempotency_requests
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_completed_idempotency();

CREATE FUNCTION guard_outbox_envelope() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['status','attempts','acknowledged_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['status','attempts','acknowledged_at']) THEN
    RAISE EXCEPTION 'Outbox envelope is immutable' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER outbox_envelope BEFORE UPDATE ON sync_queue
FOR EACH ROW EXECUTE FUNCTION guard_outbox_envelope();
CREATE TRIGGER outbox_no_delete BEFORE DELETE ON sync_queue
FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER outbox_no_truncate BEFORE TRUNCATE ON sync_queue
FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change();

DO $$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY['installations','branch_ownership','terminals','document_numbers','audit_logs'] LOOP
    EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_change()', target);
    EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change()', target);
  END LOOP;
END;
$$;
