INSERT INTO permissions(code) VALUES ('inventory.read'),('inventory.manage'),('inventory.approve'),('inventory.reserve');
INSERT INTO role_permissions SELECT r.code,p.code FROM roles r CROSS JOIN permissions p WHERE r.code IN ('admin','manager') AND p.code LIKE 'inventory.%';
INSERT INTO role_permissions VALUES ('inventory','inventory.read'),('inventory','inventory.manage'),('inventory','inventory.reserve');

CREATE TABLE inventories (
 branch_id uuid NOT NULL REFERENCES branches(id), variant_id uuid NOT NULL REFERENCES product_variants(id),
 condition text NOT NULL CHECK(condition IN ('sellable','damaged','quarantined')),
 quantity numeric(24,6) NOT NULL DEFAULT 0 CHECK(quantity>=0), value numeric(30,6) NOT NULL DEFAULT 0 CHECK(value>=0),
 reserved numeric(24,6) NOT NULL DEFAULT 0 CHECK(reserved>=0 AND reserved<=quantity), version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(branch_id,variant_id,condition), CHECK(condition='sellable' OR reserved=0), CHECK(quantity>0 OR value=0)
);
CREATE TABLE stock_adjustments (
 id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id), installation_id uuid NOT NULL REFERENCES installations(id),
 kind text NOT NULL CHECK(kind IN ('opening','adjustment','count','reconcile')), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),
 version integer NOT NULL DEFAULT 1, actor_id uuid NOT NULL REFERENCES users(id), approver_id uuid REFERENCES users(id),
 reason_code text NOT NULL, note text NOT NULL, source_reference text NOT NULL DEFAULT '', source_document_id uuid,
 opening_date date, manifest jsonb NOT NULL, content_hash text NOT NULL, number text,
 created_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz,
 UNIQUE(id,branch_id), FOREIGN KEY(source_document_id,branch_id) REFERENCES stock_adjustments(id,branch_id),
 FOREIGN KEY(branch_id,installation_id) REFERENCES branch_ownership(branch_id,installation_id),
 CHECK(approver_id IS NULL OR approver_id<>actor_id), CHECK(status<>'posted' OR (approver_id IS NOT NULL AND posted_at IS NOT NULL AND number IS NOT NULL))
);
CREATE INDEX stock_document_branch_idx ON stock_adjustments(branch_id,created_at,id);
CREATE TABLE stock_adjustment_items (
 id uuid PRIMARY KEY, document_id uuid NOT NULL REFERENCES stock_adjustments(id), variant_id uuid NOT NULL REFERENCES product_variants(id),
 condition text NOT NULL CHECK(condition IN ('sellable','damaged','quarantined')), quantity numeric(24,6) NOT NULL, unit_cost numeric(24,6) NOT NULL CHECK(unit_cost>=0),
 expected_version integer NOT NULL, expected_quantity numeric(24,6) NOT NULL, expected_value numeric(30,6) NOT NULL, expected_reserved numeric(24,6) NOT NULL,
 ledger_quantity numeric(24,6) NOT NULL, ledger_value numeric(30,6) NOT NULL, ledger_reserved numeric(24,6) NOT NULL,
 snapshot jsonb NOT NULL, UNIQUE(document_id,variant_id,condition)
);
CREATE TABLE stock_counts (
 document_id uuid PRIMARY KEY REFERENCES stock_adjustments(id), branch_id uuid NOT NULL REFERENCES branches(id),
 started_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
 FOREIGN KEY(document_id,branch_id) REFERENCES stock_adjustments(id,branch_id)
);
CREATE TABLE stock_count_items (
 document_id uuid NOT NULL REFERENCES stock_counts(document_id), variant_id uuid NOT NULL REFERENCES product_variants(id), PRIMARY KEY(document_id,variant_id)
);
CREATE TABLE inventory_movements (
 id uuid PRIMARY KEY, installation_id uuid NOT NULL REFERENCES installations(id), branch_id uuid NOT NULL REFERENCES branches(id), variant_id uuid NOT NULL REFERENCES product_variants(id),
 condition text NOT NULL CHECK(condition IN ('sellable','damaged','quarantined')), quantity numeric(24,6) NOT NULL, value numeric(30,6) NOT NULL,
 source_type text NOT NULL, source_id uuid NOT NULL, source_line_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_type,source_id,source_line_id), CHECK(quantity<>0 OR value<>0),
 FOREIGN KEY(branch_id,installation_id) REFERENCES branch_ownership(branch_id,installation_id)
);
CREATE INDEX inventory_movement_scope_idx ON inventory_movements(branch_id,variant_id,condition,occurred_at,id);
CREATE TABLE inventory_reservations (
 id uuid PRIMARY KEY, installation_id uuid NOT NULL REFERENCES installations(id), branch_id uuid NOT NULL REFERENCES branches(id), variant_id uuid NOT NULL REFERENCES product_variants(id),
 quantity numeric(24,6) NOT NULL CHECK(quantity>0), reference text NOT NULL, actor_id uuid NOT NULL REFERENCES users(id),
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','released')), created_at timestamptz NOT NULL DEFAULT now(), released_at timestamptz,
 CHECK((status='active')=(released_at IS NULL)),
 FOREIGN KEY(branch_id,installation_id) REFERENCES branch_ownership(branch_id,installation_id)
);
CREATE INDEX reservation_scope_idx ON inventory_reservations(branch_id,variant_id) WHERE status='active';
CREATE TABLE inventory_reservation_events (
 id uuid PRIMARY KEY, reservation_id uuid NOT NULL REFERENCES inventory_reservations(id), action text NOT NULL CHECK(action IN ('allocated','released')),
 actor_id uuid NOT NULL REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(reservation_id,action)
);
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['inventory_movements','inventory_reservation_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_change()',target);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change()',target);
 END LOOP;
END; $$;
CREATE FUNCTION protect_stock_document() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.status<>'draft' THEN RAISE EXCEPTION 'Final stock documents are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER final_stock_document BEFORE UPDATE OR DELETE ON stock_adjustments FOR EACH ROW EXECUTE FUNCTION protect_stock_document();
CREATE FUNCTION protect_stock_item() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.stock_adjustments WHERE id IN (NEW.document_id,OLD.document_id) AND status<>'draft') THEN
  RAISE EXCEPTION 'Final stock items are immutable' USING ERRCODE='23514';
 END IF;
 RETURN COALESCE(NEW,OLD);
END; $$;
CREATE TRIGGER final_stock_item BEFORE INSERT OR UPDATE OR DELETE ON stock_adjustment_items FOR EACH ROW EXECUTE FUNCTION protect_stock_item();
CREATE FUNCTION protect_reservation_transition() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF OLD.status<>'active' OR NEW.status<>'released' THEN RAISE EXCEPTION 'Reservations can only be released once' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER reservation_transition BEFORE UPDATE ON inventory_reservations FOR EACH ROW EXECUTE FUNCTION protect_reservation_transition();
