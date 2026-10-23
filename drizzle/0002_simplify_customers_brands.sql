ALTER TABLE "customers" ALTER COLUMN "country" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "acquisition_source" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "customers" ALTER COLUMN "first_brand_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sale_items" ALTER COLUMN "product_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "brands" ADD COLUMN "logo_url" text;