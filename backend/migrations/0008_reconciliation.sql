INSERT INTO permissions(code) VALUES ('returns.use'),('returns.approve'),('register.close'),('cash.approve');
INSERT INTO role_permissions SELECT r.code,p.code FROM roles r CROSS JOIN permissions p WHERE r.code IN ('admin','manager') AND p.code IN ('returns.use','returns.approve','register.close','cash.approve');
INSERT INTO role_permissions VALUES ('cashier','returns.use'),('cashier','register.close');
ALTER TABLE register_sessions ADD COLUMN business_date date NOT NULL DEFAULT (now() AT TIME ZONE 'Asia/Manila')::date;
UPDATE register_sessions SET business_date=(opened_at AT TIME ZONE 'Asia/Manila')::date;
CREATE TABLE correction_requests (
 id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id), actor_id uuid NOT NULL REFERENCES users(id),
 session_id uuid NOT NULL, kind text NOT NULL CHECK(kind IN ('return','cash','close')), input jsonb NOT NULL, quote jsonb NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posted')), created_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(id,branch_id), FOREIGN KEY(session_id,branch_id) REFERENCES register_sessions(id,branch_id)
);
CREATE INDEX correction_branch_idx ON correction_requests(branch_id,created_at DESC,id);
CREATE TABLE correction_approvals (
 id uuid PRIMARY KEY, request_id uuid NOT NULL REFERENCES correction_requests(id), actor_id uuid NOT NULL REFERENCES users(id),
 quote_hash text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sales_returns (
 id uuid PRIMARY KEY REFERENCES correction_requests(id), branch_id uuid NOT NULL, sale_id uuid NOT NULL, session_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id), approval_id uuid NOT NULL UNIQUE REFERENCES correction_approvals(id), number text NOT NULL,
 reversal boolean NOT NULL, reason_code text NOT NULL, reason text NOT NULL, net numeric(20,2) NOT NULL CHECK(net>=0), tax numeric(20,2) NOT NULL CHECK(tax>=0), total numeric(20,2) NOT NULL CHECK(total=net+tax),
 posted_at timestamptz NOT NULL DEFAULT now(), UNIQUE(branch_id,number),
 FOREIGN KEY(sale_id,branch_id) REFERENCES sales(id,branch_id), FOREIGN KEY(session_id,branch_id) REFERENCES register_sessions(id,branch_id)
);
CREATE INDEX return_sale_idx ON sales_returns(sale_id);
CREATE INDEX return_session_idx ON sales_returns(session_id);
CREATE INDEX sale_session_idx ON sales(session_id);
CREATE TABLE sales_return_items (
 id uuid PRIMARY KEY, return_id uuid NOT NULL REFERENCES sales_returns(id), sale_item_id uuid NOT NULL REFERENCES sale_items(id),
 quantity numeric(24,6) NOT NULL CHECK(quantity>0), base_quantity numeric(24,6) NOT NULL CHECK(base_quantity>0),
 condition text NOT NULL CHECK(condition IN ('sellable','damaged','quarantined')), discount numeric(20,2) NOT NULL CHECK(discount>=0),
 net numeric(20,2) NOT NULL CHECK(net>=0), tax numeric(20,2) NOT NULL CHECK(tax>=0), total numeric(20,2) NOT NULL CHECK(total=net+tax), cost numeric(30,6) NOT NULL CHECK(cost>=0), UNIQUE(return_id,sale_item_id)
);
CREATE INDEX return_item_sale_idx ON sales_return_items(sale_item_id);
CREATE TABLE refund_payments (
 id uuid PRIMARY KEY, return_id uuid NOT NULL REFERENCES sales_returns(id), method text NOT NULL CHECK(method IN ('cash','card','ewallet')),
 amount numeric(20,2) NOT NULL CHECK(amount>0), reference text NOT NULL, UNIQUE(return_id,method), CHECK(method='cash' OR length(reference)>0)
);
CREATE TABLE cash_movements (
 id uuid PRIMARY KEY REFERENCES correction_requests(id), session_id uuid NOT NULL REFERENCES register_sessions(id), actor_id uuid NOT NULL REFERENCES users(id),
 approval_id uuid UNIQUE REFERENCES correction_approvals(id), kind text NOT NULL CHECK(kind IN ('paid_in','paid_out','safe_drop')), amount numeric(20,2) NOT NULL CHECK(amount>0), reason text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(), CHECK(kind='paid_in' OR approval_id IS NOT NULL)
);
CREATE TABLE register_closures (
 id uuid PRIMARY KEY REFERENCES correction_requests(id), session_id uuid NOT NULL UNIQUE REFERENCES register_sessions(id), actor_id uuid NOT NULL REFERENCES users(id),
 approval_id uuid NOT NULL UNIQUE REFERENCES correction_approvals(id), summary jsonb NOT NULL, counts jsonb NOT NULL, variance jsonb NOT NULL, reason text NOT NULL, closed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX cash_movement_session_idx ON cash_movements(session_id);
CREATE FUNCTION protect_correction_request() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'pending' OR NEW.status<>'posted' OR (to_jsonb(NEW)-'status') IS DISTINCT FROM (to_jsonb(OLD)-'status') THEN RAISE EXCEPTION 'Correction request is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_request BEFORE UPDATE OR DELETE ON correction_requests FOR EACH ROW EXECUTE FUNCTION protect_correction_request();
CREATE FUNCTION protect_correction_component() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE request_uuid uuid;
BEGIN
 request_uuid=CASE WHEN TG_TABLE_NAME IN ('sales_return_items','refund_payments') THEN (to_jsonb(NEW)->>'return_id')::uuid WHEN TG_TABLE_NAME='correction_approvals' THEN (to_jsonb(NEW)->>'request_id')::uuid ELSE NEW.id END;
 IF NOT EXISTS(SELECT 1 FROM public.correction_requests WHERE id=request_uuid AND status='pending') THEN RAISE EXCEPTION 'Posted corrections cannot accept components' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE FUNCTION require_complete_correction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE r public.sales_returns;
BEGIN
 IF NEW.status<>'posted' THEN RETURN NULL; END IF;
 IF NEW.kind='return' THEN
  SELECT * INTO r FROM public.sales_returns WHERE id=NEW.id;
  IF r.id IS NULL OR (SELECT (sum(net),sum(tax),sum(total)) FROM public.sales_return_items WHERE return_id=NEW.id) IS DISTINCT FROM ROW(r.net,r.tax,r.total)
  OR COALESCE((SELECT sum(amount) FROM public.refund_payments WHERE return_id=NEW.id),0)<>r.total
  OR EXISTS(SELECT 1 FROM public.sales_return_items i JOIN public.sale_items s ON s.id=i.sale_item_id WHERE i.return_id=NEW.id AND (s.sale_id<>r.sale_id OR
    (SELECT sum(quantity) FROM public.sales_return_items WHERE sale_item_id=s.id)>s.quantity OR
    (SELECT sum(cost) FROM public.sales_return_items WHERE sale_item_id=s.id)>s.cost OR
    (SELECT sum(total) FROM public.sales_return_items WHERE sale_item_id=s.id)>s.total))
  THEN RAISE EXCEPTION 'Return must reconcile to eligible original lines and refund tenders' USING ERRCODE='23514'; END IF;
 ELSIF NEW.kind='cash' AND NOT EXISTS(SELECT 1 FROM public.cash_movements WHERE id=NEW.id) THEN RAISE EXCEPTION 'Cash movement required' USING ERRCODE='23514';
 ELSIF NEW.kind='close' AND NOT EXISTS(SELECT 1 FROM public.register_closures WHERE id=NEW.id) THEN RAISE EXCEPTION 'Closure required' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER complete_correction AFTER UPDATE ON correction_requests DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_complete_correction();
CREATE FUNCTION require_posted_correction() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM public.correction_requests WHERE id=NEW.id AND status='posted') THEN RAISE EXCEPTION 'Incomplete financial correction cannot commit' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER posted_return AFTER INSERT ON sales_returns DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_posted_correction();
CREATE CONSTRAINT TRIGGER posted_cash AFTER INSERT ON cash_movements DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_posted_correction();
CREATE CONSTRAINT TRIGGER posted_close AFTER INSERT ON register_closures DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION require_posted_correction();
CREATE FUNCTION protect_register_session() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status<>'open' OR NEW.status<>'closed' OR NEW.closed_at IS NULL OR (to_jsonb(NEW)-'status'-'closed_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'closed_at')
 OR NOT EXISTS(SELECT 1 FROM public.register_closures WHERE session_id=NEW.id)
 THEN RAISE EXCEPTION 'Register requires immutable reviewed closure' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_session BEFORE UPDATE OR DELETE ON register_sessions FOR EACH ROW EXECUTE FUNCTION protect_register_session();
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['correction_approvals','sales_returns','sales_return_items','refund_payments','cash_movements','register_closures'] LOOP
  EXECUTE format('CREATE TRIGGER protect_component BEFORE INSERT ON %I FOR EACH ROW EXECUTE FUNCTION protect_correction_component()',target);
  EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_change()',target);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change()',target);
 END LOOP;
END; $$;
