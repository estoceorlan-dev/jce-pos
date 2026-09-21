CREATE TABLE product_categories (id uuid PRIMARY KEY, name text NOT NULL UNIQUE, archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1);
CREATE TABLE product_brands (id uuid PRIMARY KEY, name text NOT NULL UNIQUE, archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1);
CREATE TABLE product_units (id uuid PRIMARY KEY, name text NOT NULL UNIQUE, fractional boolean NOT NULL DEFAULT false, archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1);
CREATE TABLE tax_codes (id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, rate numeric(12,6) NOT NULL CHECK(rate>=0 AND rate<=1), inclusive boolean NOT NULL, archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1);
CREATE TABLE tax_code_history (id uuid PRIMARY KEY, tax_id uuid NOT NULL REFERENCES tax_codes(id), version integer NOT NULL, value jsonb NOT NULL, occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tax_id,version));
CREATE TABLE products (id uuid PRIMARY KEY, name text NOT NULL, category_id uuid REFERENCES product_categories(id), brand_id uuid REFERENCES product_brands(id), archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1);
CREATE TABLE product_variants (
 id uuid PRIMARY KEY, product_id uuid NOT NULL REFERENCES products(id), sku text NOT NULL UNIQUE CHECK(sku ~ '^[A-Z0-9][A-Z0-9._-]{0,63}$'),
 name text NOT NULL, unit_id uuid NOT NULL REFERENCES product_units(id), conversion numeric(24,6) NOT NULL CHECK(conversion>0),
 fractional boolean NOT NULL DEFAULT false, minimum_stock numeric(24,6) NOT NULL DEFAULT 0 CHECK(minimum_stock>=0),
 tax_code_id uuid REFERENCES tax_codes(id), archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1
);
CREATE TABLE product_barcodes (barcode text PRIMARY KEY CHECK(length(barcode) BETWEEN 1 AND 64), variant_id uuid NOT NULL REFERENCES product_variants(id));
CREATE INDEX barcode_variant_idx ON product_barcodes(variant_id);
CREATE INDEX product_search_idx ON products(lower(name));
CREATE INDEX variant_product_idx ON product_variants(product_id);
CREATE TABLE product_prices (branch_id uuid NOT NULL REFERENCES branches(id), variant_id uuid NOT NULL REFERENCES product_variants(id), amount numeric(20,2) NOT NULL CHECK(amount>=0), version integer NOT NULL DEFAULT 1, id uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(), PRIMARY KEY(branch_id,variant_id));
CREATE TABLE product_price_history (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id), variant_id uuid NOT NULL REFERENCES product_variants(id), amount numeric(20,2) NOT NULL CHECK(amount>=0), version integer NOT NULL, actor_id uuid NOT NULL REFERENCES users(id), occurred_at timestamptz NOT NULL DEFAULT now(), UNIQUE(branch_id,variant_id,version));
CREATE TABLE suppliers (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id), name text NOT NULL, contact text NOT NULL DEFAULT '', archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, UNIQUE(id,branch_id));
CREATE TABLE customers (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id), name text NOT NULL, contact text NOT NULL DEFAULT '', archived boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1, UNIQUE(id,branch_id));
CREATE INDEX supplier_branch_idx ON suppliers(branch_id,lower(name));
CREATE INDEX customer_branch_idx ON customers(branch_id,lower(name));
-- Source documents are populated by L7/L8; no synthetic history or balance writes.
CREATE TABLE customer_transactions (id uuid PRIMARY KEY, branch_id uuid NOT NULL, customer_id uuid NOT NULL, source_type text NOT NULL CHECK(source_type IN ('sale','refund')), source_id uuid NOT NULL, amount numeric(20,2) NOT NULL CHECK(amount>=0), occurred_at timestamptz NOT NULL DEFAULT now(), FOREIGN KEY(customer_id,branch_id) REFERENCES customers(id,branch_id), UNIQUE(source_type,source_id));
CREATE TABLE catalog_imports (id uuid PRIMARY KEY, branch_id uuid NOT NULL REFERENCES branches(id), actor_id uuid NOT NULL REFERENCES users(id), rows jsonb NOT NULL, errors jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL DEFAULT now()+interval '1 day', committed_at timestamptz, result jsonb);
DO $$ DECLARE target text; BEGIN
 FOREACH target IN ARRAY ARRAY['tax_code_history','product_price_history','customer_transactions'] LOOP
  EXECUTE format('CREATE TRIGGER immutable_rows BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_immutable_change()',target);
  EXECUTE format('CREATE TRIGGER immutable_truncate BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_immutable_change()',target);
 END LOOP;
END; $$;
