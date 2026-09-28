INSERT INTO permissions(code) VALUES ('checkout.use'),('checkout.approve'),('sales.read');
INSERT INTO role_permissions SELECT r.code,p.code FROM roles r CROSS JOIN permissions p WHERE r.code IN ('admin','manager') AND p.code IN ('checkout.use','checkout.approve','sales.read');
INSERT INTO role_permissions VALUES ('cashier','checkout.use'),('cashier','sales.read');
ALTER TABLE registers ADD UNIQUE(id,branch_id,terminal_id);
CREATE TABLE register_sessions (
 id uuid PRIMARY KEY, branch_id uuid NOT NULL, installation_id uuid NOT NULL, register_id uuid NOT NULL, terminal_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), opening_float numeric(20,2) NOT NULL CHECK(opening_float>=0),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','closed')), opened_at timestamptz NOT NULL DEFAULT now(), closed_at timestamptz,
 UNIQUE(id,branch_id),
 FOREIGN KEY(register_id,branch_id,terminal_id) REFERENCES registers(id,branch_id,terminal_id),
 FOREIGN KEY(terminal_id,branch_id,installation_id) REFERENCES terminals(id,branch_id,installation_id)
);
CREATE UNIQUE INDEX one_terminal_session ON register_sessions(terminal_id) WHERE status='open';
CREATE UNIQUE INDEX one_register_session ON register_sessions(register_id) WHERE status='open';
CREATE TABLE checkout_carts (
 id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id), actor_id uuid NOT NULL REFERENCES users(id), session_id uuid NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version>0), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','held','cancelled','posted')),
 input jsonb NOT NULL, quote jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,branch_id),
 FOREIGN KEY(session_id,branch_id) REFERENCES register_sessions(id,branch_id)
);
CREATE INDEX checkout_cart_branch_idx ON checkout_carts(branch_id,actor_id,status,updated_at,id);
CREATE FUNCTION protect_checkout_cart() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status IN ('posted','cancelled') THEN RAISE EXCEPTION 'Final carts are immutable' USING ERRCODE='23514'; END IF;
 IF (NEW.branch_id,NEW.actor_id,NEW.session_id) IS DISTINCT FROM (OLD.branch_id,OLD.actor_id,OLD.session_id) THEN RAISE EXCEPTION 'Cart ownership is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_cart BEFORE UPDATE OR DELETE ON checkout_carts FOR EACH ROW EXECUTE FUNCTION protect_checkout_cart();
CREATE TABLE checkout_approvals (
 id uuid PRIMARY KEY, cart_id uuid NOT NULL REFERENCES checkout_carts(id), cart_version integer NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), reason text NOT NULL, quote_hash text NOT NULL, expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX checkout_approval_cart_idx ON checkout_approvals(cart_id,cart_version,expires_at);
CREATE TABLE sales (
 id uuid PRIMARY KEY, installation_id uuid NOT NULL, branch_id uuid NOT NULL, session_id uuid NOT NULL, cart_id uuid NOT NULL UNIQUE,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted')),
 request_key uuid NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), customer_id uuid, approval_id uuid REFERENCES checkout_approvals(id),
 number text NOT NULL, net numeric(20,2) NOT NULL CHECK(net>=0), tax numeric(20,2) NOT NULL CHECK(tax>=0), total numeric(20,2) NOT NULL CHECK(total>0),
 discount numeric(20,2) NOT NULL CHECK(discount>=0), cash_effect numeric(20,2) NOT NULL CHECK(cash_effect>=0), change numeric(20,2) NOT NULL CHECK(change>=0),
 snapshot jsonb NOT NULL, posted_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,branch_id), UNIQUE(branch_id,number), UNIQUE(branch_id,request_key), CHECK(total=net+tax),
 FOREIGN KEY(branch_id,installation_id) REFERENCES branch_ownership(branch_id,installation_id),
 FOREIGN KEY(session_id,branch_id) REFERENCES register_sessions(id,branch_id),
 FOREIGN KEY(cart_id,branch_id) REFERENCES checkout_carts(id,branch_id), FOREIGN KEY(customer_id,branch_id) REFERENCES customers(id,branch_id)
);
CREATE INDEX sale_branch_time_idx ON sales(branch_id,posted_at DESC,id);
CREATE TABLE sale_items (
 id uuid PRIMARY KEY, sale_id uuid NOT NULL REFERENCES sales(id), variant_id uuid NOT NULL REFERENCES product_variants(id),
 quantity numeric(24,6) NOT NULL CHECK(quantity>0), base_quantity numeric(24,6) NOT NULL CHECK(base_quantity>0),
 price numeric(20,2) NOT NULL CHECK(price>=0), discount numeric(20,2) NOT NULL CHECK(discount>=0), net numeric(20,2) NOT NULL CHECK(net>=0),
 tax numeric(20,2) NOT NULL CHECK(tax>=0), total numeric(20,2) NOT NULL CHECK(total=net+tax), cost numeric(30,6) NOT NULL CHECK(cost>=0),
 snapshot jsonb NOT NULL, UNIQUE(sale_id,variant_id)
);
CREATE TABLE sale_payments (
 id uuid PRIMARY KEY, sale_id uuid NOT NULL REFERENCES sales(id), method text NOT NULL CHECK(method IN ('cash','card','ewallet')),
 amount numeric(20,2) NOT NULL CHECK(amount>0), applied numeric(20,2) NOT NULL CHECK(applied>=0 AND applied<=amount), reference text NOT NULL,
 UNIQUE(sale_id,method), CHECK(method='cash' OR (length(reference)>0 AND applied=amount))
);
CREATE TABLE register_cash_entries (
 id uuid PRIMARY KEY, session_id uuid NOT NULL REFERENCES register_sessions(id), actor_id uuid NOT NULL REFERENCES users(id),
 kind text NOT NULL CHECK(kind IN ('opening','sale')), amount numeric(20,2) NOT NULL CHECK(amount>=0), sale_id uuid UNIQUE REFERENCES sales(id), occurred_at timestamptz NOT NULL DEFAULT now(),
 CHECK((kind='sale')=(sale_id IS NOT NULL))
);
CREATE UNIQUE INDEX one_session_opening ON register_cash_entries(session_id) WHERE kind='opening';
CREATE TABLE receipt_print_events (
 id uuid PRIMARY KEY, sale_id uuid NOT NULL REFERENCES sales(id), actor_id uuid NOT NULL REFERENCES users(id),
 outcome text NOT NULL CHECK(outcome IN ('requested','confirmed','failed')), attempt_id uuid REFERENCES receipt_print_events(id), occurred_at timestamptz NOT NULL DEFAULT now(),
 CHECK((outcome='requested')=(attempt_id IS NULL))
);
CREATE UNIQUE INDEX one_print_result ON receipt_print_events(attempt_id) WHERE attempt_id IS NOT NULL;
CREATE FUNCTION protect_sale() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'draft' OR NEW.status<>'posted' OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'Committed sales are immutable' USING ERRCODE='23514'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.sale_items WHERE sale_id=NEW.id)
 OR (SELECT (sum(net),sum(tax),sum(total),sum(discount)) FROM public.sale_items WHERE sale_id=NEW.id) IS DISTINCT FROM ROW(NEW.net,NEW.tax,NEW.total,NEW.discount)
 OR (SELECT sum(applied) FROM public.sale_payments WHERE sale_id=NEW.id) IS DISTINCT FROM NEW.total
 OR (SELECT sum(amount-applied) FROM public.sale_payments WHERE sale_id=NEW.id) IS DISTINCT FROM NEW.change
 OR COALESCE((SELECT sum(applied) FROM public.sale_payments WHERE sale_id=NEW.id AND method='cash'),0) IS DISTINCT FROM NEW.cash_effect
 OR (SELECT amount FROM public.register_cash_entries WHERE sale_id=NEW.id) IS DISTINCT FROM NEW.cash_effect
 THEN RAISE EXCEPTION 'Sale lines, payments and cash must reconcile' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_sale BEFORE UPDATE OR DELETE ON sales FOR EACH ROW EXECUTE FUNCTION protect_sale();
CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON sales FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change();
CREATE FUNCTION require_posted_sale() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.sales WHERE id=NEW.id AND status<>'posted') THEN RAISE EXCEPTION 'Incomplete sales cannot commit' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER require_posted_sale AFTER INSERT OR UPDATE ON sales DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_posted_sale();
CREATE FUNCTION protect_sale_component() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.sales WHERE id=NEW.sale_id AND status='draft') THEN RAISE EXCEPTION 'Committed sale components are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_sale_item BEFORE INSERT ON sale_items FOR EACH ROW EXECUTE FUNCTION protect_sale_component();
CREATE TRIGGER protect_sale_payment BEFORE INSERT ON sale_payments FOR EACH ROW EXECUTE FUNCTION protect_sale_component();
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['checkout_approvals','sale_items','sale_payments','register_cash_entries','receipt_print_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_change()',target);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change()',target);
 END LOOP;
END; $$;
