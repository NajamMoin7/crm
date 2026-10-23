-- Append-only guards for financial history and audit trail.
-- Corrections are made with new reversal/adjustment rows, never by editing history.

CREATE OR REPLACE FUNCTION crm_forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is not permitted: table is append-only', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER activity_logs_append_only BEFORE UPDATE OR DELETE ON activity_logs
  FOR EACH ROW EXECUTE FUNCTION crm_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER chargeback_events_append_only BEFORE UPDATE OR DELETE ON chargeback_events
  FOR EACH ROW EXECUTE FUNCTION crm_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER customer_merge_history_append_only BEFORE UPDATE OR DELETE ON customer_merge_history
  FOR EACH ROW EXECUTE FUNCTION crm_forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER transactions_no_delete BEFORE DELETE ON transactions
  FOR EACH ROW EXECUTE FUNCTION crm_forbid_mutation();
--> statement-breakpoint
-- Ledger rows: only status (pending -> succeeded/failed/reversed) and notes may change.
CREATE OR REPLACE FUNCTION crm_guard_transaction_update() RETURNS trigger AS $$
BEGIN
  IF NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.type IS DISTINCT FROM OLD.type
     OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.legal_entity_id IS DISTINCT FROM OLD.legal_entity_id
     OR NEW.customer_id IS DISTINCT FROM OLD.customer_id
     OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
     OR NEW.occurred_at IS DISTINCT FROM OLD.occurred_at THEN
    RAISE EXCEPTION 'Ledger transaction % is immutable; record a reversal or adjustment instead', OLD.id;
  END IF;
  IF OLD.status IN ('succeeded', 'failed', 'reversed') AND NEW.status = 'pending' THEN
    RAISE EXCEPTION 'Ledger transaction % cannot return to pending', OLD.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER transactions_guard_update BEFORE UPDATE ON transactions
  FOR EACH ROW EXECUTE FUNCTION crm_guard_transaction_update();
--> statement-breakpoint
-- Completed chargeback cases keep their financial facts and entity assignments.
CREATE OR REPLACE FUNCTION crm_guard_closed_case() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('completed', 'rejected', 'cancelled') AND (
       NEW.amount IS DISTINCT FROM OLD.amount
    OR NEW.currency IS DISTINCT FROM OLD.currency
    OR NEW.original_legal_entity_id IS DISTINCT FROM OLD.original_legal_entity_id
    OR NEW.responsible_legal_entity_id IS DISTINCT FROM OLD.responsible_legal_entity_id
    OR NEW.status IS DISTINCT FROM OLD.status) THEN
    RAISE EXCEPTION 'Chargeback case % is closed (%); it cannot be modified', OLD.id, OLD.status;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER chargeback_cases_guard_closed BEFORE UPDATE ON chargeback_cases
  FOR EACH ROW EXECUTE FUNCTION crm_guard_closed_case();
--> statement-breakpoint
ALTER TABLE invoices ADD CONSTRAINT invoices_amounts_chk CHECK (total >= 0 AND amount_paid >= 0 AND amount_paid <= total);
--> statement-breakpoint
ALTER TABLE transactions ADD CONSTRAINT transactions_amount_chk CHECK (amount > 0);
--> statement-breakpoint
ALTER TABLE chargeback_cases ADD CONSTRAINT chargeback_amount_chk CHECK (amount > 0);
--> statement-breakpoint
ALTER TABLE duplicate_candidates ADD CONSTRAINT dup_distinct_chk CHECK (customer_a_id <> customer_b_id);
