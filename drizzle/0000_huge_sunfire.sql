CREATE TYPE "public"."lifecycle_type" AS ENUM('Free', 'Driven', 'Driving');--> statement-breakpoint
CREATE TABLE "auth_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"event_type" varchar(50) NOT NULL,
	"ip_address" varchar(45),
	"metadata" jsonb,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"permissions" jsonb,
	CONSTRAINT "roles_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" varchar(255) PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" varchar(45),
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" varchar(255) NOT NULL,
	"name" varchar(255),
	"password_hash" varchar(255),
	"provider" varchar(50) DEFAULT 'local',
	"provider_id" varchar(255),
	"active" boolean DEFAULT true NOT NULL,
	"failed_login_attempts" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"last_login" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "program_members" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(50) DEFAULT 'engineer' NOT NULL,
	"can_create_eco" boolean DEFAULT true,
	"can_approve_eco" boolean DEFAULT false,
	"can_manage_products" boolean DEFAULT false,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invited_by" uuid,
	CONSTRAINT "program_members_unique" UNIQUE("program_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"code" varchar(50) NOT NULL,
	"description" text,
	"contract_number" varchar(100),
	"customer" varchar(200),
	"start_date" timestamp with time zone,
	"target_end_date" timestamp with time zone,
	"status" varchar(50) DEFAULT 'Active' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "programs_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid,
	"name" varchar(200) NOT NULL,
	"code" varchar(50) NOT NULL,
	"description" text,
	"design_type" varchar(50) DEFAULT 'Engineering' NOT NULL,
	"parent_design_id" uuid,
	"clone_source_design_id" uuid,
	"source_design_id" uuid,
	"source_tag_id" uuid,
	"source_commit_id" uuid,
	"planned_quantity" integer,
	"default_branch_id" uuid,
	"is_archived" boolean DEFAULT false,
	"sysml_project_id" uuid,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "designs_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "branch_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"branch_id" uuid NOT NULL,
	"item_master_id" uuid NOT NULL,
	"current_item_id" uuid,
	"base_item_id" uuid,
	"change_type" varchar(20),
	"checked_out_by" uuid,
	"checked_out_at" timestamp with time zone,
	CONSTRAINT "branch_items_unique" UNIQUE("branch_id","item_master_id")
);
--> statement-breakpoint
CREATE TABLE "branches" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"branch_type" varchar(20) NOT NULL,
	"head_commit_id" uuid,
	"base_commit_id" uuid,
	"change_order_item_id" uuid,
	"owner_id" uuid,
	"source_tag_id" uuid,
	"is_archived" boolean DEFAULT false,
	"is_locked" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"archived_at" timestamp with time zone,
	CONSTRAINT "branches_design_name_unique" UNIQUE("design_id","name")
);
--> statement-breakpoint
CREATE TABLE "commits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_id" uuid NOT NULL,
	"branch_id" uuid NOT NULL,
	"parent_id" uuid,
	"merge_parent_id" uuid,
	"message" text NOT NULL,
	"items_changed" integer DEFAULT 0,
	"items_added" integer DEFAULT 0,
	"items_deleted" integer DEFAULT 0,
	"change_order_item_id" uuid,
	"revisions_assigned" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "conflict_reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_order_id" uuid NOT NULL,
	"item_master_id" uuid NOT NULL,
	"conflict_type" varchar(50) NOT NULL,
	"their_eco_id" uuid,
	"conflict_signature" varchar(64) NOT NULL,
	"reviewed_by" uuid NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	CONSTRAINT "conflict_reviews_unique" UNIQUE("change_order_id","item_master_id","conflict_type","their_eco_id")
);
--> statement-breakpoint
CREATE TABLE "item_field_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_version_id" uuid NOT NULL,
	"field_name" varchar(100) NOT NULL,
	"field_path" varchar(255),
	"old_value" jsonb,
	"new_value" jsonb,
	"field_category" varchar(20) DEFAULT 'core'
);
--> statement-breakpoint
CREATE TABLE "item_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"commit_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"change_type" varchar(20) NOT NULL,
	"previous_item_id" uuid,
	CONSTRAINT "item_versions_unique" UNIQUE("commit_id","item_id")
);
--> statement-breakpoint
CREATE TABLE "tags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"design_id" uuid NOT NULL,
	"name" varchar(100) NOT NULL,
	"description" text,
	"commit_id" uuid NOT NULL,
	"tag_type" varchar(20) DEFAULT 'baseline',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "tags_design_name_unique" UNIQUE("design_id","name")
);
--> statement-breakpoint
CREATE TABLE "change_order_affected_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_order_id" uuid NOT NULL,
	"affected_item_id" uuid,
	"affected_item_master_id" uuid,
	"change_action" varchar(20) NOT NULL,
	"current_state" varchar(50),
	"current_revision" varchar(10),
	"target_state" varchar(50),
	"target_revision" varchar(10),
	"replacement_item_id" uuid,
	"new_item_data" jsonb,
	"new_item_type" varchar(50),
	"change_description" text,
	"is_directly_affected" boolean DEFAULT true,
	"working_copy_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_order_designs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_order_id" uuid NOT NULL,
	"design_id" uuid NOT NULL,
	"branch_id" uuid,
	"merge_status" varchar(20) DEFAULT 'pending',
	"merged_at" timestamp with time zone,
	"merge_commit_id" uuid,
	"items_affected" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "change_order_designs_unique" UNIQUE("change_order_id","design_id")
);
--> statement-breakpoint
CREATE TABLE "change_order_impact_reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_order_id" uuid NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"total_impacted_items" integer,
	"max_bom_depth" integer,
	"report_data" jsonb,
	"generation_duration_ms" integer,
	CONSTRAINT "change_order_impact_reports_change_order_id_unique" UNIQUE("change_order_id")
);
--> statement-breakpoint
CREATE TABLE "change_order_impacted_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_order_id" uuid NOT NULL,
	"impacted_item_id" uuid NOT NULL,
	"impact_type" varchar(50) NOT NULL,
	"impact_severity" varchar(20),
	"depth" integer,
	"path" jsonb,
	"metadata" jsonb,
	"discovered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_order_risks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"change_order_id" uuid NOT NULL,
	"category" varchar(50) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"description" text NOT NULL,
	"affected_items" jsonb,
	"mitigation" text,
	"requires_acknowledgement" boolean DEFAULT false,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "change_orders" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"change_type" varchar(20) NOT NULL,
	"priority" varchar(20) DEFAULT 'medium',
	"reason_for_change" text,
	"impact_description" text,
	"implementation_date" timestamp with time zone,
	"submitted_at" timestamp with time zone,
	"approved_at" timestamp with time zone,
	"approved_by" uuid,
	"implemented_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"impact_assessment_status" varchar(20) DEFAULT 'pending',
	"risk_level" varchar(20),
	"is_baseline" boolean DEFAULT false,
	"baseline_name" varchar(100)
);
--> statement-breakpoint
CREATE TABLE "documents" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"description" text,
	"file_id" uuid,
	"file_name" varchar(500),
	"file_size" integer,
	"mime_type" varchar(100),
	"storage_path" text
);
--> statement-breakpoint
CREATE TABLE "execution_sign_offs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"execution_id" uuid NOT NULL,
	"reviewer_id" uuid NOT NULL,
	"decision" varchar(20) NOT NULL,
	"comments" text,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "issues" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"description" text,
	"severity" varchar(20),
	"priority" varchar(20),
	"category" varchar(50),
	"reported_by" uuid,
	"reported_date" timestamp with time zone,
	"assigned_to" uuid,
	"resolution" text,
	"resolved_date" timestamp with time zone,
	"root_cause" text,
	"affected_item_ids" jsonb,
	"program_id" uuid,
	"design_ids" jsonb
);
--> statement-breakpoint
CREATE TABLE "item_relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"source_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"relationship_type" varchar(50) NOT NULL,
	"quantity" numeric(10, 3),
	"reference_designator" text,
	"find_number" integer,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"is_composite" boolean DEFAULT false,
	"is_directed" boolean DEFAULT true,
	"multiplicity_lower" integer DEFAULT 1,
	"multiplicity_upper" integer,
	"usage_attributes" jsonb,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" uuid,
	"source_design_id" uuid,
	"target_design_id" uuid,
	"source_domain" varchar(50),
	"target_domain" varchar(50),
	"derivation_method" varchar(50),
	"derivation_notes" text,
	CONSTRAINT "item_relationships_source_id_target_id_relationship_type_unique" UNIQUE("source_id","target_id","relationship_type")
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"master_id" uuid NOT NULL,
	"item_number" varchar(100) NOT NULL,
	"revision" varchar(10) NOT NULL,
	"item_type" varchar(50) NOT NULL,
	"name" varchar(500),
	"state" varchar(50) DEFAULT 'Draft' NOT NULL,
	"is_current" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" uuid NOT NULL,
	"locked_by" uuid,
	"locked_at" timestamp with time zone,
	"design_id" uuid,
	"commit_id" uuid,
	"in_design_structure" boolean DEFAULT true,
	"attributes" jsonb DEFAULT '{}'::jsonb,
	"metamodel" varchar(50) DEFAULT 'cascadia',
	"sysml_type" varchar(100),
	"is_deleted" boolean DEFAULT false,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"usage_of" uuid,
	CONSTRAINT "items_item_number_revision_design_id_item_type_unique" UNIQUE("item_number","revision","design_id","item_type")
);
--> statement-breakpoint
CREATE TABLE "parts" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"description" text,
	"part_type" varchar(20),
	"material" varchar(100),
	"weight" numeric(10, 3),
	"weight_unit" varchar(10),
	"cost" numeric(10, 2),
	"cost_currency" varchar(3),
	"lead_time_days" integer,
	"quantity_on_hand" integer DEFAULT 0,
	"reorder_point" integer,
	"location" text,
	"last_inventory_check" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "requirements" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"description" text,
	"type" varchar(50),
	"priority" varchar(20),
	"status" varchar(50),
	"acceptance_criteria" text,
	"source" varchar(200),
	"category" varchar(100),
	"verification_method" varchar(50),
	"verification_status" varchar(50),
	"allocated_design_id" uuid,
	"parent_requirement_id" uuid
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"program_id" uuid,
	"parent_task_id" uuid,
	"description" text,
	"assignee" uuid,
	"priority" varchar(20),
	"due_date" timestamp with time zone,
	"estimated_hours" numeric(6, 2),
	"actual_hours" numeric(6, 2),
	"tags" jsonb
);
--> statement-breakpoint
CREATE TABLE "test_cases" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"test_plan_id" uuid,
	"test_type" varchar(50),
	"preconditions" text,
	"steps" jsonb,
	"execution_status" varchar(50),
	"last_executed_at" timestamp with time zone,
	"last_executed_by" uuid,
	"environment" varchar(100)
);
--> statement-breakpoint
CREATE TABLE "test_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"test_case_id" uuid NOT NULL,
	"executor_id" uuid NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" varchar(50) NOT NULL,
	"duration" integer,
	"environment" varchar(100),
	"actual_results" text,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "test_plans" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"scope" text,
	"environment" varchar(100),
	"entry_criteria" text,
	"exit_criteria" text,
	"status" varchar(50)
);
--> statement-breakpoint
CREATE TABLE "work_instruction_change_alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_instruction_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"eco_id" uuid,
	"change_type" varchar(50) NOT NULL,
	"changed_fields" jsonb,
	"previous_values" jsonb,
	"new_values" jsonb,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"acknowledged_by" uuid,
	"acknowledged_at" timestamp with time zone,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_instruction_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_instruction_id" uuid NOT NULL,
	"work_instruction_revision" varchar(10),
	"work_order_id" uuid,
	"executed_by" uuid NOT NULL,
	"status" varchar(30) DEFAULT 'In Progress' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"duration" integer,
	"step_data" jsonb DEFAULT '{}'::jsonb,
	"notes" text,
	"current_step_index" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_instruction_operations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_instruction_id" uuid NOT NULL,
	"order_index" integer NOT NULL,
	"title" varchar(500) NOT NULL,
	"description" text,
	"estimated_time" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_instruction_part_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_instruction_id" uuid NOT NULL,
	"part_id" uuid NOT NULL,
	"inherit_to_mbom" boolean DEFAULT false,
	"inherited_from_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	CONSTRAINT "wi_part_attachment_unique" UNIQUE("work_instruction_id","part_id")
);
--> statement-breakpoint
CREATE TABLE "work_instruction_steps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_instruction_id" uuid NOT NULL,
	"operation_id" uuid,
	"order_index" integer NOT NULL,
	"title" varchar(500),
	"content" jsonb DEFAULT '{"blocks":[]}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "work_instructions" (
	"item_id" uuid PRIMARY KEY NOT NULL,
	"description" text,
	"estimated_time" integer,
	"difficulty" varchar(20),
	"safety_notes" text,
	"required_tools" text
);
--> statement-breakpoint
CREATE TABLE "work_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"work_order_number" varchar(20) NOT NULL,
	"part_id" uuid,
	"quantity" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'Not Started' NOT NULL,
	"priority" varchar(10) DEFAULT 'Normal' NOT NULL,
	"due_date" timestamp with time zone,
	"customer_order" varchar(200),
	"notes" text,
	"assigned_to" jsonb DEFAULT '[]'::jsonb,
	"program_id" uuid,
	"quantity_completed" integer DEFAULT 0 NOT NULL,
	"requires_sign_off" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" uuid NOT NULL,
	CONSTRAINT "work_orders_work_order_number_unique" UNIQUE("work_order_number")
);
--> statement-breakpoint
CREATE TABLE "workflow_approval_votes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_instance_id" uuid NOT NULL,
	"state_id" varchar(100) NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid,
	"vote" varchar(10) NOT NULL,
	"comments" text,
	"voted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(200) NOT NULL,
	"version" integer NOT NULL,
	"workflow_type" varchar(20) NOT NULL,
	"definition" jsonb NOT NULL,
	"is_active" boolean DEFAULT true,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"lifecycle_type" "lifecycle_type" DEFAULT 'Free',
	"drivers" jsonb DEFAULT '[]'::jsonb,
	CONSTRAINT "workflow_definitions_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "workflow_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"from_state" varchar(100),
	"to_state" varchar(100),
	"action" varchar(200),
	"actor_id" uuid,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"comments" text,
	"data" jsonb
);
--> statement-breakpoint
CREATE TABLE "workflow_instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_definition_id" uuid,
	"item_id" uuid,
	"current_state" varchar(100),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"context" jsonb,
	"instance_states" jsonb,
	"instance_transitions" jsonb,
	"scope_locked" boolean DEFAULT false,
	"scope_locked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "workflow_state_approvers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workflow_definition_id" uuid NOT NULL,
	"state_id" varchar(100) NOT NULL,
	"approver_type" varchar(10) NOT NULL,
	"approver_id" uuid NOT NULL,
	"is_required" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "vault_file_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_id" uuid NOT NULL,
	"action" varchar(50) NOT NULL,
	"performed_by" uuid NOT NULL,
	"performed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"details" jsonb
);
--> statement-breakpoint
CREATE TABLE "vault_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_id" uuid NOT NULL,
	"branch_id" uuid,
	"file_name" text NOT NULL,
	"original_file_name" text NOT NULL,
	"file_size" bigint NOT NULL,
	"mime_type" varchar(200) NOT NULL,
	"file_hash" varchar(64) NOT NULL,
	"storage_type" varchar(50) DEFAULT 'local' NOT NULL,
	"storage_path" text NOT NULL,
	"file_version" integer DEFAULT 1 NOT NULL,
	"is_latest_version" boolean DEFAULT true NOT NULL,
	"is_checked_out" boolean DEFAULT false NOT NULL,
	"checked_out_by" uuid,
	"checked_out_at" timestamp with time zone,
	"uploaded_by" uuid NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"metadata" jsonb,
	"file_category" varchar(50),
	"is_primary_model" boolean DEFAULT false,
	"cad_metadata" jsonb,
	"thumbnail_file_id" uuid,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid
);
--> statement-breakpoint
CREATE TABLE "settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" text,
	"json_value" jsonb,
	"description" text,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" uuid NOT NULL,
	CONSTRAINT "settings_key_unique" UNIQUE("key")
);
--> statement-breakpoint
CREATE TABLE "cots_components" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"manufacturer" text,
	"mpn" text,
	"description" text,
	"specs" jsonb,
	"datasheet_url" text,
	"image_url" text,
	"supplier_links" jsonb,
	"source" text NOT NULL,
	"tags" text[],
	"import_date" timestamp with time zone DEFAULT now() NOT NULL,
	"last_updated" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "part_cots_mapping" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"part_id" uuid NOT NULL,
	"cots_component_id" uuid NOT NULL,
	"is_preferred" boolean DEFAULT false,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid
);
--> statement-breakpoint
CREATE TABLE "report_columns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"field_path" varchar(255) NOT NULL,
	"label" varchar(255) NOT NULL,
	"display_order" integer DEFAULT 0 NOT NULL,
	"format_type" varchar(50),
	"is_visible" boolean DEFAULT true NOT NULL,
	"width" integer
);
--> statement-breakpoint
CREATE TABLE "report_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"executed_by" uuid NOT NULL,
	"executed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"row_count" integer,
	"duration_ms" integer,
	"parameters" jsonb,
	"success" boolean DEFAULT true NOT NULL,
	"error_message" text
);
--> statement-breakpoint
CREATE TABLE "report_exports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"execution_id" uuid,
	"exported_by" uuid NOT NULL,
	"exported_at" timestamp with time zone DEFAULT now() NOT NULL,
	"format" varchar(20) DEFAULT 'csv' NOT NULL,
	"file_name" varchar(255),
	"file_size" integer,
	"storage_path" text
);
--> statement-breakpoint
CREATE TABLE "report_filters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"field_path" varchar(255) NOT NULL,
	"operator" varchar(50) NOT NULL,
	"value" text,
	"value2" text,
	"display_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "report_sorts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"report_id" uuid NOT NULL,
	"field_path" varchar(255) NOT NULL,
	"direction" varchar(10) DEFAULT 'asc' NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"item_type" varchar(50) NOT NULL,
	"is_public" boolean DEFAULT false NOT NULL,
	"shared_with_roles" jsonb,
	"shared_with_users" jsonb,
	"config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "error_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"message" text NOT NULL,
	"severity" text NOT NULL,
	"http_status" integer,
	"is_operational" boolean DEFAULT true,
	"request_id" text,
	"user_id" uuid,
	"resource" text,
	"operation" text,
	"method" text,
	"path" text,
	"user_agent" text,
	"stack" text,
	"context" jsonb,
	"field_errors" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_type_configs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_type" varchar(50) NOT NULL,
	"config" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"modified_by" uuid NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_type_configs_item_type_unique" UNIQUE("item_type")
);
--> statement-breakpoint
CREATE TABLE "job_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"level" varchar(10) NOT NULL,
	"message" text NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" varchar(100) NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"priority" varchar(20) DEFAULT 'normal' NOT NULL,
	"payload" jsonb NOT NULL,
	"result" jsonb,
	"error" text,
	"progress" integer DEFAULT 0,
	"progress_message" text,
	"item_id" uuid,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"queued_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0,
	"max_attempts" integer DEFAULT 3,
	"next_retry_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "number_sequences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_type" varchar(50) NOT NULL,
	"scope_key" varchar(200) NOT NULL,
	"current_value" integer DEFAULT 0 NOT NULL,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "unique_sequence" UNIQUE("item_type","scope_key")
);
--> statement-breakpoint
CREATE TABLE "ai_chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"tool_calls" jsonb,
	"tool_call_id" varchar(100),
	"tool_name" varchar(100),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"program_id" uuid,
	"design_id" uuid,
	"title" varchar(255),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"program_id" uuid,
	"provider" varchar(50) NOT NULL,
	"config" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_usage_logs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid,
	"user_id" uuid NOT NULL,
	"tool_name" varchar(100),
	"tool_params" jsonb,
	"tool_result" jsonb,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"provider" varchar(50),
	"model" varchar(100),
	"duration_ms" integer,
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "upstream_changes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_design_id" uuid NOT NULL,
	"source_design_id" uuid NOT NULL,
	"source_commit_id" uuid,
	"source_eco_id" uuid,
	"changed_items" jsonb NOT NULL,
	"status" varchar(50) DEFAULT 'pending' NOT NULL,
	"reviewed_by" uuid,
	"reviewed_at" timestamp with time zone,
	"review_notes" text,
	"response_eco_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "thread_path_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"root_item_id" uuid NOT NULL,
	"cache_config_hash" varchar(64) NOT NULL,
	"design_id" uuid,
	"context_type" varchar(20),
	"context_id" uuid,
	"thread_data" jsonb NOT NULL,
	"included_item_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"invalidated_at" timestamp with time zone,
	"hit_count" integer DEFAULT 0 NOT NULL,
	"last_accessed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"computation_time_ms" integer
);
--> statement-breakpoint
CREATE TABLE "design_cross_references" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referencing_design_id" uuid NOT NULL,
	"referenced_item_id" uuid NOT NULL,
	"source_design_id" uuid NOT NULL,
	"branch_id" uuid,
	"change_type" varchar(20),
	"in_design_structure" boolean DEFAULT true,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_by" uuid,
	"modified_at" timestamp with time zone DEFAULT now() NOT NULL,
	"modified_by" uuid,
	CONSTRAINT "design_cross_refs_unique" UNIQUE("referencing_design_id","referenced_item_id","branch_id")
);
--> statement-breakpoint
CREATE TABLE "design_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"ai_chat_session_id" uuid,
	"program_id" uuid NOT NULL,
	"design_id" uuid,
	"title" varchar(255),
	"stage" varchar(50) DEFAULT 'idle' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"description" text,
	"artifacts" jsonb,
	"llm_history" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"materialized_design_id" uuid,
	"error_message" text
);
--> statement-breakpoint
ALTER TABLE "auth_events" ADD CONSTRAINT "auth_events_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_members" ADD CONSTRAINT "program_members_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_members" ADD CONSTRAINT "program_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "program_members" ADD CONSTRAINT "program_members_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "programs" ADD CONSTRAINT "programs_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "designs" ADD CONSTRAINT "designs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_items" ADD CONSTRAINT "branch_items_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branch_items" ADD CONSTRAINT "branch_items_checked_out_by_users_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "branches" ADD CONSTRAINT "branches_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commits" ADD CONSTRAINT "commits_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conflict_reviews" ADD CONSTRAINT "conflict_reviews_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_field_changes" ADD CONSTRAINT "item_field_changes_item_version_id_item_versions_id_fk" FOREIGN KEY ("item_version_id") REFERENCES "public"."item_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_versions" ADD CONSTRAINT "item_versions_commit_id_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."commits"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_commit_id_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tags" ADD CONSTRAINT "tags_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_affected_items" ADD CONSTRAINT "change_order_affected_items_change_order_id_change_orders_item_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_affected_items" ADD CONSTRAINT "change_order_affected_items_affected_item_id_items_id_fk" FOREIGN KEY ("affected_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_affected_items" ADD CONSTRAINT "change_order_affected_items_replacement_item_id_items_id_fk" FOREIGN KEY ("replacement_item_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_affected_items" ADD CONSTRAINT "change_order_affected_items_working_copy_id_items_id_fk" FOREIGN KEY ("working_copy_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_affected_items" ADD CONSTRAINT "change_order_affected_items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_designs" ADD CONSTRAINT "change_order_designs_change_order_id_items_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_designs" ADD CONSTRAINT "change_order_designs_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_designs" ADD CONSTRAINT "change_order_designs_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_designs" ADD CONSTRAINT "change_order_designs_merge_commit_id_commits_id_fk" FOREIGN KEY ("merge_commit_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_impact_reports" ADD CONSTRAINT "change_order_impact_reports_change_order_id_change_orders_item_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_impacted_items" ADD CONSTRAINT "change_order_impacted_items_change_order_id_change_orders_item_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_impacted_items" ADD CONSTRAINT "change_order_impacted_items_impacted_item_id_items_id_fk" FOREIGN KEY ("impacted_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_risks" ADD CONSTRAINT "change_order_risks_change_order_id_change_orders_item_id_fk" FOREIGN KEY ("change_order_id") REFERENCES "public"."change_orders"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_order_risks" ADD CONSTRAINT "change_order_risks_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "change_orders" ADD CONSTRAINT "change_orders_approved_by_users_id_fk" FOREIGN KEY ("approved_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_sign_offs" ADD CONSTRAINT "execution_sign_offs_execution_id_work_instruction_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."work_instruction_executions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "execution_sign_offs" ADD CONSTRAINT "execution_sign_offs_reviewer_id_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_reported_by_users_id_fk" FOREIGN KEY ("reported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_relationships" ADD CONSTRAINT "item_relationships_source_id_items_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_relationships" ADD CONSTRAINT "item_relationships_target_id_items_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_relationships" ADD CONSTRAINT "item_relationships_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_relationships" ADD CONSTRAINT "item_relationships_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_relationships" ADD CONSTRAINT "item_relationships_source_design_id_designs_id_fk" FOREIGN KEY ("source_design_id") REFERENCES "public"."designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_relationships" ADD CONSTRAINT "item_relationships_target_design_id_designs_id_fk" FOREIGN KEY ("target_design_id") REFERENCES "public"."designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_locked_by_users_id_fk" FOREIGN KEY ("locked_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_commit_id_commits_id_fk" FOREIGN KEY ("commit_id") REFERENCES "public"."commits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "parts" ADD CONSTRAINT "parts_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_allocated_design_id_designs_id_fk" FOREIGN KEY ("allocated_design_id") REFERENCES "public"."designs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "requirements" ADD CONSTRAINT "requirements_parent_requirement_id_items_id_fk" FOREIGN KEY ("parent_requirement_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_parent_task_id_items_id_fk" FOREIGN KEY ("parent_task_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_users_id_fk" FOREIGN KEY ("assignee") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_test_plan_id_items_id_fk" FOREIGN KEY ("test_plan_id") REFERENCES "public"."items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_cases" ADD CONSTRAINT "test_cases_last_executed_by_users_id_fk" FOREIGN KEY ("last_executed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_executions" ADD CONSTRAINT "test_executions_test_case_id_items_id_fk" FOREIGN KEY ("test_case_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_executions" ADD CONSTRAINT "test_executions_executor_id_users_id_fk" FOREIGN KEY ("executor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "test_plans" ADD CONSTRAINT "test_plans_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_change_alerts" ADD CONSTRAINT "work_instruction_change_alerts_work_instruction_id_work_instructions_item_id_fk" FOREIGN KEY ("work_instruction_id") REFERENCES "public"."work_instructions"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_change_alerts" ADD CONSTRAINT "work_instruction_change_alerts_part_id_items_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_change_alerts" ADD CONSTRAINT "work_instruction_change_alerts_eco_id_items_id_fk" FOREIGN KEY ("eco_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_change_alerts" ADD CONSTRAINT "work_instruction_change_alerts_acknowledged_by_users_id_fk" FOREIGN KEY ("acknowledged_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_executions" ADD CONSTRAINT "work_instruction_executions_work_instruction_id_work_instructions_item_id_fk" FOREIGN KEY ("work_instruction_id") REFERENCES "public"."work_instructions"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_executions" ADD CONSTRAINT "work_instruction_executions_work_order_id_work_orders_id_fk" FOREIGN KEY ("work_order_id") REFERENCES "public"."work_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_executions" ADD CONSTRAINT "work_instruction_executions_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_operations" ADD CONSTRAINT "work_instruction_operations_work_instruction_id_work_instructions_item_id_fk" FOREIGN KEY ("work_instruction_id") REFERENCES "public"."work_instructions"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_part_attachments" ADD CONSTRAINT "work_instruction_part_attachments_work_instruction_id_work_instructions_item_id_fk" FOREIGN KEY ("work_instruction_id") REFERENCES "public"."work_instructions"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_part_attachments" ADD CONSTRAINT "work_instruction_part_attachments_part_id_items_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_part_attachments" ADD CONSTRAINT "work_instruction_part_attachments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_steps" ADD CONSTRAINT "work_instruction_steps_work_instruction_id_work_instructions_item_id_fk" FOREIGN KEY ("work_instruction_id") REFERENCES "public"."work_instructions"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instruction_steps" ADD CONSTRAINT "work_instruction_steps_operation_id_work_instruction_operations_id_fk" FOREIGN KEY ("operation_id") REFERENCES "public"."work_instruction_operations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_instructions" ADD CONSTRAINT "work_instructions_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_part_id_items_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_orders" ADD CONSTRAINT "work_orders_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_approval_votes" ADD CONSTRAINT "workflow_approval_votes_workflow_instance_id_workflow_instances_id_fk" FOREIGN KEY ("workflow_instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_approval_votes" ADD CONSTRAINT "workflow_approval_votes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_history" ADD CONSTRAINT "workflow_history_instance_id_workflow_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."workflow_instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_history" ADD CONSTRAINT "workflow_history_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_workflow_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_instances" ADD CONSTRAINT "workflow_instances_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_state_approvers" ADD CONSTRAINT "workflow_state_approvers_workflow_definition_id_workflow_definitions_id_fk" FOREIGN KEY ("workflow_definition_id") REFERENCES "public"."workflow_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workflow_state_approvers" ADD CONSTRAINT "workflow_state_approvers_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_file_history" ADD CONSTRAINT "vault_file_history_file_id_vault_files_id_fk" FOREIGN KEY ("file_id") REFERENCES "public"."vault_files"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_file_history" ADD CONSTRAINT "vault_file_history_performed_by_users_id_fk" FOREIGN KEY ("performed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_files" ADD CONSTRAINT "vault_files_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_files" ADD CONSTRAINT "vault_files_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_files" ADD CONSTRAINT "vault_files_checked_out_by_users_id_fk" FOREIGN KEY ("checked_out_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_files" ADD CONSTRAINT "vault_files_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vault_files" ADD CONSTRAINT "vault_files_deleted_by_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "settings" ADD CONSTRAINT "settings_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_cots_mapping" ADD CONSTRAINT "part_cots_mapping_part_id_parts_item_id_fk" FOREIGN KEY ("part_id") REFERENCES "public"."parts"("item_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_cots_mapping" ADD CONSTRAINT "part_cots_mapping_cots_component_id_cots_components_id_fk" FOREIGN KEY ("cots_component_id") REFERENCES "public"."cots_components"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "part_cots_mapping" ADD CONSTRAINT "part_cots_mapping_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_columns" ADD CONSTRAINT "report_columns_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_executions" ADD CONSTRAINT "report_executions_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_executions" ADD CONSTRAINT "report_executions_executed_by_users_id_fk" FOREIGN KEY ("executed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_execution_id_report_executions_id_fk" FOREIGN KEY ("execution_id") REFERENCES "public"."report_executions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_exports" ADD CONSTRAINT "report_exports_exported_by_users_id_fk" FOREIGN KEY ("exported_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_filters" ADD CONSTRAINT "report_filters_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "report_sorts" ADD CONSTRAINT "report_sorts_report_id_reports_id_fk" FOREIGN KEY ("report_id") REFERENCES "public"."reports"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "error_logs" ADD CONSTRAINT "error_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_type_configs" ADD CONSTRAINT "item_type_configs_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_logs" ADD CONSTRAINT "job_logs_job_id_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "public"."jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_messages" ADD CONSTRAINT "ai_chat_messages_session_id_ai_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ai_chat_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ai_chat_sessions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_chat_sessions" ADD CONSTRAINT "ai_chat_sessions_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_settings" ADD CONSTRAINT "ai_settings_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_session_id_ai_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."ai_chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_usage_logs" ADD CONSTRAINT "ai_usage_logs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_changes" ADD CONSTRAINT "upstream_changes_target_design_id_designs_id_fk" FOREIGN KEY ("target_design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_changes" ADD CONSTRAINT "upstream_changes_source_design_id_designs_id_fk" FOREIGN KEY ("source_design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_changes" ADD CONSTRAINT "upstream_changes_source_eco_id_items_id_fk" FOREIGN KEY ("source_eco_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_changes" ADD CONSTRAINT "upstream_changes_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "upstream_changes" ADD CONSTRAINT "upstream_changes_response_eco_id_items_id_fk" FOREIGN KEY ("response_eco_id") REFERENCES "public"."items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_path_cache" ADD CONSTRAINT "thread_path_cache_root_item_id_items_id_fk" FOREIGN KEY ("root_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "thread_path_cache" ADD CONSTRAINT "thread_path_cache_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_cross_references" ADD CONSTRAINT "design_cross_references_referencing_design_id_designs_id_fk" FOREIGN KEY ("referencing_design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_cross_references" ADD CONSTRAINT "design_cross_references_source_design_id_designs_id_fk" FOREIGN KEY ("source_design_id") REFERENCES "public"."designs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_cross_references" ADD CONSTRAINT "design_cross_references_branch_id_branches_id_fk" FOREIGN KEY ("branch_id") REFERENCES "public"."branches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_cross_references" ADD CONSTRAINT "design_cross_references_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_cross_references" ADD CONSTRAINT "design_cross_references_modified_by_users_id_fk" FOREIGN KEY ("modified_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_ai_chat_session_id_ai_chat_sessions_id_fk" FOREIGN KEY ("ai_chat_session_id") REFERENCES "public"."ai_chat_sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_program_id_programs_id_fk" FOREIGN KEY ("program_id") REFERENCES "public"."programs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_design_id_designs_id_fk" FOREIGN KEY ("design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "design_sessions" ADD CONSTRAINT "design_sessions_materialized_design_id_designs_id_fk" FOREIGN KEY ("materialized_design_id") REFERENCES "public"."designs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_program_member_user" ON "program_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_program_status" ON "programs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_program_attributes" ON "programs" USING gin ("attributes");--> statement-breakpoint
CREATE INDEX "idx_design_program" ON "designs" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_design_type" ON "designs" USING btree ("design_type");--> statement-breakpoint
CREATE INDEX "idx_design_parent" ON "designs" USING btree ("parent_design_id");--> statement-breakpoint
CREATE INDEX "idx_design_clone_source" ON "designs" USING btree ("clone_source_design_id");--> statement-breakpoint
CREATE INDEX "idx_design_source" ON "designs" USING btree ("source_design_id");--> statement-breakpoint
CREATE INDEX "idx_design_attributes" ON "designs" USING gin ("attributes");--> statement-breakpoint
CREATE INDEX "idx_branch_items_branch" ON "branch_items" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_branch_items_master" ON "branch_items" USING btree ("item_master_id");--> statement-breakpoint
CREATE INDEX "idx_branch_items_checkout" ON "branch_items" USING btree ("checked_out_by");--> statement-breakpoint
CREATE INDEX "idx_branch_design" ON "branches" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "idx_branch_eco" ON "branches" USING btree ("change_order_item_id");--> statement-breakpoint
CREATE INDEX "idx_branch_owner" ON "branches" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "idx_branch_type" ON "branches" USING btree ("branch_type");--> statement-breakpoint
CREATE INDEX "idx_commit_design" ON "commits" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "idx_commit_branch" ON "commits" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_commit_parent" ON "commits" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "idx_commit_date" ON "commits" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_conflict_reviews_change_order" ON "conflict_reviews" USING btree ("change_order_id");--> statement-breakpoint
CREATE INDEX "idx_conflict_reviews_item" ON "conflict_reviews" USING btree ("item_master_id");--> statement-breakpoint
CREATE INDEX "idx_conflict_reviews_reviewer" ON "conflict_reviews" USING btree ("reviewed_by");--> statement-breakpoint
CREATE INDEX "idx_field_changes_version" ON "item_field_changes" USING btree ("item_version_id");--> statement-breakpoint
CREATE INDEX "idx_field_changes_field" ON "item_field_changes" USING btree ("field_name");--> statement-breakpoint
CREATE INDEX "idx_item_versions_commit" ON "item_versions" USING btree ("commit_id");--> statement-breakpoint
CREATE INDEX "idx_item_versions_item" ON "item_versions" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_tag_design" ON "tags" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "idx_tag_commit" ON "tags" USING btree ("commit_id");--> statement-breakpoint
CREATE INDEX "idx_change_order" ON "change_order_affected_items" USING btree ("change_order_id");--> statement-breakpoint
CREATE INDEX "idx_affected_item" ON "change_order_affected_items" USING btree ("affected_item_id");--> statement-breakpoint
CREATE INDEX "idx_working_copy" ON "change_order_affected_items" USING btree ("working_copy_id");--> statement-breakpoint
CREATE INDEX "idx_cod_change_order" ON "change_order_designs" USING btree ("change_order_id");--> statement-breakpoint
CREATE INDEX "idx_cod_design" ON "change_order_designs" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "idx_cod_branch" ON "change_order_designs" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_co_impacted" ON "change_order_impacted_items" USING btree ("change_order_id");--> statement-breakpoint
CREATE INDEX "idx_impacted_item" ON "change_order_impacted_items" USING btree ("impacted_item_id");--> statement-breakpoint
CREATE INDEX "idx_co_risks" ON "change_order_risks" USING btree ("change_order_id");--> statement-breakpoint
CREATE INDEX "idx_sign_off_execution" ON "execution_sign_offs" USING btree ("execution_id");--> statement-breakpoint
CREATE INDEX "idx_sign_off_reviewer" ON "execution_sign_offs" USING btree ("reviewer_id");--> statement-breakpoint
CREATE INDEX "idx_issue_severity" ON "issues" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_issue_priority" ON "issues" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "idx_issue_category" ON "issues" USING btree ("category");--> statement-breakpoint
CREATE INDEX "idx_issue_assigned" ON "issues" USING btree ("assigned_to");--> statement-breakpoint
CREATE INDEX "idx_issue_program" ON "issues" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_issue_design_ids" ON "issues" USING gin ("design_ids");--> statement-breakpoint
CREATE INDEX "idx_source" ON "item_relationships" USING btree ("source_id");--> statement-breakpoint
CREATE INDEX "idx_target" ON "item_relationships" USING btree ("target_id");--> statement-breakpoint
CREATE INDEX "idx_relationship_type" ON "item_relationships" USING btree ("relationship_type");--> statement-breakpoint
CREATE INDEX "idx_cross_design" ON "item_relationships" USING btree ("source_design_id","target_design_id");--> statement-breakpoint
CREATE INDEX "idx_master_id" ON "items" USING btree ("master_id");--> statement-breakpoint
CREATE INDEX "idx_item_type_state" ON "items" USING btree ("item_type","state");--> statement-breakpoint
CREATE INDEX "idx_current" ON "items" USING btree ("is_current");--> statement-breakpoint
CREATE INDEX "idx_item_design" ON "items" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "idx_item_commit" ON "items" USING btree ("commit_id");--> statement-breakpoint
CREATE INDEX "idx_item_attributes" ON "items" USING gin ("attributes");--> statement-breakpoint
CREATE INDEX "idx_item_usage_of" ON "items" USING btree ("usage_of");--> statement-breakpoint
CREATE INDEX "idx_items_fts" ON "items" USING gin (to_tsvector('simple', coalesce("item_number", '') || ' ' || coalesce("name", '')));--> statement-breakpoint
CREATE INDEX "idx_req_parent" ON "requirements" USING btree ("parent_requirement_id");--> statement-breakpoint
CREATE INDEX "idx_req_allocated" ON "requirements" USING btree ("allocated_design_id");--> statement-breakpoint
CREATE INDEX "idx_req_verification_status" ON "requirements" USING btree ("verification_status");--> statement-breakpoint
CREATE INDEX "idx_task_program" ON "tasks" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_task_assignee" ON "tasks" USING btree ("assignee");--> statement-breakpoint
CREATE INDEX "idx_parent_task" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "idx_test_case_plan" ON "test_cases" USING btree ("test_plan_id");--> statement-breakpoint
CREATE INDEX "idx_test_execution_status" ON "test_cases" USING btree ("execution_status");--> statement-breakpoint
CREATE INDEX "idx_test_exec_test_case" ON "test_executions" USING btree ("test_case_id");--> statement-breakpoint
CREATE INDEX "idx_test_exec_date" ON "test_executions" USING btree ("executed_at");--> statement-breakpoint
CREATE INDEX "idx_wi_alert_wi" ON "work_instruction_change_alerts" USING btree ("work_instruction_id");--> statement-breakpoint
CREATE INDEX "idx_wi_alert_part" ON "work_instruction_change_alerts" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "idx_wi_alert_status" ON "work_instruction_change_alerts" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_wi_alert_eco" ON "work_instruction_change_alerts" USING btree ("eco_id");--> statement-breakpoint
CREATE INDEX "idx_wi_execution_wi" ON "work_instruction_executions" USING btree ("work_instruction_id");--> statement-breakpoint
CREATE INDEX "idx_wi_execution_wo" ON "work_instruction_executions" USING btree ("work_order_id");--> statement-breakpoint
CREATE INDEX "idx_wi_execution_user" ON "work_instruction_executions" USING btree ("executed_by");--> statement-breakpoint
CREATE INDEX "idx_wi_execution_status" ON "work_instruction_executions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_wi_execution_started" ON "work_instruction_executions" USING btree ("started_at");--> statement-breakpoint
CREATE INDEX "idx_wi_operation_order" ON "work_instruction_operations" USING btree ("work_instruction_id","order_index");--> statement-breakpoint
CREATE INDEX "idx_wi_part_wi" ON "work_instruction_part_attachments" USING btree ("work_instruction_id");--> statement-breakpoint
CREATE INDEX "idx_wi_part_part" ON "work_instruction_part_attachments" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "idx_wi_step_order" ON "work_instruction_steps" USING btree ("work_instruction_id","order_index");--> statement-breakpoint
CREATE INDEX "idx_wi_step_operation" ON "work_instruction_steps" USING btree ("operation_id");--> statement-breakpoint
CREATE INDEX "idx_work_order_status" ON "work_orders" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_work_order_part" ON "work_orders" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "idx_work_order_due_date" ON "work_orders" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "idx_work_order_program" ON "work_orders" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "idx_work_order_customer" ON "work_orders" USING btree ("customer_order");--> statement-breakpoint
CREATE INDEX "idx_vault_history_file_id" ON "vault_file_history" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "idx_vault_history_performed_by" ON "vault_file_history" USING btree ("performed_by");--> statement-breakpoint
CREATE INDEX "idx_vault_history_performed_at" ON "vault_file_history" USING btree ("performed_at");--> statement-breakpoint
CREATE INDEX "idx_vault_files_item_id" ON "vault_files" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_vault_files_branch_id" ON "vault_files" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "idx_vault_files_hash" ON "vault_files" USING btree ("file_hash");--> statement-breakpoint
CREATE INDEX "idx_vault_files_checked_out_by" ON "vault_files" USING btree ("checked_out_by");--> statement-breakpoint
CREATE INDEX "idx_vault_files_latest" ON "vault_files" USING btree ("is_latest_version");--> statement-breakpoint
CREATE INDEX "idx_vault_files_deleted" ON "vault_files" USING btree ("deleted_at");--> statement-breakpoint
CREATE INDEX "idx_vault_files_category" ON "vault_files" USING btree ("file_category");--> statement-breakpoint
CREATE INDEX "idx_vault_files_primary" ON "vault_files" USING btree ("is_primary_model");--> statement-breakpoint
CREATE INDEX "idx_vault_files_thumbnail" ON "vault_files" USING btree ("thumbnail_file_id");--> statement-breakpoint
CREATE INDEX "cots_components_tags_idx" ON "cots_components" USING btree ("tags");--> statement-breakpoint
CREATE INDEX "cots_components_manufacturer_idx" ON "cots_components" USING btree ("manufacturer");--> statement-breakpoint
CREATE INDEX "cots_components_source_idx" ON "cots_components" USING btree ("source");--> statement-breakpoint
CREATE INDEX "part_cots_mapping_part_idx" ON "part_cots_mapping" USING btree ("part_id");--> statement-breakpoint
CREATE INDEX "part_cots_mapping_cots_idx" ON "part_cots_mapping" USING btree ("cots_component_id");--> statement-breakpoint
CREATE INDEX "idx_report_columns_report" ON "report_columns" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_report_executions_report" ON "report_executions" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_report_executions_executed_by" ON "report_executions" USING btree ("executed_by");--> statement-breakpoint
CREATE INDEX "idx_report_executions_executed_at" ON "report_executions" USING btree ("executed_at");--> statement-breakpoint
CREATE INDEX "idx_report_exports_report" ON "report_exports" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_report_exports_exported_by" ON "report_exports" USING btree ("exported_by");--> statement-breakpoint
CREATE INDEX "idx_report_filters_report" ON "report_filters" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_report_sorts_report" ON "report_sorts" USING btree ("report_id");--> statement-breakpoint
CREATE INDEX "idx_reports_item_type" ON "reports" USING btree ("item_type");--> statement-breakpoint
CREATE INDEX "idx_reports_created_by" ON "reports" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_reports_is_public" ON "reports" USING btree ("is_public");--> statement-breakpoint
CREATE INDEX "idx_error_logs_code" ON "error_logs" USING btree ("code");--> statement-breakpoint
CREATE INDEX "idx_error_logs_created_at" ON "error_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_error_logs_user_id" ON "error_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "idx_error_logs_severity" ON "error_logs" USING btree ("severity");--> statement-breakpoint
CREATE INDEX "idx_job_logs_job" ON "job_logs" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "idx_job_logs_created_at" ON "job_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_status" ON "jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_jobs_type" ON "jobs" USING btree ("type");--> statement-breakpoint
CREATE INDEX "idx_jobs_item" ON "jobs" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "idx_jobs_created_by" ON "jobs" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "idx_jobs_created_at" ON "jobs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_next_retry" ON "jobs" USING btree ("next_retry_at");--> statement-breakpoint
CREATE INDEX "idx_jobs_status_priority" ON "jobs" USING btree ("status","priority");--> statement-breakpoint
CREATE INDEX "ai_chat_messages_session_id_idx" ON "ai_chat_messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ai_chat_messages_created_at_idx" ON "ai_chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "ai_chat_sessions_user_id_idx" ON "ai_chat_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_chat_sessions_program_id_idx" ON "ai_chat_sessions" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "ai_settings_program_id_idx" ON "ai_settings" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "ai_usage_logs_session_id_idx" ON "ai_usage_logs" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "ai_usage_logs_user_id_idx" ON "ai_usage_logs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_usage_logs_timestamp_idx" ON "ai_usage_logs" USING btree ("timestamp");--> statement-breakpoint
CREATE INDEX "idx_upstream_changes_target" ON "upstream_changes" USING btree ("target_design_id");--> statement-breakpoint
CREATE INDEX "idx_upstream_changes_source" ON "upstream_changes" USING btree ("source_design_id");--> statement-breakpoint
CREATE INDEX "idx_upstream_changes_status" ON "upstream_changes" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_upstream_changes_source_eco" ON "upstream_changes" USING btree ("source_eco_id");--> statement-breakpoint
CREATE INDEX "idx_thread_cache_root" ON "thread_path_cache" USING btree ("root_item_id");--> statement-breakpoint
CREATE INDEX "idx_thread_cache_expiry" ON "thread_path_cache" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "idx_thread_cache_design" ON "thread_path_cache" USING btree ("design_id");--> statement-breakpoint
CREATE INDEX "idx_thread_cache_items" ON "thread_path_cache" USING gin ("included_item_ids");--> statement-breakpoint
CREATE INDEX "idx_thread_cache_invalidated" ON "thread_path_cache" USING btree ("invalidated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_thread_cache_unique_key" ON "thread_path_cache" USING btree ("root_item_id","cache_config_hash",COALESCE("context_type", ''),COALESCE("context_id", '00000000-0000-0000-0000-000000000000'::uuid));--> statement-breakpoint
CREATE INDEX "idx_cross_ref_design" ON "design_cross_references" USING btree ("referencing_design_id");--> statement-breakpoint
CREATE INDEX "idx_cross_ref_item" ON "design_cross_references" USING btree ("referenced_item_id");--> statement-breakpoint
CREATE INDEX "idx_cross_ref_source" ON "design_cross_references" USING btree ("source_design_id");--> statement-breakpoint
CREATE INDEX "idx_cross_ref_branch" ON "design_cross_references" USING btree ("branch_id");--> statement-breakpoint
CREATE INDEX "design_sessions_user_id_idx" ON "design_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "design_sessions_program_id_idx" ON "design_sessions" USING btree ("program_id");--> statement-breakpoint
CREATE INDEX "design_sessions_status_idx" ON "design_sessions" USING btree ("status");