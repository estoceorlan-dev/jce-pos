INSERT INTO permissions(code) VALUES ('purchasing.read'),('purchasing.manage'),('purchasing.approve'),('purchasing.receive');
ALTER TABLE inventory_movements ADD COLUMN balance_version integer CHECK(balance_version>0);
CREATE INDEX inventory_movement_version_idx ON inventory_movements(branch_id,variant_id,condition,balance_version DESC);
INSERT INTO role_permissions SELECT r.code,p.code FROM roles r CROSS JOIN permissions p WHERE r.code IN ('admin','manager') AND p.code LIKE 'purchasing.%';
INSERT INTO role_permissions VALUES ('inventory','purchasing.read'),('inventory','purchasing.manage'),('inventory','purchasing.receive');
CREATE TABLE purchase_orders (
 id uuid PRIMARY KEY, branch_id uuid NOT NULL, installation_id uuid NOT NULL,
 supplier_id uuid NOT NULL, number text NOT NULL, status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','partially_received','received','rejected','cancelled','closed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), actor_id uuid NOT NULL REFERENCES users(id), approver_id uuid REFERENCES users(id),
 note text NOT NULL, close_reason text, snapshot jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,branch_id), UNIQUE(branch_id,number),
 FOREIGN KEY(branch_id,installation_id) REFERENCES branch_ownership(branch_id,installation_id),
 FOREIGN KEY(supplier_id,branch_id) REFERENCES suppliers(id,branch_id), CHECK(approver_id IS NULL OR approver_id<>actor_id)
);
CREATE INDEX purchase_order_branch_idx ON purchase_orders(branch_id,status,created_at,id);
CREATE TABLE purchase_order_items (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES purchase_orders(id), variant_id uuid NOT NULL REFERENCES product_variants(id),
 quantity numeric(24,6) NOT NULL CHECK(quantity>0), conversion numeric(24,6) NOT NULL CHECK(conversion>0), unit_cost numeric(24,6) NOT NULL CHECK(unit_cost>=0),
 discount_rate numeric(7,6) NOT NULL CHECK(discount_rate BETWEEN 0 AND 1), tax_rate numeric(7,6) NOT NULL CHECK(tax_rate BETWEEN 0 AND 1),
 tax_inclusive boolean NOT NULL, capitalize_tax boolean NOT NULL, snapshot jsonb NOT NULL,
 UNIQUE(order_id,variant_id), UNIQUE(id,order_id)
);
CREATE TABLE purchases (
 id uuid PRIMARY KEY, branch_id uuid NOT NULL, installation_id uuid NOT NULL, order_id uuid NOT NULL, supplier_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('receipt','reversal')), status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0), actor_id uuid NOT NULL REFERENCES users(id), approver_id uuid REFERENCES users(id),
 original_id uuid, supplier_reference text NOT NULL, delivery_reference text NOT NULL, note text NOT NULL, number text,
 snapshot jsonb NOT NULL, net numeric(30,2), tax numeric(30,2), total numeric(30,2), stock_value numeric(30,6),
 created_at timestamptz NOT NULL DEFAULT now(), posted_at timestamptz,
 UNIQUE(id,branch_id), UNIQUE(branch_id,number),
 FOREIGN KEY(branch_id,installation_id) REFERENCES branch_ownership(branch_id,installation_id),
 FOREIGN KEY(order_id,branch_id) REFERENCES purchase_orders(id,branch_id), FOREIGN KEY(supplier_id,branch_id) REFERENCES suppliers(id,branch_id),
 FOREIGN KEY(original_id,branch_id) REFERENCES purchases(id,branch_id),
 CHECK((kind='reversal')=(original_id IS NOT NULL)), CHECK(approver_id IS NULL OR approver_id<>actor_id),
 CHECK(status<>'posted' OR (number IS NOT NULL AND posted_at IS NOT NULL AND net IS NOT NULL AND tax IS NOT NULL AND total=net+tax AND stock_value IS NOT NULL)),
 CHECK(kind<>'reversal' OR status<>'posted' OR approver_id IS NOT NULL)
);
CREATE UNIQUE INDEX one_purchase_reversal ON purchases(original_id) WHERE status='posted' AND kind='reversal';
CREATE UNIQUE INDEX posted_delivery_reference ON purchases(branch_id,supplier_id,lower(delivery_reference)) WHERE status='posted' AND kind='receipt';
CREATE INDEX purchase_history_idx ON purchases(branch_id,supplier_id,posted_at,id);
CREATE TABLE purchase_items (
 id uuid PRIMARY KEY, purchase_id uuid NOT NULL REFERENCES purchases(id), order_item_id uuid NOT NULL REFERENCES purchase_order_items(id),
 variant_id uuid NOT NULL REFERENCES product_variants(id), condition text NOT NULL CHECK(condition IN ('sellable','damaged','quarantined')),
 quantity numeric(24,6) NOT NULL CHECK(quantity>0), base_quantity numeric(24,6) NOT NULL CHECK(base_quantity>0),
 net numeric(30,2), tax numeric(30,2), total numeric(30,2), discount numeric(30,2), stock_value numeric(30,6), balance_version integer,
 snapshot jsonb NOT NULL, UNIQUE(purchase_id,order_item_id)
);
CREATE TABLE purchase_order_events (
 id uuid PRIMARY KEY, order_id uuid NOT NULL REFERENCES purchase_orders(id), version integer NOT NULL, action text NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(order_id,version)
);
CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON purchase_order_events FOR EACH ROW EXECUTE FUNCTION reject_immutable_change();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON purchase_order_events FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change();
CREATE FUNCTION protect_purchase_order() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status IN ('rejected','cancelled','closed') THEN RAISE EXCEPTION 'Final order is immutable' USING ERRCODE='23514'; END IF;
 IF NOT (CASE OLD.status
  WHEN 'draft' THEN NEW.status IN ('draft','submitted','cancelled')
  WHEN 'submitted' THEN NEW.status IN ('approved','rejected','cancelled')
  WHEN 'approved' THEN NEW.status IN ('approved','partially_received','received','closed')
  WHEN 'partially_received' THEN NEW.status IN ('approved','partially_received','received','closed')
  WHEN 'received' THEN NEW.status IN ('approved','partially_received')
  ELSE false END) THEN RAISE EXCEPTION 'Invalid order transition' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'draft' AND (NEW.supplier_id,NEW.branch_id,NEW.installation_id,NEW.actor_id,NEW.note,NEW.snapshot,NEW.number) IS DISTINCT FROM (OLD.supplier_id,OLD.branch_id,OLD.installation_id,OLD.actor_id,OLD.note,OLD.snapshot,OLD.number) THEN RAISE EXCEPTION 'Submitted order terms are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_order BEFORE UPDATE OR DELETE ON purchase_orders FOR EACH ROW EXECUTE FUNCTION protect_purchase_order();
CREATE FUNCTION protect_purchase_order_item() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.purchase_orders WHERE id IN (NEW.order_id,OLD.order_id) AND status<>'draft') THEN RAISE EXCEPTION 'Submitted order lines are immutable' USING ERRCODE='23514'; END IF;
 RETURN COALESCE(NEW,OLD);
END; $$;
CREATE TRIGGER protect_order_item BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_items FOR EACH ROW EXECUTE FUNCTION protect_purchase_order_item();
CREATE TRIGGER protect_purchase BEFORE UPDATE OR DELETE ON purchases FOR EACH ROW EXECUTE FUNCTION protect_stock_document();
CREATE FUNCTION protect_purchase_item() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.purchases WHERE id IN (NEW.purchase_id,OLD.purchase_id) AND status<>'draft') THEN RAISE EXCEPTION 'Posted receiving lines are immutable' USING ERRCODE='23514'; END IF;
 RETURN COALESCE(NEW,OLD);
END; $$;
CREATE TRIGGER protect_purchase_item BEFORE INSERT OR UPDATE OR DELETE ON purchase_items FOR EACH ROW EXECUTE FUNCTION protect_purchase_item();
