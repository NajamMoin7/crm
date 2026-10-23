CREATE TYPE "public"."adjustment_type" AS ENUM('credit_note', 'write_off', 'correction', 'refund');--> statement-breakpoint
CREATE TYPE "public"."approval_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."case_origin" AS ENUM('crm', 'processor');--> statement-breakpoint
CREATE TYPE "public"."case_status" AS ENUM('draft', 'pending_review', 'pending_approval', 'approved', 'processing', 'completed', 'rejected', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."case_type" AS ENUM('chargeback', 'intercompany_recharge');--> statement-breakpoint
CREATE TYPE "public"."customer_status" AS ENUM('active', 'prospect', 'inactive', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('individual', 'business');--> statement-breakpoint
CREATE TYPE "public"."duplicate_status" AS ENUM('open', 'dismissed', 'merged');--> statement-breakpoint
CREATE TYPE "public"."integration_status" AS ENUM('demo_not_connected', 'connected', 'error', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('draft', 'pending', 'paid', 'partially_paid', 'overdue', 'cancelled', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."lead_stage" AS ENUM('new', 'contacted', 'qualified', 'proposal', 'negotiation', 'won', 'lost');--> statement-breakpoint
CREATE TYPE "public"."payment_method" AS ENUM('card', 'bank_transfer', 'ach', 'wire', 'paypal', 'stripe_link', 'other');--> statement-breakpoint
CREATE TYPE "public"."recon_status" AS ENUM('matched', 'exception', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('active', 'inactive', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."run_status" AS ENUM('success', 'partial', 'failed');--> statement-breakpoint
CREATE TYPE "public"."sale_status" AS ENUM('open', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."task_status" AS ENUM('open', 'done');--> statement-breakpoint
CREATE TYPE "public"."transaction_status" AS ENUM('pending', 'succeeded', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."transaction_type" AS ENUM('payment', 'refund', 'chargeback', 'chargeback_reversal', 'adjustment', 'intercompany_recharge');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'invited', 'suspended');--> statement-breakpoint
CREATE TABLE "activity_logs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"actor_id" text,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"brand_id" text,
	"legal_entity_id" text,
	"summary" text NOT NULL,
	"metadata" jsonb,
	"ip" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brand_legal_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"legal_entity_id" text NOT NULL,
	"scope" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"effective_from" date NOT NULL,
	"effective_to" date,
	"notes" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brands" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"domain" text NOT NULL,
	"color" text NOT NULL,
	"logo_text" text NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"default_currency" text DEFAULT 'USD' NOT NULL,
	"allowed_currencies" text[] DEFAULT ARRAY['USD']::text[] NOT NULL,
	"invoice_prefix" text NOT NULL,
	"payment_terms_days" integer DEFAULT 14 NOT NULL,
	"default_tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"allowed_payment_methods" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chargeback_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"case_type" "case_type" DEFAULT 'chargeback' NOT NULL,
	"origin" "case_origin" DEFAULT 'crm' NOT NULL,
	"brand_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"invoice_id" text NOT NULL,
	"original_transaction_id" text NOT NULL,
	"original_legal_entity_id" text NOT NULL,
	"responsible_legal_entity_id" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"reason_code" text NOT NULL,
	"notes" text,
	"request_date" timestamp with time zone NOT NULL,
	"requested_by" text NOT NULL,
	"status" "case_status" DEFAULT 'draft' NOT NULL,
	"external_processor_reference" text,
	"evidence_summary" text,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"processed_by" text,
	"completed_at" timestamp with time zone,
	"outcome_note" text,
	"ledger_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chargeback_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"action" text NOT NULL,
	"from_status" "case_status",
	"to_status" "case_status" NOT NULL,
	"actor_id" text NOT NULL,
	"note" text,
	"changes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_brand_relationships" (
	"customer_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"source_system_id" text,
	CONSTRAINT "customer_brand_relationships_customer_id_brand_id_pk" PRIMARY KEY("customer_id","brand_id")
);
--> statement-breakpoint
CREATE TABLE "customer_merge_history" (
	"id" text PRIMARY KEY NOT NULL,
	"survivor_id" text NOT NULL,
	"merged_id" text NOT NULL,
	"duplicate_candidate_id" text,
	"performed_by" text NOT NULL,
	"reason" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"moved_records" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"full_name" text NOT NULL,
	"email" text,
	"phone" text,
	"phone_normalized" text,
	"company_name" text,
	"country" text NOT NULL,
	"city" text,
	"billing_address" text,
	"customer_type" "customer_type" DEFAULT 'individual' NOT NULL,
	"status" "customer_status" DEFAULT 'active' NOT NULL,
	"acquisition_source" text NOT NULL,
	"first_brand_id" text NOT NULL,
	"assigned_agent_id" text,
	"tags" text[] DEFAULT ARRAY[]::text[] NOT NULL,
	"merged_into_id" text,
	"archived_at" timestamp with time zone,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_activity_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "duplicate_candidates" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_a_id" text NOT NULL,
	"customer_b_id" text NOT NULL,
	"match_reasons" text[] NOT NULL,
	"score" integer NOT NULL,
	"status" "duplicate_status" DEFAULT 'open' NOT NULL,
	"detected_by" text NOT NULL,
	"reviewed_by" text,
	"reviewed_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_record_mappings" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"entity_type" text NOT NULL,
	"external_id" text NOT NULL,
	"internal_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financial_adjustments" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "adjustment_type" NOT NULL,
	"brand_id" text NOT NULL,
	"legal_entity_id" text NOT NULL,
	"invoice_id" text,
	"customer_id" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"reason" text NOT NULL,
	"status" "approval_status" DEFAULT 'pending' NOT NULL,
	"requested_by" text NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"ledger_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "id_counters" (
	"name" text PRIMARY KEY NOT NULL,
	"value" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "integration_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"source_id" text NOT NULL,
	"kind" text NOT NULL,
	"status" "run_status" NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"records_read" integer DEFAULT 0 NOT NULL,
	"records_imported" integer DEFAULT 0 NOT NULL,
	"records_flagged" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"errors" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"message" text,
	"triggered_by" text
);
--> statement-breakpoint
CREATE TABLE "integration_sources" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"domain" text NOT NULL,
	"system_name" text NOT NULL,
	"status" "integration_status" DEFAULT 'demo_not_connected' NOT NULL,
	"config" jsonb NOT NULL,
	"last_sync_at" timestamp with time zone,
	"imported_count" integer DEFAULT 0 NOT NULL,
	"review_count" integer DEFAULT 0 NOT NULL,
	"error_count" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "integration_sources_brand_id_unique" UNIQUE("brand_id")
);
--> statement-breakpoint
CREATE TABLE "invoice_items" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_id" text NOT NULL,
	"sale_item_id" text,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" text PRIMARY KEY NOT NULL,
	"invoice_number" text NOT NULL,
	"sale_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"legal_entity_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"billing_date" timestamp with time zone NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"billing_address" text,
	"currency" text NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"amount_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"status" "invoice_status" NOT NULL,
	"payment_method" "payment_method" NOT NULL,
	"notes" text,
	"source_system" text DEFAULT 'crm' NOT NULL,
	"source_record_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"customer_id" text,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"company_name" text,
	"stage" "lead_stage" DEFAULT 'new' NOT NULL,
	"estimated_value" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"source" text NOT NULL,
	"assigned_agent_id" text,
	"product_interest" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "legal_entities" (
	"id" text PRIMARY KEY NOT NULL,
	"registered_name" text NOT NULL,
	"internal_code" text NOT NULL,
	"jurisdiction" text NOT NULL,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"base_currency" text DEFAULT 'USD' NOT NULL,
	"permitted_transaction_types" text[] NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notes" (
	"id" text PRIMARY KEY NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text NOT NULL,
	"body" text NOT NULL,
	"visibility" text DEFAULT 'internal' NOT NULL,
	"author_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"href" text,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY NOT NULL,
	"module" text NOT NULL,
	"description" text NOT NULL,
	"sensitive" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "products_services" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"category" text NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"taxable" boolean DEFAULT true NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reconciliation_records" (
	"id" text PRIMARY KEY NOT NULL,
	"legal_entity_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"category" text NOT NULL,
	"expected_amount" numeric(14, 2) NOT NULL,
	"actual_amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"status" "recon_status" NOT NULL,
	"transaction_id" text,
	"note" text,
	"resolved_by" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" text NOT NULL,
	"permission_key" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_key_pk" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"is_system" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sale_items" (
	"id" text PRIMARY KEY NOT NULL,
	"sale_id" text NOT NULL,
	"product_id" text NOT NULL,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_rate" numeric(5, 2) DEFAULT '0' NOT NULL,
	"line_total" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales" (
	"id" text PRIMARY KEY NOT NULL,
	"brand_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"legal_entity_id" text NOT NULL,
	"lead_id" text,
	"sale_date" timestamp with time zone NOT NULL,
	"currency" text NOT NULL,
	"subtotal" numeric(14, 2) NOT NULL,
	"discount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) NOT NULL,
	"status" "sale_status" DEFAULT 'completed' NOT NULL,
	"notes" text,
	"source_system" text DEFAULT 'crm' NOT NULL,
	"source_record_id" text,
	"created_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_agents" (
	"user_id" text PRIMARY KEY NOT NULL,
	"agent_code" text NOT NULL,
	"team" text NOT NULL,
	"monthly_target" numeric(14, 2) NOT NULL,
	"hire_date" date NOT NULL,
	"manager_id" text,
	CONSTRAINT "sales_agents_agent_code_unique" UNIQUE("agent_code")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL,
	"description" text NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"status" "task_status" DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"due_date" timestamp with time zone,
	"assignee_id" text NOT NULL,
	"entity_type" text,
	"entity_id" text,
	"brand_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transactions" (
	"id" text PRIMARY KEY NOT NULL,
	"type" "transaction_type" NOT NULL,
	"status" "transaction_status" NOT NULL,
	"brand_id" text NOT NULL,
	"legal_entity_id" text NOT NULL,
	"counterparty_entity_id" text,
	"customer_id" text,
	"invoice_id" text,
	"related_transaction_id" text,
	"chargeback_case_id" text,
	"adjustment_id" text,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text NOT NULL,
	"payment_method" "payment_method",
	"processor" text,
	"payment_reference" text,
	"occurred_at" timestamp with time zone NOT NULL,
	"notes" text,
	"source_system" text DEFAULT 'crm' NOT NULL,
	"source_record_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_brand_access" (
	"user_id" text NOT NULL,
	"brand_id" text NOT NULL,
	"granted_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_brand_access_user_id_brand_id_pk" PRIMARY KEY("user_id","brand_id")
);
--> statement-breakpoint
CREATE TABLE "user_legal_entity_access" (
	"user_id" text NOT NULL,
	"legal_entity_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_legal_entity_access_user_id_legal_entity_id_pk" PRIMARY KEY("user_id","legal_entity_id")
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" text NOT NULL,
	"role_id" text NOT NULL,
	CONSTRAINT "user_roles_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"title" text,
	"password_hash" text NOT NULL,
	"status" "user_status" DEFAULT 'active' NOT NULL,
	"mfa_enabled" boolean DEFAULT false NOT NULL,
	"last_login_at" timestamp with time zone,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "activity_logs" ADD CONSTRAINT "activity_logs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_legal_entities" ADD CONSTRAINT "brand_legal_entities_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_legal_entities" ADD CONSTRAINT "brand_legal_entities_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brand_legal_entities" ADD CONSTRAINT "brand_legal_entities_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_original_transaction_id_transactions_id_fk" FOREIGN KEY ("original_transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_original_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("original_legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_responsible_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("responsible_legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_cases" ADD CONSTRAINT "chargeback_cases_processed_by_users_id_fk" FOREIGN KEY ("processed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_events" ADD CONSTRAINT "chargeback_events_case_id_chargeback_cases_id_fk" FOREIGN KEY ("case_id") REFERENCES "public"."chargeback_cases"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chargeback_events" ADD CONSTRAINT "chargeback_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_brand_relationships" ADD CONSTRAINT "customer_brand_relationships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_brand_relationships" ADD CONSTRAINT "customer_brand_relationships_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge_history" ADD CONSTRAINT "customer_merge_history_survivor_id_customers_id_fk" FOREIGN KEY ("survivor_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge_history" ADD CONSTRAINT "customer_merge_history_merged_id_customers_id_fk" FOREIGN KEY ("merged_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge_history" ADD CONSTRAINT "customer_merge_history_duplicate_candidate_id_duplicate_candidates_id_fk" FOREIGN KEY ("duplicate_candidate_id") REFERENCES "public"."duplicate_candidates"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_merge_history" ADD CONSTRAINT "customer_merge_history_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_first_brand_id_brands_id_fk" FOREIGN KEY ("first_brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_assigned_agent_id_users_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_customer_a_id_customers_id_fk" FOREIGN KEY ("customer_a_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_customer_b_id_customers_id_fk" FOREIGN KEY ("customer_b_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "duplicate_candidates" ADD CONSTRAINT "duplicate_candidates_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_record_mappings" ADD CONSTRAINT "external_record_mappings_source_id_integration_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."integration_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financial_adjustments" ADD CONSTRAINT "financial_adjustments_decided_by_users_id_fk" FOREIGN KEY ("decided_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_runs" ADD CONSTRAINT "integration_runs_source_id_integration_sources_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."integration_sources"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_runs" ADD CONSTRAINT "integration_runs_triggered_by_users_id_fk" FOREIGN KEY ("triggered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "integration_sources" ADD CONSTRAINT "integration_sources_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_items" ADD CONSTRAINT "invoice_items_sale_item_id_sale_items_id_fk" FOREIGN KEY ("sale_item_id") REFERENCES "public"."sale_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_agent_id_users_id_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notes" ADD CONSTRAINT "notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products_services" ADD CONSTRAINT "products_services_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_transaction_id_transactions_id_fk" FOREIGN KEY ("transaction_id") REFERENCES "public"."transactions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reconciliation_records" ADD CONSTRAINT "reconciliation_records_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fk" FOREIGN KEY ("permission_key") REFERENCES "public"."permissions"("key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_sales_id_fk" FOREIGN KEY ("sale_id") REFERENCES "public"."sales"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_products_services_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products_services"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_agent_id_users_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales" ADD CONSTRAINT "sales_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_agents" ADD CONSTRAINT "sales_agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_agents" ADD CONSTRAINT "sales_agents_manager_id_users_id_fk" FOREIGN KEY ("manager_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_settings" ADD CONSTRAINT "system_settings_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_counterparty_entity_id_legal_entities_id_fk" FOREIGN KEY ("counterparty_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_brand_access" ADD CONSTRAINT "user_brand_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_brand_access" ADD CONSTRAINT "user_brand_access_brand_id_brands_id_fk" FOREIGN KEY ("brand_id") REFERENCES "public"."brands"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_brand_access" ADD CONSTRAINT "user_brand_access_granted_by_users_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_legal_entity_access" ADD CONSTRAINT "user_legal_entity_access_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_legal_entity_access" ADD CONSTRAINT "user_legal_entity_access_legal_entity_id_legal_entities_id_fk" FOREIGN KEY ("legal_entity_id") REFERENCES "public"."legal_entities"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "activity_entity_idx" ON "activity_logs" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "activity_created_idx" ON "activity_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "activity_actor_idx" ON "activity_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "ble_brand_idx" ON "brand_legal_entities" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "ble_entity_idx" ON "brand_legal_entities" USING btree ("legal_entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_code_uq" ON "brands" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_invoice_prefix_uq" ON "brands" USING btree ("invoice_prefix");--> statement-breakpoint
CREATE INDEX "cb_status_idx" ON "chargeback_cases" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cb_brand_idx" ON "chargeback_cases" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "cb_original_txn_idx" ON "chargeback_cases" USING btree ("original_transaction_id");--> statement-breakpoint
CREATE INDEX "cb_requested_by_idx" ON "chargeback_cases" USING btree ("requested_by");--> statement-breakpoint
CREATE INDEX "cb_resp_entity_idx" ON "chargeback_cases" USING btree ("responsible_legal_entity_id");--> statement-breakpoint
CREATE INDEX "cbe_case_idx" ON "chargeback_events" USING btree ("case_id");--> statement-breakpoint
CREATE INDEX "cbr_brand_idx" ON "customer_brand_relationships" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "customers_email_idx" ON "customers" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "customers_phone_idx" ON "customers" USING btree ("phone_normalized");--> statement-breakpoint
CREATE INDEX "customers_agent_idx" ON "customers" USING btree ("assigned_agent_id");--> statement-breakpoint
CREATE INDEX "customers_name_idx" ON "customers" USING btree (lower("full_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "dup_pair_uq" ON "duplicate_candidates" USING btree ("customer_a_id","customer_b_id");--> statement-breakpoint
CREATE UNIQUE INDEX "erm_uq" ON "external_record_mappings" USING btree ("source_id","entity_type","external_id");--> statement-breakpoint
CREATE INDEX "adj_status_idx" ON "financial_adjustments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "runs_source_idx" ON "integration_runs" USING btree ("source_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_number_uq" ON "invoices" USING btree ("invoice_number");--> statement-breakpoint
CREATE INDEX "invoices_brand_date_idx" ON "invoices" USING btree ("brand_id","billing_date");--> statement-breakpoint
CREATE INDEX "invoices_customer_idx" ON "invoices" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "invoices_status_idx" ON "invoices" USING btree ("status");--> statement-breakpoint
CREATE INDEX "invoices_entity_idx" ON "invoices" USING btree ("legal_entity_id");--> statement-breakpoint
CREATE INDEX "leads_brand_stage_idx" ON "leads" USING btree ("brand_id","stage");--> statement-breakpoint
CREATE INDEX "leads_agent_idx" ON "leads" USING btree ("assigned_agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "legal_entities_code_uq" ON "legal_entities" USING btree ("internal_code");--> statement-breakpoint
CREATE INDEX "notes_entity_idx" ON "notes" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id","read_at");--> statement-breakpoint
CREATE UNIQUE INDEX "products_brand_sku_uq" ON "products_services" USING btree ("brand_id","sku");--> statement-breakpoint
CREATE INDEX "recon_status_idx" ON "reconciliation_records" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sales_brand_date_idx" ON "sales" USING btree ("brand_id","sale_date");--> statement-breakpoint
CREATE INDEX "sales_agent_idx" ON "sales" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sales_customer_idx" ON "sales" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "sales_entity_idx" ON "sales" USING btree ("legal_entity_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "transactions_payment_ref_uq" ON "transactions" USING btree ("payment_reference");--> statement-breakpoint
CREATE INDEX "transactions_type_date_idx" ON "transactions" USING btree ("type","occurred_at");--> statement-breakpoint
CREATE INDEX "transactions_brand_idx" ON "transactions" USING btree ("brand_id");--> statement-breakpoint
CREATE INDEX "transactions_entity_idx" ON "transactions" USING btree ("legal_entity_id");--> statement-breakpoint
CREATE INDEX "transactions_invoice_idx" ON "transactions" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "transactions_customer_idx" ON "transactions" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));