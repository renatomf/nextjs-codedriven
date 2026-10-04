CREATE TABLE "embedding_cache" (
	"project_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"embedding_model" text NOT NULL,
	"embedding" vector(384) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "embedding_cache_key" UNIQUE("project_id","content_hash","embedding_model")
);
--> statement-breakpoint
ALTER TABLE "embedding_cache" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "embedding_cache" ADD CONSTRAINT "embedding_cache_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;