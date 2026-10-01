INSERT INTO permissions(code) VALUES ('transfers.read'),('transfers.manage'),('transfers.approve'),('transfers.dispatch'),('transfers.receive'),('transfers.resolve');
INSERT INTO role_permissions SELECT r.code,p.code FROM roles r CROSS JOIN permissions p WHERE r.code IN ('admin','manager') AND p.code LIKE 'transfers.%';
INSERT INTO role_permissions SELECT 'inventory',code FROM permissions WHERE code IN ('transfers.read','transfers.manage','transfers.dispatch','transfers.receive');
CREATE TABLE stock_transfers (
 id uuid PRIMARY KEY,installation_id uuid NOT NULL REFERENCES installations(id),source_branch_id uuid NOT NULL,destination_branch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES users(id),approver_id uuid REFERENCES users(id),return_of_id uuid REFERENCES stock_transfers(id),number text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','pending','approved','in_transit','partially_received','received','rejected','cancelled')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),note text NOT NULL,snapshot jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE(source_branch_id,number),CHECK(source_branch_id<>destination_branch_id),CHECK(approver_id IS NULL OR approver_id<>actor_id),CHECK(return_of_id IS NULL OR return_of_id<>id),
 FOREIGN KEY(source_branch_id,installation_id) REFERENCES branch_ownership(branch_id,installation_id),FOREIGN KEY(destination_branch_id,installation_id) REFERENCES branch_ownership(branch_id,installation_id)
);
CREATE INDEX transfer_source_idx ON stock_transfers(source_branch_id,created_at DESC,id);
CREATE INDEX transfer_destination_idx ON stock_transfers(destination_branch_id,created_at DESC,id);
CREATE INDEX transfer_return_idx ON stock_transfers(return_of_id);
CREATE TABLE stock_transfer_items (
 id uuid PRIMARY KEY,transfer_id uuid NOT NULL REFERENCES stock_transfers(id),variant_id uuid NOT NULL REFERENCES product_variants(id),quantity numeric(24,6) NOT NULL CHECK(quantity>0),snapshot jsonb NOT NULL,
 UNIQUE(transfer_id,variant_id),UNIQUE(id,transfer_id)
);
ALTER TABLE inventory_reservations ADD COLUMN transfer_item_id uuid UNIQUE REFERENCES stock_transfer_items(id);
CREATE TABLE transfer_shipments (
 transfer_id uuid PRIMARY KEY REFERENCES stock_transfers(id),actor_id uuid NOT NULL REFERENCES users(id),note text NOT NULL,dispatched_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE transfer_shipment_items (
 transfer_item_id uuid PRIMARY KEY,transfer_id uuid NOT NULL REFERENCES transfer_shipments(transfer_id),quantity numeric(24,6) NOT NULL CHECK(quantity>0),value numeric(30,6) NOT NULL CHECK(value>=0),
 FOREIGN KEY(transfer_item_id,transfer_id) REFERENCES stock_transfer_items(id,transfer_id)
);
CREATE TABLE transfer_receipts (
 id uuid PRIMARY KEY,transfer_id uuid NOT NULL REFERENCES stock_transfers(id),actor_id uuid NOT NULL REFERENCES users(id),number text NOT NULL,note text NOT NULL,
 status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','posted')),posted_at timestamptz NOT NULL DEFAULT now(),UNIQUE(id,transfer_id)
);
CREATE INDEX transfer_receipt_idx ON transfer_receipts(transfer_id,posted_at,id);
CREATE TABLE transfer_receipt_items (
 id uuid PRIMARY KEY,receipt_id uuid NOT NULL,transfer_id uuid NOT NULL,transfer_item_id uuid NOT NULL,quantity numeric(24,6) NOT NULL CHECK(quantity>0),value numeric(30,6) NOT NULL CHECK(value>=0),condition text NOT NULL CHECK(condition IN ('sellable','damaged','quarantined')),
 FOREIGN KEY(receipt_id,transfer_id) REFERENCES transfer_receipts(id,transfer_id),FOREIGN KEY(transfer_item_id,transfer_id) REFERENCES stock_transfer_items(id,transfer_id),UNIQUE(receipt_id,transfer_item_id)
);
CREATE INDEX transfer_receipt_item_idx ON transfer_receipt_items(transfer_item_id);
CREATE TABLE transfer_discrepancies (
 id uuid PRIMARY KEY,transfer_id uuid NOT NULL REFERENCES stock_transfers(id),actor_id uuid NOT NULL REFERENCES users(id),approver_id uuid REFERENCES users(id),transfer_version integer NOT NULL,
 status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','posted')),reason_code text NOT NULL CHECK(reason_code IN ('MISSING','DAMAGED','RETURN_TO_SOURCE')),note text NOT NULL,input jsonb NOT NULL,quote jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(),posted_at timestamptz,UNIQUE(id,transfer_id),CHECK(approver_id IS NULL OR approver_id<>actor_id),CHECK((status='posted')=(posted_at IS NOT NULL AND approver_id IS NOT NULL))
);
CREATE INDEX transfer_discrepancy_idx ON transfer_discrepancies(transfer_id,created_at,id);
CREATE TABLE transfer_discrepancy_items (
 id uuid PRIMARY KEY,discrepancy_id uuid NOT NULL,transfer_id uuid NOT NULL,transfer_item_id uuid NOT NULL,quantity numeric(24,6) NOT NULL CHECK(quantity>0),value numeric(30,6) NOT NULL CHECK(value>=0),
 resolution text NOT NULL CHECK(resolution IN ('lost','return_to_source')),condition text NOT NULL CHECK(condition IN ('sellable','damaged','quarantined')),
 FOREIGN KEY(discrepancy_id,transfer_id) REFERENCES transfer_discrepancies(id,transfer_id),FOREIGN KEY(transfer_item_id,transfer_id) REFERENCES stock_transfer_items(id,transfer_id),UNIQUE(discrepancy_id,transfer_item_id)
);
CREATE INDEX transfer_discrepancy_item_idx ON transfer_discrepancy_items(transfer_item_id);
CREATE TABLE transfer_transit_entries (
 id uuid PRIMARY KEY,transfer_item_id uuid NOT NULL REFERENCES stock_transfer_items(id),kind text NOT NULL CHECK(kind IN ('dispatch','receipt','lost','return_to_source')),
 source_id uuid NOT NULL,source_line_id uuid NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),quantity numeric(24,6) NOT NULL CHECK(quantity<>0),value numeric(30,6) NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT now(),UNIQUE(source_id,source_line_id),CHECK((kind='dispatch' AND quantity>0 AND value>=0) OR (kind<>'dispatch' AND quantity<0 AND value<=0))
);
CREATE INDEX transfer_transit_idx ON transfer_transit_entries(transfer_item_id);
CREATE TABLE transfer_events (
 id uuid PRIMARY KEY,transfer_id uuid NOT NULL REFERENCES stock_transfers(id),version integer NOT NULL,actor_id uuid NOT NULL REFERENCES users(id),action text NOT NULL,note text NOT NULL,document_id uuid,occurred_at timestamptz NOT NULL DEFAULT now(),UNIQUE(transfer_id,version)
);
CREATE VIEW transfer_conservation AS
 WITH r AS (SELECT transfer_item_id,sum(quantity) quantity,sum(value) value FROM transfer_receipt_items GROUP BY 1),
 d AS (SELECT transfer_item_id,COALESCE(sum(quantity) FILTER(WHERE resolution='lost'),0) lost_quantity,COALESCE(sum(value) FILTER(WHERE resolution='lost'),0) lost_value,COALESCE(sum(quantity) FILTER(WHERE resolution='return_to_source'),0) returned_quantity,COALESCE(sum(value) FILTER(WHERE resolution='return_to_source'),0) returned_value FROM transfer_discrepancy_items GROUP BY 1),
 t AS (SELECT transfer_item_id,sum(quantity) quantity,sum(value) value FROM transfer_transit_entries GROUP BY 1),
 outbound AS (SELECT source_line_id,-sum(quantity) quantity,-sum(value) value FROM inventory_movements WHERE source_type='transfer_dispatch' GROUP BY 1),
 inbound AS (SELECT ri.transfer_item_id,sum(m.quantity) quantity,sum(m.value) value FROM transfer_receipt_items ri JOIN inventory_movements m ON m.source_line_id=ri.id AND m.source_type='transfer_receipt' GROUP BY 1),
 returned AS (SELECT di.transfer_item_id,sum(m.quantity) quantity,sum(m.value) value FROM transfer_discrepancy_items di JOIN inventory_movements m ON m.source_line_id=di.id AND m.source_type='transfer_return' GROUP BY 1),
 amounts AS (SELECT i.id transfer_item_id,i.transfer_id,i.variant_id,i.quantity ordered_quantity,COALESCE(s.quantity,0) shipped_quantity,COALESCE(s.value,0) shipped_value,COALESCE(r.quantity,0) received_quantity,COALESCE(r.value,0) received_value,COALESCE(d.lost_quantity,0) lost_quantity,COALESCE(d.lost_value,0) lost_value,COALESCE(d.returned_quantity,0) returned_quantity,COALESCE(d.returned_value,0) returned_value,COALESCE(t.quantity,0) transit_quantity,COALESCE(t.value,0) transit_value,
 COALESCE(o.quantity,0) source_quantity,COALESCE(o.value,0) source_value,COALESCE(n.quantity,0) destination_quantity,COALESCE(n.value,0) destination_value,COALESCE(b.quantity,0) back_quantity,COALESCE(b.value,0) back_value
 FROM stock_transfer_items i LEFT JOIN transfer_shipment_items s ON s.transfer_item_id=i.id LEFT JOIN r ON r.transfer_item_id=i.id LEFT JOIN d ON d.transfer_item_id=i.id LEFT JOIN t ON t.transfer_item_id=i.id LEFT JOIN outbound o ON o.source_line_id=i.id LEFT JOIN inbound n ON n.transfer_item_id=i.id LEFT JOIN returned b ON b.transfer_item_id=i.id)
 SELECT *,shipped_quantity=received_quantity+lost_quantity+returned_quantity+transit_quantity AND shipped_value=received_value+lost_value+returned_value+transit_value
 AND (shipped_quantity,shipped_value)=(source_quantity,source_value) AND (received_quantity,received_value)=(destination_quantity,destination_value) AND (returned_quantity,returned_value)=(back_quantity,back_value)
 AND transit_quantity>=0 AND transit_value>=0 AND (transit_quantity>0 OR transit_value=0) AS matched FROM amounts;

CREATE FUNCTION protect_transfer() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status IN ('received','rejected','cancelled') OR NEW.version<>OLD.version+1 OR
 (NEW.id,NEW.installation_id,NEW.source_branch_id,NEW.destination_branch_id,NEW.actor_id,NEW.return_of_id,NEW.number,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.installation_id,OLD.source_branch_id,OLD.destination_branch_id,OLD.actor_id,OLD.return_of_id,OLD.number,OLD.created_at)
 THEN RAISE EXCEPTION 'Transfer identity and final documents are immutable' USING ERRCODE='23514'; END IF;
 IF NOT ((OLD.status='draft' AND NEW.status IN ('draft','pending','cancelled')) OR (OLD.status='pending' AND NEW.status IN ('approved','rejected','cancelled')) OR (OLD.status='approved' AND NEW.status IN ('in_transit','cancelled')) OR (OLD.status IN ('in_transit','partially_received') AND NEW.status IN ('in_transit','partially_received','received'))) THEN RAISE EXCEPTION 'Invalid transfer transition' USING ERRCODE='23514'; END IF;
 IF OLD.status<>'draft' AND (NEW.note,NEW.snapshot) IS DISTINCT FROM (OLD.note,OLD.snapshot) THEN RAISE EXCEPTION 'Submitted transfer contents are immutable' USING ERRCODE='23514'; END IF;
 IF NEW.approver_id IS DISTINCT FROM OLD.approver_id AND NOT(OLD.status='pending' AND NEW.status='approved' AND NEW.approver_id IS NOT NULL) THEN RAISE EXCEPTION 'Approval is immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_transfer BEFORE UPDATE OR DELETE ON stock_transfers FOR EACH ROW EXECUTE FUNCTION protect_transfer();
CREATE FUNCTION protect_transfer_item() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM public.stock_transfers WHERE id IN (NEW.transfer_id,OLD.transfer_id) AND status<>'draft') THEN RAISE EXCEPTION 'Submitted transfer items are immutable' USING ERRCODE='23514'; END IF;
 RETURN COALESCE(NEW,OLD);
END; $$;
CREATE TRIGGER protect_item BEFORE INSERT OR UPDATE OR DELETE ON stock_transfer_items FOR EACH ROW EXECUTE FUNCTION protect_transfer_item();
CREATE FUNCTION protect_transfer_financial_header() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_OP='DELETE' OR OLD.status NOT IN ('draft','pending') OR NEW.status<>'posted' OR
 (to_jsonb(NEW)-'status'-'approver_id'-'posted_at') IS DISTINCT FROM (to_jsonb(OLD)-'status'-'approver_id'-'posted_at') THEN RAISE EXCEPTION 'Committed transfer records are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_receipt BEFORE UPDATE OR DELETE ON transfer_receipts FOR EACH ROW EXECUTE FUNCTION protect_transfer_financial_header();
CREATE TRIGGER protect_discrepancy BEFORE UPDATE OR DELETE ON transfer_discrepancies FOR EACH ROW EXECUTE FUNCTION protect_transfer_financial_header();
CREATE FUNCTION protect_transfer_financial_item() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='transfer_receipt_items' THEN
  IF NOT EXISTS(SELECT 1 FROM public.transfer_receipts WHERE id=NEW.receipt_id AND status='draft') THEN RAISE EXCEPTION 'Posted receipt items are immutable' USING ERRCODE='23514'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM public.transfer_discrepancies WHERE id=NEW.discrepancy_id AND status='pending') THEN RAISE EXCEPTION 'Posted discrepancy items are immutable' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER protect_receipt_item BEFORE INSERT ON transfer_receipt_items FOR EACH ROW EXECUTE FUNCTION protect_transfer_financial_item();
CREATE TRIGGER protect_discrepancy_item BEFORE INSERT ON transfer_discrepancy_items FOR EACH ROW EXECUTE FUNCTION protect_transfer_financial_item();
CREATE FUNCTION validate_transfer_commit() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE transfer_uuid uuid; doc public.stock_transfers;
BEGIN
 IF TG_TABLE_NAME='stock_transfers' THEN transfer_uuid=NEW.id;
 ELSIF TG_TABLE_NAME IN ('inventory_reservations','transfer_transit_entries') THEN SELECT transfer_id INTO transfer_uuid FROM public.stock_transfer_items WHERE id=NEW.transfer_item_id;
 ELSE transfer_uuid=NEW.transfer_id;
 END IF;
 IF transfer_uuid IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO doc FROM public.stock_transfers WHERE id=transfer_uuid;
 IF NOT EXISTS(SELECT 1 FROM public.stock_transfer_items WHERE transfer_id=doc.id) OR EXISTS(SELECT 1 FROM public.transfer_conservation WHERE transfer_id=doc.id AND NOT matched) THEN RAISE EXCEPTION 'Transfer quantity and value must reconcile' USING ERRCODE='23514'; END IF;
 IF doc.status='approved' AND (doc.approver_id IS NULL OR EXISTS(SELECT 1 FROM public.stock_transfer_items i LEFT JOIN public.inventory_reservations r ON r.transfer_item_id=i.id WHERE i.transfer_id=doc.id AND (r.id IS NULL OR r.status<>'active' OR r.quantity<>i.quantity))) THEN RAISE EXCEPTION 'Approved transfer requires its reservations' USING ERRCODE='23514'; END IF;
 IF doc.status<>'approved' AND EXISTS(SELECT 1 FROM public.inventory_reservations r JOIN public.stock_transfer_items i ON i.id=r.transfer_item_id WHERE i.transfer_id=doc.id AND r.status='active') THEN RAISE EXCEPTION 'Only approved transfers hold reservations' USING ERRCODE='23514'; END IF;
 IF doc.status NOT IN ('in_transit','partially_received','received') AND EXISTS(SELECT 1 FROM public.transfer_shipments WHERE transfer_id=doc.id) THEN RAISE EXCEPTION 'Shipment requires dispatched transfer' USING ERRCODE='23514'; END IF;
 IF doc.status IN ('in_transit','partially_received','received') AND EXISTS(SELECT 1 FROM public.transfer_conservation WHERE transfer_id=doc.id AND shipped_quantity<>ordered_quantity) THEN RAISE EXCEPTION 'Dispatch must ship the approved quantities' USING ERRCODE='23514'; END IF;
 IF doc.status='received' AND EXISTS(SELECT 1 FROM public.transfer_conservation WHERE transfer_id=doc.id AND (transit_quantity<>0 OR transit_value<>0)) THEN RAISE EXCEPTION 'Unresolved transit prevents closure' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='transfer_receipts' THEN
  IF EXISTS(SELECT 1 FROM public.transfer_receipts WHERE id=NEW.id AND status<>'posted') THEN RAISE EXCEPTION 'Incomplete receipt cannot commit' USING ERRCODE='23514'; END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM public.transfer_discrepancy_items i JOIN public.transfer_discrepancies d ON d.id=i.discrepancy_id WHERE i.transfer_id=doc.id AND d.status<>'posted') THEN RAISE EXCEPTION 'Incomplete resolution cannot commit' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER validate_transfer AFTER INSERT OR UPDATE ON stock_transfers DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_commit();
CREATE CONSTRAINT TRIGGER validate_reservation AFTER INSERT OR UPDATE ON inventory_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_commit();
CREATE CONSTRAINT TRIGGER validate_receipt AFTER INSERT OR UPDATE ON transfer_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_commit();
CREATE CONSTRAINT TRIGGER validate_discrepancy AFTER INSERT OR UPDATE ON transfer_discrepancies DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_commit();
CREATE CONSTRAINT TRIGGER validate_transit AFTER INSERT ON transfer_transit_entries DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_commit();
CREATE CONSTRAINT TRIGGER validate_shipment AFTER INSERT ON transfer_shipments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_commit();
CREATE CONSTRAINT TRIGGER validate_shipment_item AFTER INSERT ON transfer_shipment_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_commit();
CREATE CONSTRAINT TRIGGER validate_receipt_item AFTER INSERT ON transfer_receipt_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_commit();
CREATE CONSTRAINT TRIGGER validate_discrepancy_item AFTER INSERT ON transfer_discrepancy_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_transfer_commit();
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['transfer_shipments','transfer_shipment_items','transfer_receipt_items','transfer_discrepancy_items','transfer_transit_entries','transfer_events'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_change()',target);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change()',target);
 END LOOP;
END; $$;
