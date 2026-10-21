export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      action_alert_events: {
        Row: {
          actor_id: string | null
          alert_instance_id: string
          created_at: string
          event_type: string
          id: string
          metadata: Json
          note: string | null
        }
        Insert: {
          actor_id?: string | null
          alert_instance_id: string
          created_at?: string
          event_type: string
          id?: string
          metadata?: Json
          note?: string | null
        }
        Update: {
          actor_id?: string | null
          alert_instance_id?: string
          created_at?: string
          event_type?: string
          id?: string
          metadata?: Json
          note?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "action_alert_events_alert_instance_id_fkey"
            columns: ["alert_instance_id"]
            isOneToOne: false
            referencedRelation: "action_alert_instances"
            referencedColumns: ["id"]
          },
        ]
      }
      action_alert_instances: {
        Row: {
          alert_type: string
          assigned_at: string | null
          assigned_by: string | null
          assigned_to: string | null
          auto_resolved_at: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          first_seen_at: string
          id: string
          last_action_at: string | null
          last_seen_at: string
          metadata: Json
          occurrence_count: number
          reopened_at: string | null
          severity: string
          stable_key: string
          status: string
          updated_at: string
        }
        Insert: {
          alert_type: string
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_to?: string | null
          auto_resolved_at?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          first_seen_at?: string
          id?: string
          last_action_at?: string | null
          last_seen_at?: string
          metadata?: Json
          occurrence_count?: number
          reopened_at?: string | null
          severity?: string
          stable_key: string
          status?: string
          updated_at?: string
        }
        Update: {
          alert_type?: string
          assigned_at?: string | null
          assigned_by?: string | null
          assigned_to?: string | null
          auto_resolved_at?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          first_seen_at?: string
          id?: string
          last_action_at?: string | null
          last_seen_at?: string
          metadata?: Json
          occurrence_count?: number
          reopened_at?: string | null
          severity?: string
          stable_key?: string
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "action_alert_instances_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "action_alert_instances_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      app_schema_versions: {
        Row: {
          applied_at: string
          compatibility_version: number
          contract_key: string
          required_signatures: string[]
        }
        Insert: {
          applied_at?: string
          compatibility_version: number
          contract_key: string
          required_signatures?: string[]
        }
        Update: {
          applied_at?: string
          compatibility_version?: number
          contract_key?: string
          required_signatures?: string[]
        }
        Relationships: []
      }
      app_users: {
        Row: {
          approval_status: string | null
          approved_at: string | null
          approved_by: string | null
          created_at: string
          department_id: string | null
          email: string
          employee_id: string | null
          full_name: string | null
          id: string
          is_active: boolean
          last_approval_action_at: string | null
          last_login_at: string | null
          phone: string | null
          registration_note: string | null
          rejected_at: string | null
          rejected_by: string | null
          rejection_reason: string | null
          requested_role: string | null
          role_id: string | null
          updated_at: string
        }
        Insert: {
          approval_status?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          department_id?: string | null
          email: string
          employee_id?: string | null
          full_name?: string | null
          id: string
          is_active?: boolean
          last_approval_action_at?: string | null
          last_login_at?: string | null
          phone?: string | null
          registration_note?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          requested_role?: string | null
          role_id?: string | null
          updated_at?: string
        }
        Update: {
          approval_status?: string | null
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          department_id?: string | null
          email?: string
          employee_id?: string | null
          full_name?: string | null
          id?: string
          is_active?: boolean
          last_approval_action_at?: string | null
          last_login_at?: string | null
          phone?: string | null
          registration_note?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          requested_role?: string | null
          role_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "app_users_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_users_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "app_users_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_assignments: {
        Row: {
          asset_id: string
          assigned_at: string
          assigned_by: string | null
          created_at: string
          due_return_date: string | null
          employee_id: string
          id: string
          notes: string | null
          return_condition: string | null
          returned_at: string | null
          status: Database["public"]["Enums"]["assignment_status"]
          updated_at: string
        }
        Insert: {
          asset_id: string
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          due_return_date?: string | null
          employee_id: string
          id?: string
          notes?: string | null
          return_condition?: string | null
          returned_at?: string | null
          status?: Database["public"]["Enums"]["assignment_status"]
          updated_at?: string
        }
        Update: {
          asset_id?: string
          assigned_at?: string
          assigned_by?: string | null
          created_at?: string
          due_return_date?: string | null
          employee_id?: string
          id?: string
          notes?: string | null
          return_condition?: string | null
          returned_at?: string | null
          status?: Database["public"]["Enums"]["assignment_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "custody_current_anomalies"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "asset_assignments_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "financial_asset_data_quality"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "asset_assignments_assigned_by_fkey"
            columns: ["assigned_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_assignments_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_movements: {
        Row: {
          asset_id: string
          created_at: string
          from_employee_id: string | null
          from_location_id: string | null
          from_status: Database["public"]["Enums"]["asset_status"] | null
          id: string
          movement_type: Database["public"]["Enums"]["movement_type"]
          note: string | null
          performed_by: string | null
          to_employee_id: string | null
          to_location_id: string | null
          to_status: Database["public"]["Enums"]["asset_status"] | null
        }
        Insert: {
          asset_id: string
          created_at?: string
          from_employee_id?: string | null
          from_location_id?: string | null
          from_status?: Database["public"]["Enums"]["asset_status"] | null
          id?: string
          movement_type: Database["public"]["Enums"]["movement_type"]
          note?: string | null
          performed_by?: string | null
          to_employee_id?: string | null
          to_location_id?: string | null
          to_status?: Database["public"]["Enums"]["asset_status"] | null
        }
        Update: {
          asset_id?: string
          created_at?: string
          from_employee_id?: string | null
          from_location_id?: string | null
          from_status?: Database["public"]["Enums"]["asset_status"] | null
          id?: string
          movement_type?: Database["public"]["Enums"]["movement_type"]
          note?: string | null
          performed_by?: string | null
          to_employee_id?: string | null
          to_location_id?: string | null
          to_status?: Database["public"]["Enums"]["asset_status"] | null
        }
        Relationships: [
          {
            foreignKeyName: "asset_movements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_movements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "custody_current_anomalies"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "asset_movements_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "financial_asset_data_quality"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "asset_movements_from_employee_id_fkey"
            columns: ["from_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_movements_from_location_id_fkey"
            columns: ["from_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_movements_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_movements_to_employee_id_fkey"
            columns: ["to_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_movements_to_location_id_fkey"
            columns: ["to_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      asset_pools: {
        Row: {
          category_id: string | null
          company_id: string | null
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          is_active: boolean
          name: string
          name_ar: string | null
          updated_at: string
        }
        Insert: {
          category_id?: string | null
          company_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name: string
          name_ar?: string | null
          updated_at?: string
        }
        Update: {
          category_id?: string | null
          company_id?: string | null
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          is_active?: boolean
          name?: string
          name_ar?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "asset_pools_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "asset_pools_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      assets: {
        Row: {
          asset_tag: string | null
          assigned_to_employee_id: string | null
          category_id: string
          company_id: string | null
          condition_grade: string | null
          created_at: string
          created_by: string | null
          currency: string
          department_id: string | null
          id: string
          is_active: boolean
          last_out_at: string | null
          last_request_id: string | null
          last_return_at: string | null
          last_return_condition: string | null
          lifespan_months: number | null
          location_id: string | null
          model_id: string | null
          name: string | null
          notes: string | null
          pool_id: string | null
          purchase_cost: number | null
          purchase_date: string | null
          qr_token: string
          rfid_tag: string | null
          salvage_rate: number
          serial_exempt: boolean
          serial_exempt_reason: string | null
          serial_exempted_at: string | null
          serial_exempted_by: string | null
          serial_number: string | null
          special_attributes: Json
          status: Database["public"]["Enums"]["asset_status"]
          supplier_id: string | null
          times_checked_out: number
          unsound_return_count: number
          updated_at: string
          warranty_end: string | null
        }
        Insert: {
          asset_tag?: string | null
          assigned_to_employee_id?: string | null
          category_id: string
          company_id?: string | null
          condition_grade?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          department_id?: string | null
          id?: string
          is_active?: boolean
          last_out_at?: string | null
          last_request_id?: string | null
          last_return_at?: string | null
          last_return_condition?: string | null
          lifespan_months?: number | null
          location_id?: string | null
          model_id?: string | null
          name?: string | null
          notes?: string | null
          pool_id?: string | null
          purchase_cost?: number | null
          purchase_date?: string | null
          qr_token?: string
          rfid_tag?: string | null
          salvage_rate?: number
          serial_exempt?: boolean
          serial_exempt_reason?: string | null
          serial_exempted_at?: string | null
          serial_exempted_by?: string | null
          serial_number?: string | null
          special_attributes?: Json
          status?: Database["public"]["Enums"]["asset_status"]
          supplier_id?: string | null
          times_checked_out?: number
          unsound_return_count?: number
          updated_at?: string
          warranty_end?: string | null
        }
        Update: {
          asset_tag?: string | null
          assigned_to_employee_id?: string | null
          category_id?: string
          company_id?: string | null
          condition_grade?: string | null
          created_at?: string
          created_by?: string | null
          currency?: string
          department_id?: string | null
          id?: string
          is_active?: boolean
          last_out_at?: string | null
          last_request_id?: string | null
          last_return_at?: string | null
          last_return_condition?: string | null
          lifespan_months?: number | null
          location_id?: string | null
          model_id?: string | null
          name?: string | null
          notes?: string | null
          pool_id?: string | null
          purchase_cost?: number | null
          purchase_date?: string | null
          qr_token?: string
          rfid_tag?: string | null
          salvage_rate?: number
          serial_exempt?: boolean
          serial_exempt_reason?: string | null
          serial_exempted_at?: string | null
          serial_exempted_by?: string | null
          serial_number?: string | null
          special_attributes?: Json
          status?: Database["public"]["Enums"]["asset_status"]
          supplier_id?: string | null
          times_checked_out?: number
          unsound_return_count?: number
          updated_at?: string
          warranty_end?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assets_assigned_to_employee_id_fkey"
            columns: ["assigned_to_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_last_request_id_fkey"
            columns: ["last_request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_model_id_fkey"
            columns: ["model_id"]
            isOneToOne: false
            referencedRelation: "models"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_pool_id_fkey"
            columns: ["pool_id"]
            isOneToOne: false
            referencedRelation: "asset_pools"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_serial_exempted_by_fkey"
            columns: ["serial_exempted_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "assets_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      attachments: {
        Row: {
          classification: string | null
          content_sha256: string | null
          created_at: string
          entity_id: string
          entity_type: Database["public"]["Enums"]["attachment_entity"]
          file_name: string
          id: string
          kind: string | null
          mime_type: string | null
          scan_provider: string | null
          scan_reason: string | null
          scan_status: string
          scanned_at: string | null
          size_bytes: number | null
          storage_path: string
          uploaded_by: string | null
        }
        Insert: {
          classification?: string | null
          content_sha256?: string | null
          created_at?: string
          entity_id: string
          entity_type: Database["public"]["Enums"]["attachment_entity"]
          file_name: string
          id?: string
          kind?: string | null
          mime_type?: string | null
          scan_provider?: string | null
          scan_reason?: string | null
          scan_status?: string
          scanned_at?: string | null
          size_bytes?: number | null
          storage_path: string
          uploaded_by?: string | null
        }
        Update: {
          classification?: string | null
          content_sha256?: string | null
          created_at?: string
          entity_id?: string
          entity_type?: Database["public"]["Enums"]["attachment_entity"]
          file_name?: string
          id?: string
          kind?: string | null
          mime_type?: string | null
          scan_provider?: string | null
          scan_reason?: string | null
          scan_status?: string
          scanned_at?: string | null
          size_bytes?: number | null
          storage_path?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "attachments_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_events_v2: {
        Row: {
          actor_id: string | null
          actor_type: string
          after_state: Json | null
          attribution_status: string
          before_state: Json | null
          correlation_id: string | null
          entity_id: string | null
          entity_type: string
          event_id: string
          event_type: string
          id: number
          metadata: Json
          occurred_at: string
          outcome: string
          reason: string | null
          request_id: string | null
          source: string
          system_principal: string | null
        }
        Insert: {
          actor_id?: string | null
          actor_type: string
          after_state?: Json | null
          attribution_status?: string
          before_state?: Json | null
          correlation_id?: string | null
          entity_id?: string | null
          entity_type: string
          event_id?: string
          event_type: string
          id?: never
          metadata?: Json
          occurred_at?: string
          outcome?: string
          reason?: string | null
          request_id?: string | null
          source: string
          system_principal?: string | null
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          after_state?: Json | null
          attribution_status?: string
          before_state?: Json | null
          correlation_id?: string | null
          entity_id?: string | null
          entity_type?: string
          event_id?: string
          event_type?: string
          id?: never
          metadata?: Json
          occurred_at?: string
          outcome?: string
          reason?: string | null
          request_id?: string | null
          source?: string
          system_principal?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_events_v2_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          changed_by: string | null
          created_at: string
          id: number
          new_data: Json | null
          old_data: Json | null
          record_id: string | null
          table_name: string
        }
        Insert: {
          action: string
          changed_by?: string | null
          created_at?: string
          id?: number
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name: string
        }
        Update: {
          action?: string
          changed_by?: string | null
          created_at?: string
          id?: number
          new_data?: Json | null
          old_data?: Json | null
          record_id?: string | null
          table_name?: string
        }
        Relationships: []
      }
      auth_security_policy: {
        Row: {
          admin_mfa_required: boolean
          reauth_max_age_seconds: number
          sensitive_capabilities: string[]
          sensitive_reauth_required: boolean
          session_absolute_seconds: number
          session_idle_seconds: number
          singleton: boolean
          updated_at: string
        }
        Insert: {
          admin_mfa_required?: boolean
          reauth_max_age_seconds?: number
          sensitive_capabilities?: string[]
          sensitive_reauth_required?: boolean
          session_absolute_seconds?: number
          session_idle_seconds?: number
          singleton?: boolean
          updated_at?: string
        }
        Update: {
          admin_mfa_required?: boolean
          reauth_max_age_seconds?: number
          sensitive_capabilities?: string[]
          sensitive_reauth_required?: boolean
          session_absolute_seconds?: number
          session_idle_seconds?: number
          singleton?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      automation_delivery_events: {
        Row: {
          created_at: string
          event_at: string
          event_type: string
          health_key: string | null
          id: string
          outbox_id: string | null
          provider: string
          provider_event_id: string | null
          provider_message_id: string | null
          sanitized_payload: Json
          severity: string | null
        }
        Insert: {
          created_at?: string
          event_at?: string
          event_type: string
          health_key?: string | null
          id?: string
          outbox_id?: string | null
          provider: string
          provider_event_id?: string | null
          provider_message_id?: string | null
          sanitized_payload?: Json
          severity?: string | null
        }
        Update: {
          created_at?: string
          event_at?: string
          event_type?: string
          health_key?: string | null
          id?: string
          outbox_id?: string | null
          provider?: string
          provider_event_id?: string | null
          provider_message_id?: string | null
          sanitized_payload?: Json
          severity?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "automation_delivery_events_outbox_id_fkey"
            columns: ["outbox_id"]
            isOneToOne: false
            referencedRelation: "automation_outbox"
            referencedColumns: ["id"]
          },
        ]
      }
      automation_outbox: {
        Row: {
          attempt_count: number
          created_at: string
          error_code: string | null
          event_key: string
          event_type: string
          frozen_bcc: string[] | null
          frozen_cc: string[] | null
          frozen_from: string | null
          frozen_html: string | null
          frozen_reply_to: string | null
          frozen_subject: string | null
          frozen_text: string | null
          frozen_to: string[] | null
          id: string
          language: string
          lock_token: string | null
          locked_at: string | null
          logical_message_key: string
          max_attempts: number
          next_attempt_at: string
          payload: Json
          priority: number
          provider: string
          provider_message_id: string | null
          recipient_email: string
          recipient_ref: string | null
          recipient_type: string
          reference_id: string | null
          reference_type: string
          sanitized_error: string | null
          scheduled_for: string
          sent_at: string | null
          snapshot_frozen_at: string | null
          status: string
          template_key: string
          test_mode: boolean | null
          updated_at: string
        }
        Insert: {
          attempt_count?: number
          created_at?: string
          error_code?: string | null
          event_key: string
          event_type: string
          frozen_bcc?: string[] | null
          frozen_cc?: string[] | null
          frozen_from?: string | null
          frozen_html?: string | null
          frozen_reply_to?: string | null
          frozen_subject?: string | null
          frozen_text?: string | null
          frozen_to?: string[] | null
          id?: string
          language?: string
          lock_token?: string | null
          locked_at?: string | null
          logical_message_key: string
          max_attempts?: number
          next_attempt_at?: string
          payload?: Json
          priority?: number
          provider?: string
          provider_message_id?: string | null
          recipient_email: string
          recipient_ref?: string | null
          recipient_type: string
          reference_id?: string | null
          reference_type: string
          sanitized_error?: string | null
          scheduled_for?: string
          sent_at?: string | null
          snapshot_frozen_at?: string | null
          status?: string
          template_key: string
          test_mode?: boolean | null
          updated_at?: string
        }
        Update: {
          attempt_count?: number
          created_at?: string
          error_code?: string | null
          event_key?: string
          event_type?: string
          frozen_bcc?: string[] | null
          frozen_cc?: string[] | null
          frozen_from?: string | null
          frozen_html?: string | null
          frozen_reply_to?: string | null
          frozen_subject?: string | null
          frozen_text?: string | null
          frozen_to?: string[] | null
          id?: string
          language?: string
          lock_token?: string | null
          locked_at?: string | null
          logical_message_key?: string
          max_attempts?: number
          next_attempt_at?: string
          payload?: Json
          priority?: number
          provider?: string
          provider_message_id?: string | null
          recipient_email?: string
          recipient_ref?: string | null
          recipient_type?: string
          reference_id?: string | null
          reference_type?: string
          sanitized_error?: string | null
          scheduled_for?: string
          sent_at?: string | null
          snapshot_frozen_at?: string | null
          status?: string
          template_key?: string
          test_mode?: boolean | null
          updated_at?: string
        }
        Relationships: []
      }
      automation_runs: {
        Row: {
          claimed: number
          created_at: string
          delivery_unknown: number
          duplicates: number
          enqueued: number
          failed: number
          finished_at: string | null
          id: string
          job: string
          mode: string
          run_key: string
          sanitized_error: string | null
          scanned: number
          sent: number
          started_at: string
          status: string
          worker_version: string
        }
        Insert: {
          claimed?: number
          created_at?: string
          delivery_unknown?: number
          duplicates?: number
          enqueued?: number
          failed?: number
          finished_at?: string | null
          id?: string
          job: string
          mode: string
          run_key: string
          sanitized_error?: string | null
          scanned?: number
          sent?: number
          started_at?: string
          status?: string
          worker_version: string
        }
        Update: {
          claimed?: number
          created_at?: string
          delivery_unknown?: number
          duplicates?: number
          enqueued?: number
          failed?: number
          finished_at?: string | null
          id?: string
          job?: string
          mode?: string
          run_key?: string
          sanitized_error?: string | null
          scanned?: number
          sent?: number
          started_at?: string
          status?: string
          worker_version?: string
        }
        Relationships: []
      }
      categories: {
        Row: {
          created_at: string
          default_lifespan_months: number | null
          description: string | null
          id: string
          is_active: boolean
          kind: string
          management_type: Database["public"]["Enums"]["management_type"]
          name: string
          name_ar: string | null
          prefix: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          default_lifespan_months?: number | null
          description?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          management_type?: Database["public"]["Enums"]["management_type"]
          name: string
          name_ar?: string | null
          prefix: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          default_lifespan_months?: number | null
          description?: string | null
          id?: string
          is_active?: boolean
          kind?: string
          management_type?: Database["public"]["Enums"]["management_type"]
          name?: string
          name_ar?: string | null
          prefix?: string
          updated_at?: string
        }
        Relationships: []
      }
      companies: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          name: string
          normalized_name: string | null
          notes: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          normalized_name?: string | null
          notes?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          normalized_name?: string | null
          notes?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      consumable_transactions: {
        Row: {
          balance_after: number | null
          consumable_id: string
          created_at: string
          department_id: string | null
          id: string
          invoice_date: string | null
          invoice_number: string | null
          location_id: string | null
          performed_by: string | null
          previous_quantity: number | null
          quantity: number
          reason: string | null
          related_asset_id: string | null
          related_employee_id: string | null
          supplier_id: string | null
          total_cost: number | null
          txn_type: Database["public"]["Enums"]["consumable_txn_type"]
          unit_cost: number | null
        }
        Insert: {
          balance_after?: number | null
          consumable_id: string
          created_at?: string
          department_id?: string | null
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          location_id?: string | null
          performed_by?: string | null
          previous_quantity?: number | null
          quantity: number
          reason?: string | null
          related_asset_id?: string | null
          related_employee_id?: string | null
          supplier_id?: string | null
          total_cost?: number | null
          txn_type: Database["public"]["Enums"]["consumable_txn_type"]
          unit_cost?: number | null
        }
        Update: {
          balance_after?: number | null
          consumable_id?: string
          created_at?: string
          department_id?: string | null
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          location_id?: string | null
          performed_by?: string | null
          previous_quantity?: number | null
          quantity?: number
          reason?: string | null
          related_asset_id?: string | null
          related_employee_id?: string | null
          supplier_id?: string | null
          total_cost?: number | null
          txn_type?: Database["public"]["Enums"]["consumable_txn_type"]
          unit_cost?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "consumable_transactions_consumable_id_fkey"
            columns: ["consumable_id"]
            isOneToOne: false
            referencedRelation: "consumables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumable_transactions_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumable_transactions_related_asset_id_fkey"
            columns: ["related_asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumable_transactions_related_asset_id_fkey"
            columns: ["related_asset_id"]
            isOneToOne: false
            referencedRelation: "custody_current_anomalies"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "consumable_transactions_related_asset_id_fkey"
            columns: ["related_asset_id"]
            isOneToOne: false
            referencedRelation: "financial_asset_data_quality"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "consumable_transactions_related_employee_id_fkey"
            columns: ["related_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumable_txn_department_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumable_txn_location_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumable_txn_supplier_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      consumables: {
        Row: {
          brand: string | null
          category_id: string
          company_id: string | null
          created_at: string
          currency: string
          id: string
          is_active: boolean
          location_id: string | null
          name: string
          notes: string | null
          quantity_on_hand: number
          reorder_level: number
          rfid_tag: string | null
          sku: string | null
          supplier_id: string | null
          unit: string
          unit_cost: number | null
          updated_at: string
        }
        Insert: {
          brand?: string | null
          category_id: string
          company_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          location_id?: string | null
          name: string
          notes?: string | null
          quantity_on_hand?: number
          reorder_level?: number
          rfid_tag?: string | null
          sku?: string | null
          supplier_id?: string | null
          unit?: string
          unit_cost?: number | null
          updated_at?: string
        }
        Update: {
          brand?: string | null
          category_id?: string
          company_id?: string | null
          created_at?: string
          currency?: string
          id?: string
          is_active?: boolean
          location_id?: string | null
          name?: string
          notes?: string | null
          quantity_on_hand?: number
          reorder_level?: number
          rfid_tag?: string | null
          sku?: string | null
          supplier_id?: string | null
          unit?: string
          unit_cost?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "consumables_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumables_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumables_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "consumables_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      custody_reconciliation_cases: {
        Row: {
          anomaly_code: string
          asset_id: string
          assigned_to: string | null
          created_at: string
          detected_at: string
          evidence_ref: string | null
          id: string
          last_detected_at: string
          resolution_code: string | null
          resolution_notes: string | null
          resolved_at: string | null
          resolved_by: string | null
          snapshot: Json
          status: string
          updated_at: string
        }
        Insert: {
          anomaly_code: string
          asset_id: string
          assigned_to?: string | null
          created_at?: string
          detected_at?: string
          evidence_ref?: string | null
          id?: string
          last_detected_at?: string
          resolution_code?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          snapshot?: Json
          status?: string
          updated_at?: string
        }
        Update: {
          anomaly_code?: string
          asset_id?: string
          assigned_to?: string | null
          created_at?: string
          detected_at?: string
          evidence_ref?: string | null
          id?: string
          last_detected_at?: string
          resolution_code?: string | null
          resolution_notes?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          snapshot?: Json
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "custody_reconciliation_cases_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "custody_reconciliation_cases_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "custody_current_anomalies"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "custody_reconciliation_cases_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "financial_asset_data_quality"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "custody_reconciliation_cases_assigned_to_fkey"
            columns: ["assigned_to"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "custody_reconciliation_cases_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_allowed_categories: {
        Row: {
          category_key: string
          category_label_ar: string | null
          category_label_en: string | null
          created_at: string
          created_by: string | null
          customer_id: string
        }
        Insert: {
          category_key: string
          category_label_ar?: string | null
          category_label_en?: string | null
          created_at?: string
          created_by?: string | null
          customer_id: string
        }
        Update: {
          category_key?: string
          category_label_ar?: string | null
          category_label_en?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_allowed_categories_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_allowed_companies: {
        Row: {
          company_id: string
          created_at: string
          created_by: string | null
          customer_id: string
        }
        Insert: {
          company_id: string
          created_at?: string
          created_by?: string | null
          customer_id: string
        }
        Update: {
          company_id?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_allowed_companies_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "customer_allowed_companies_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_portal_invites: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          customer_id: string
          expires_at: string
          id: string
          is_active: boolean
          max_uses: number
          portal_role: string
          used_count: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          customer_id: string
          expires_at: string
          id?: string
          is_active?: boolean
          max_uses?: number
          portal_role?: string
          used_count?: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string
          expires_at?: string
          id?: string
          is_active?: boolean
          max_uses?: number
          portal_role?: string
          used_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "customer_portal_invites_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_portal_settings: {
        Row: {
          allow_attachments: boolean
          allow_custom_item_requests: boolean
          allow_custom_requests: boolean
          allow_maintenance_requests: boolean
          allow_purchase_requests: boolean
          allow_rental_requests: boolean
          created_at: string
          customer_id: string
          portal_enabled: boolean
          require_project_manager_approval: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allow_attachments?: boolean
          allow_custom_item_requests?: boolean
          allow_custom_requests?: boolean
          allow_maintenance_requests?: boolean
          allow_purchase_requests?: boolean
          allow_rental_requests?: boolean
          created_at?: string
          customer_id: string
          portal_enabled?: boolean
          require_project_manager_approval?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allow_attachments?: boolean
          allow_custom_item_requests?: boolean
          allow_custom_requests?: boolean
          allow_maintenance_requests?: boolean
          allow_purchase_requests?: boolean
          allow_rental_requests?: boolean
          created_at?: string
          customer_id?: string
          portal_enabled?: boolean
          require_project_manager_approval?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "customer_portal_settings_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: true
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customer_portal_users: {
        Row: {
          contact_name: string
          created_at: string
          customer_id: string
          id: string
          invited_by: string | null
          is_active: boolean
          phone: string | null
          portal_role: string
          updated_at: string
        }
        Insert: {
          contact_name: string
          created_at?: string
          customer_id: string
          id: string
          invited_by?: string | null
          is_active?: boolean
          phone?: string | null
          portal_role?: string
          updated_at?: string
        }
        Update: {
          contact_name?: string
          created_at?: string
          customer_id?: string
          id?: string
          invited_by?: string | null
          is_active?: boolean
          phone?: string | null
          portal_role?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "customer_portal_users_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
        ]
      }
      customers: {
        Row: {
          address: string | null
          approval_status: string
          city: string | null
          contact_person: string | null
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          is_active: boolean
          name: string
          notes: string | null
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          approval_status?: string
          city?: string | null
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          approval_status?: string
          city?: string | null
          contact_person?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      departments: {
        Row: {
          code: string | null
          created_at: string
          id: string
          manager_employee_id: string | null
          name: string
          name_ar: string | null
          updated_at: string
        }
        Insert: {
          code?: string | null
          created_at?: string
          id?: string
          manager_employee_id?: string | null
          name: string
          name_ar?: string | null
          updated_at?: string
        }
        Update: {
          code?: string | null
          created_at?: string
          id?: string
          manager_employee_id?: string | null
          name?: string
          name_ar?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "fk_dept_manager"
            columns: ["manager_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      depreciation_rules: {
        Row: {
          alert_before_days: number
          annual_rate: number
          asset_type: string | null
          category_id: string | null
          company_id: string | null
          created_at: string
          id: string
          is_active: boolean
          method: string
          priority: number
          salvage_rate: number
          updated_at: string
          useful_life_years: number | null
        }
        Insert: {
          alert_before_days?: number
          annual_rate?: number
          asset_type?: string | null
          category_id?: string | null
          company_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          method?: string
          priority?: number
          salvage_rate?: number
          updated_at?: string
          useful_life_years?: number | null
        }
        Update: {
          alert_before_days?: number
          annual_rate?: number
          asset_type?: string | null
          category_id?: string | null
          company_id?: string | null
          created_at?: string
          id?: string
          is_active?: boolean
          method?: string
          priority?: number
          salvage_rate?: number
          updated_at?: string
          useful_life_years?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "depreciation_rules_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "depreciation_rules_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_asset_return_requests: {
        Row: {
          asset_id: string
          assignment_id: string
          created_at: string
          employee_id: string
          id: string
          operation_id: string
          reason: string
          requested_at: string
          requested_by: string
          resolution_note: string | null
          resolved_at: string | null
          resolved_by: string | null
          status: string
          updated_at: string
        }
        Insert: {
          asset_id: string
          assignment_id: string
          created_at?: string
          employee_id: string
          id?: string
          operation_id: string
          reason: string
          requested_at?: string
          requested_by: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
        }
        Update: {
          asset_id?: string
          assignment_id?: string
          created_at?: string
          employee_id?: string
          id?: string
          operation_id?: string
          reason?: string
          requested_at?: string
          requested_by?: string
          resolution_note?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employee_asset_return_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_asset_return_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "custody_current_anomalies"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "employee_asset_return_requests_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "financial_asset_data_quality"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "employee_asset_return_requests_assignment_id_fkey"
            columns: ["assignment_id"]
            isOneToOne: false
            referencedRelation: "asset_assignments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employee_asset_return_requests_employee_id_fkey"
            columns: ["employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      employee_self_operations: {
        Row: {
          created_at: string
          operation_id: string
          operation_type: string
          result: Json
          user_id: string
        }
        Insert: {
          created_at?: string
          operation_id: string
          operation_type: string
          result: Json
          user_id: string
        }
        Update: {
          created_at?: string
          operation_id?: string
          operation_type?: string
          result?: Json
          user_id?: string
        }
        Relationships: []
      }
      employees: {
        Row: {
          created_at: string
          department_id: string | null
          email: string | null
          employee_no: string | null
          full_name: string
          full_name_ar: string | null
          id: string
          is_active: boolean
          job_title: string | null
          location_id: string | null
          phone: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          department_id?: string | null
          email?: string | null
          employee_no?: string | null
          full_name: string
          full_name_ar?: string | null
          id?: string
          is_active?: boolean
          job_title?: string | null
          location_id?: string | null
          phone?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          department_id?: string | null
          email?: string | null
          employee_no?: string | null
          full_name?: string
          full_name_ar?: string | null
          id?: string
          is_active?: boolean
          job_title?: string | null
          location_id?: string | null
          phone?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "employees_department_id_fkey"
            columns: ["department_id"]
            isOneToOne: false
            referencedRelation: "departments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "employees_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      feature_exposure_settings: {
        Row: {
          enabled: boolean
          id: string
          level: number | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          id?: string
          level?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          id?: string
          level?: number | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      inventory_settings: {
        Row: {
          default_location_id: string | null
          default_reorder_level: number
          id: string
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          default_location_id?: string | null
          default_reorder_level?: number
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          default_location_id?: string | null
          default_reorder_level?: number
          id?: string
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inventory_settings_default_location_id_fkey"
            columns: ["default_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      locations: {
        Row: {
          building: string | null
          code: string | null
          created_at: string
          floor: string | null
          id: string
          is_active: boolean
          name: string
          name_ar: string | null
          notes: string | null
          parent_id: string | null
          room: string | null
          updated_at: string
        }
        Insert: {
          building?: string | null
          code?: string | null
          created_at?: string
          floor?: string | null
          id?: string
          is_active?: boolean
          name: string
          name_ar?: string | null
          notes?: string | null
          parent_id?: string | null
          room?: string | null
          updated_at?: string
        }
        Update: {
          building?: string | null
          code?: string | null
          created_at?: string
          floor?: string | null
          id?: string
          is_active?: boolean
          name?: string
          name_ar?: string | null
          notes?: string | null
          parent_id?: string | null
          room?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "locations_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_parts: {
        Row: {
          consumable_id: string | null
          created_at: string
          created_by: string
          description: string | null
          id: string
          maintenance_id: string
          planned_quantity: number
          stock_transaction_id: string | null
          used_quantity: number
        }
        Insert: {
          consumable_id?: string | null
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          maintenance_id: string
          planned_quantity: number
          stock_transaction_id?: string | null
          used_quantity?: number
        }
        Update: {
          consumable_id?: string | null
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          maintenance_id?: string
          planned_quantity?: number
          stock_transaction_id?: string | null
          used_quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_parts_consumable_id_fkey"
            columns: ["consumable_id"]
            isOneToOne: false
            referencedRelation: "consumables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_parts_maintenance_id_fkey"
            columns: ["maintenance_id"]
            isOneToOne: false
            referencedRelation: "maintenance_records"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_parts_stock_transaction_id_fkey"
            columns: ["stock_transaction_id"]
            isOneToOne: false
            referencedRelation: "consumable_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_records: {
        Row: {
          action_taken: string | null
          asset_id: string
          cause_code: string | null
          completed_at: string | null
          completed_by: string | null
          cost: number | null
          cost_recorded: boolean
          created_at: string
          currency: string
          diagnosis: string | null
          downtime_hours: number | null
          escalated_at: string | null
          escalation_level: number
          final_summary: string | null
          functional_test_notes: string | null
          functional_test_passed: boolean | null
          handoff_notes: string | null
          handoff_state: string
          id: string
          invoice_date: string | null
          invoice_number: string | null
          labor_minutes: number
          next_due_date: string | null
          outcome: Database["public"]["Enums"]["maintenance_outcome"] | null
          priority: string | null
          problem_description: string | null
          problem_type: string | null
          receiver_name: string | null
          repair_checklist: Json
          reported_at: string
          reported_by: string | null
          reported_by_employee_id: string | null
          resolution_code: string | null
          sla_breached_at: string | null
          sla_due_at: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["maintenance_status"]
          technician_id: string | null
          type: Database["public"]["Enums"]["maintenance_type"]
          updated_at: string
          vendor_location: string | null
          vendor_map_link: string | null
          vendor_name: string | null
          vendor_phone: string | null
          vendor_supplier_id: string | null
          waiting_reason: string | null
          workflow_stage: string | null
        }
        Insert: {
          action_taken?: string | null
          asset_id: string
          cause_code?: string | null
          completed_at?: string | null
          completed_by?: string | null
          cost?: number | null
          cost_recorded?: boolean
          created_at?: string
          currency?: string
          diagnosis?: string | null
          downtime_hours?: number | null
          escalated_at?: string | null
          escalation_level?: number
          final_summary?: string | null
          functional_test_notes?: string | null
          functional_test_passed?: boolean | null
          handoff_notes?: string | null
          handoff_state?: string
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          labor_minutes?: number
          next_due_date?: string | null
          outcome?: Database["public"]["Enums"]["maintenance_outcome"] | null
          priority?: string | null
          problem_description?: string | null
          problem_type?: string | null
          receiver_name?: string | null
          repair_checklist?: Json
          reported_at?: string
          reported_by?: string | null
          reported_by_employee_id?: string | null
          resolution_code?: string | null
          sla_breached_at?: string | null
          sla_due_at?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["maintenance_status"]
          technician_id?: string | null
          type?: Database["public"]["Enums"]["maintenance_type"]
          updated_at?: string
          vendor_location?: string | null
          vendor_map_link?: string | null
          vendor_name?: string | null
          vendor_phone?: string | null
          vendor_supplier_id?: string | null
          waiting_reason?: string | null
          workflow_stage?: string | null
        }
        Update: {
          action_taken?: string | null
          asset_id?: string
          cause_code?: string | null
          completed_at?: string | null
          completed_by?: string | null
          cost?: number | null
          cost_recorded?: boolean
          created_at?: string
          currency?: string
          diagnosis?: string | null
          downtime_hours?: number | null
          escalated_at?: string | null
          escalation_level?: number
          final_summary?: string | null
          functional_test_notes?: string | null
          functional_test_passed?: boolean | null
          handoff_notes?: string | null
          handoff_state?: string
          id?: string
          invoice_date?: string | null
          invoice_number?: string | null
          labor_minutes?: number
          next_due_date?: string | null
          outcome?: Database["public"]["Enums"]["maintenance_outcome"] | null
          priority?: string | null
          problem_description?: string | null
          problem_type?: string | null
          receiver_name?: string | null
          repair_checklist?: Json
          reported_at?: string
          reported_by?: string | null
          reported_by_employee_id?: string | null
          resolution_code?: string | null
          sla_breached_at?: string | null
          sla_due_at?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["maintenance_status"]
          technician_id?: string | null
          type?: Database["public"]["Enums"]["maintenance_type"]
          updated_at?: string
          vendor_location?: string | null
          vendor_map_link?: string | null
          vendor_name?: string | null
          vendor_phone?: string | null
          vendor_supplier_id?: string | null
          waiting_reason?: string | null
          workflow_stage?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_records_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_records_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "custody_current_anomalies"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "maintenance_records_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "financial_asset_data_quality"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "maintenance_records_reported_by_employee_id_fkey"
            columns: ["reported_by_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_records_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_records_technician_id_fkey"
            columns: ["technician_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "maintenance_records_vendor_supplier_id_fkey"
            columns: ["vendor_supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      maintenance_time_entries: {
        Row: {
          created_at: string
          ended_at: string
          id: string
          maintenance_id: string
          minutes: number | null
          note: string | null
          started_at: string
          technician_id: string
        }
        Insert: {
          created_at?: string
          ended_at: string
          id?: string
          maintenance_id: string
          minutes?: number | null
          note?: string | null
          started_at: string
          technician_id: string
        }
        Update: {
          created_at?: string
          ended_at?: string
          id?: string
          maintenance_id?: string
          minutes?: number | null
          note?: string | null
          started_at?: string
          technician_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "maintenance_time_entries_maintenance_id_fkey"
            columns: ["maintenance_id"]
            isOneToOne: false
            referencedRelation: "maintenance_records"
            referencedColumns: ["id"]
          },
        ]
      }
      models: {
        Row: {
          brand: string | null
          category_id: string
          company_id: string | null
          created_at: string
          default_warranty_months: number | null
          description: string | null
          id: string
          is_active: boolean
          model_name: string
          updated_at: string
        }
        Insert: {
          brand?: string | null
          category_id: string
          company_id?: string | null
          created_at?: string
          default_warranty_months?: number | null
          description?: string | null
          id?: string
          is_active?: boolean
          model_name: string
          updated_at?: string
        }
        Update: {
          brand?: string | null
          category_id?: string
          company_id?: string | null
          created_at?: string
          default_warranty_months?: number | null
          description?: string | null
          id?: string
          is_active?: boolean
          model_name?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "models_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "models_company_id_fkey"
            columns: ["company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
        ]
      }
      notification_settings: {
        Row: {
          email_enabled: boolean
          id: string
          in_app_enabled: boolean
          low_stock_enabled: boolean
          maintenance_due_enabled: boolean
          maintenance_due_window_days: number
          out_of_stock_enabled: boolean
          overdue_grace_days: number
          overdue_requests_enabled: boolean
          pending_approval_enabled: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          email_enabled?: boolean
          id?: string
          in_app_enabled?: boolean
          low_stock_enabled?: boolean
          maintenance_due_enabled?: boolean
          maintenance_due_window_days?: number
          out_of_stock_enabled?: boolean
          overdue_grace_days?: number
          overdue_requests_enabled?: boolean
          pending_approval_enabled?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          email_enabled?: boolean
          id?: string
          in_app_enabled?: boolean
          low_stock_enabled?: boolean
          maintenance_due_enabled?: boolean
          maintenance_due_window_days?: number
          out_of_stock_enabled?: boolean
          overdue_grace_days?: number
          overdue_requests_enabled?: boolean
          pending_approval_enabled?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      permissions: {
        Row: {
          created_at: string
          description: string | null
          grp: string | null
          id: string
          key: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          grp?: string | null
          id?: string
          key: string
        }
        Update: {
          created_at?: string
          description?: string | null
          grp?: string | null
          id?: string
          key?: string
        }
        Relationships: []
      }
      procurement_document_refs: {
        Row: {
          document_status: string
          document_type: string
          external_reference: string
          id: string
          metadata: Json
          purchase_request_id: string
          purchase_request_item_id: string | null
          recorded_at: string
          recorded_by: string
          source_system: string
          stock_transaction_id: string | null
        }
        Insert: {
          document_status?: string
          document_type: string
          external_reference: string
          id?: string
          metadata?: Json
          purchase_request_id: string
          purchase_request_item_id?: string | null
          recorded_at?: string
          recorded_by: string
          source_system?: string
          stock_transaction_id?: string | null
        }
        Update: {
          document_status?: string
          document_type?: string
          external_reference?: string
          id?: string
          metadata?: Json
          purchase_request_id?: string
          purchase_request_item_id?: string | null
          recorded_at?: string
          recorded_by?: string
          source_system?: string
          stock_transaction_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "procurement_document_refs_purchase_request_id_fkey"
            columns: ["purchase_request_id"]
            isOneToOne: false
            referencedRelation: "purchase_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "procurement_document_refs_purchase_request_item_id_fkey"
            columns: ["purchase_request_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_request_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "procurement_document_refs_stock_transaction_id_fkey"
            columns: ["stock_transaction_id"]
            isOneToOne: false
            referencedRelation: "consumable_transactions"
            referencedColumns: ["id"]
          },
        ]
      }
      procurement_integration_events: {
        Row: {
          document_ref_id: string | null
          event_type: string
          id: string
          occurred_at: string
          payload: Json
          purchase_request_id: string
          purchase_request_item_id: string | null
          recorded_by: string | null
        }
        Insert: {
          document_ref_id?: string | null
          event_type: string
          id?: string
          occurred_at?: string
          payload?: Json
          purchase_request_id: string
          purchase_request_item_id?: string | null
          recorded_by?: string | null
        }
        Update: {
          document_ref_id?: string | null
          event_type?: string
          id?: string
          occurred_at?: string
          payload?: Json
          purchase_request_id?: string
          purchase_request_item_id?: string | null
          recorded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "procurement_integration_events_document_ref_id_fkey"
            columns: ["document_ref_id"]
            isOneToOne: false
            referencedRelation: "procurement_document_refs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "procurement_integration_events_purchase_request_id_fkey"
            columns: ["purchase_request_id"]
            isOneToOne: false
            referencedRelation: "purchase_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "procurement_integration_events_purchase_request_item_id_fkey"
            columns: ["purchase_request_item_id"]
            isOneToOne: false
            referencedRelation: "purchase_request_items"
            referencedColumns: ["id"]
          },
        ]
      }
      procurement_operation_results: {
        Row: {
          actor_id: string
          created_at: string
          operation_id: string
          result: Json
        }
        Insert: {
          actor_id: string
          created_at?: string
          operation_id: string
          result: Json
        }
        Update: {
          actor_id?: string
          created_at?: string
          operation_id?: string
          result?: Json
        }
        Relationships: []
      }
      purchase_request_items: {
        Row: {
          consumable_id: string | null
          created_at: string
          description: string | null
          id: string
          notes: string | null
          purchase_request_id: string
          received_quantity: number
          requested_quantity: number
          source_request_item_id: string | null
          suggested_quantity: number | null
          unit_cost: number | null
          updated_at: string
        }
        Insert: {
          consumable_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          notes?: string | null
          purchase_request_id: string
          received_quantity?: number
          requested_quantity: number
          source_request_item_id?: string | null
          suggested_quantity?: number | null
          unit_cost?: number | null
          updated_at?: string
        }
        Update: {
          consumable_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          notes?: string | null
          purchase_request_id?: string
          received_quantity?: number
          requested_quantity?: number
          source_request_item_id?: string | null
          suggested_quantity?: number | null
          unit_cost?: number | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_request_items_consumable_id_fkey"
            columns: ["consumable_id"]
            isOneToOne: false
            referencedRelation: "consumables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_request_items_purchase_request_id_fkey"
            columns: ["purchase_request_id"]
            isOneToOne: false
            referencedRelation: "purchase_requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_request_items_source_request_item_id_fkey"
            columns: ["source_request_item_id"]
            isOneToOne: false
            referencedRelation: "request_items"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_request_sequences: {
        Row: {
          last_seq: number
          year: number
        }
        Insert: {
          last_seq?: number
          year: number
        }
        Update: {
          last_seq?: number
          year?: number
        }
        Relationships: []
      }
      purchase_requests: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          id: string
          notes: string | null
          request_number: string
          requested_by: string | null
          second_approved_at: string | null
          second_approved_by: string | null
          status: string
          submitted_at: string | null
          supplier_id: string | null
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          request_number?: string
          requested_by?: string | null
          second_approved_at?: string | null
          second_approved_by?: string | null
          status?: string
          submitted_at?: string | null
          supplier_id?: string | null
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          id?: string
          notes?: string | null
          request_number?: string
          requested_by?: string | null
          second_approved_at?: string | null
          second_approved_by?: string | null
          status?: string
          submitted_at?: string | null
          supplier_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_requests_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_requests_cancelled_by_fkey"
            columns: ["cancelled_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_requests_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_requests_second_approved_by_fkey"
            columns: ["second_approved_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_requests_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      registration_invite_uses: {
        Row: {
          email: string
          id: string
          invite_id: string | null
          used_at: string
          user_id: string | null
        }
        Insert: {
          email: string
          id?: string
          invite_id?: string | null
          used_at?: string
          user_id?: string | null
        }
        Update: {
          email?: string
          id?: string
          invite_id?: string | null
          used_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "registration_invite_uses_invite_id_fkey"
            columns: ["invite_id"]
            isOneToOne: false
            referencedRelation: "registration_invites"
            referencedColumns: ["id"]
          },
        ]
      }
      registration_invites: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          default_role: string
          expires_at: string | null
          id: string
          is_active: boolean
          label: string | null
          max_uses: number | null
          used_count: number
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          default_role?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          label?: string | null
          max_uses?: number | null
          used_count?: number
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          default_role?: string
          expires_at?: string | null
          id?: string
          is_active?: boolean
          label?: string | null
          max_uses?: number | null
          used_count?: number
        }
        Relationships: []
      }
      registration_settings: {
        Row: {
          allowed_domains: string[] | null
          default_requested_role: string
          id: string
          message_ar: string | null
          message_en: string | null
          mode: string
          remaining_slots: number
          require_email_verification: boolean
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          allowed_domains?: string[] | null
          default_requested_role?: string
          id?: string
          message_ar?: string | null
          message_en?: string | null
          mode?: string
          remaining_slots?: number
          require_email_verification?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          allowed_domains?: string[] | null
          default_requested_role?: string
          id?: string
          message_ar?: string | null
          message_en?: string | null
          mode?: string
          remaining_slots?: number
          require_email_verification?: boolean
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      request_amendments: {
        Row: {
          created_at: string
          created_by: string
          id: string
          patch: Json
          reason: string
          request_id: string
          requires_reapproval: boolean
          review_reason: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          version: number
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          patch: Json
          reason: string
          request_id: string
          requires_reapproval?: boolean
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          version: number
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          patch?: Json
          reason?: string
          request_id?: string
          requires_reapproval?: boolean
          review_reason?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          version?: number
        }
        Relationships: [
          {
            foreignKeyName: "request_amendments_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
        ]
      }
      request_attachments: {
        Row: {
          classification: string
          content_sha256: string | null
          created_at: string
          file_name: string
          functional_type: string
          id: string
          mime_type: string
          request_id: string
          scan_provider: string | null
          scan_reason: string | null
          scan_status: string
          scanned_at: string | null
          size_bytes: number
          storage_path: string
          uploaded_by: string
          uploaded_by_kind: string
          visible_to_customer: boolean
        }
        Insert: {
          classification?: string
          content_sha256?: string | null
          created_at?: string
          file_name: string
          functional_type?: string
          id?: string
          mime_type: string
          request_id: string
          scan_provider?: string | null
          scan_reason?: string | null
          scan_status?: string
          scanned_at?: string | null
          size_bytes: number
          storage_path: string
          uploaded_by: string
          uploaded_by_kind: string
          visible_to_customer?: boolean
        }
        Update: {
          classification?: string
          content_sha256?: string | null
          created_at?: string
          file_name?: string
          functional_type?: string
          id?: string
          mime_type?: string
          request_id?: string
          scan_provider?: string | null
          scan_reason?: string | null
          scan_status?: string
          scanned_at?: string | null
          size_bytes?: number
          storage_path?: string
          uploaded_by?: string
          uploaded_by_kind?: string
          visible_to_customer?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "request_attachments_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
        ]
      }
      request_delivery_otp_challenges: {
        Row: {
          attempt_count: number
          code_digest: string | null
          created_at: string
          expires_at: string | null
          external_message_id: string | null
          id: string
          operation_id: string
          provider: string
          provider_status: string
          request_id: string
          requested_by: string
          verified_at: string | null
          verified_by: string | null
        }
        Insert: {
          attempt_count?: number
          code_digest?: string | null
          created_at?: string
          expires_at?: string | null
          external_message_id?: string | null
          id?: string
          operation_id: string
          provider: string
          provider_status?: string
          request_id: string
          requested_by: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Update: {
          attempt_count?: number
          code_digest?: string | null
          created_at?: string
          expires_at?: string | null
          external_message_id?: string | null
          id?: string
          operation_id?: string
          provider?: string
          provider_status?: string
          request_id?: string
          requested_by?: string
          verified_at?: string | null
          verified_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "request_delivery_otp_challenges_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_delivery_otp_challenges_requested_by_fkey"
            columns: ["requested_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_delivery_otp_challenges_verified_by_fkey"
            columns: ["verified_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      request_delivery_proofs: {
        Row: {
          acknowledged_at: string
          attachment_id: string | null
          created_at: string
          delivered_by: string
          device_snapshot: Json
          evidence_status: string
          id: string
          operation_id: string
          otp_challenge_id: string | null
          proof_method: string
          receiver_actor_id: string | null
          receiver_name: string
          request_id: string
          risk_level: string
          risk_reason: string
          signature_reference: string | null
        }
        Insert: {
          acknowledged_at?: string
          attachment_id?: string | null
          created_at?: string
          delivered_by: string
          device_snapshot?: Json
          evidence_status?: string
          id?: string
          operation_id: string
          otp_challenge_id?: string | null
          proof_method: string
          receiver_actor_id?: string | null
          receiver_name: string
          request_id: string
          risk_level: string
          risk_reason: string
          signature_reference?: string | null
        }
        Update: {
          acknowledged_at?: string
          attachment_id?: string | null
          created_at?: string
          delivered_by?: string
          device_snapshot?: Json
          evidence_status?: string
          id?: string
          operation_id?: string
          otp_challenge_id?: string | null
          proof_method?: string
          receiver_actor_id?: string | null
          receiver_name?: string
          request_id?: string
          risk_level?: string
          risk_reason?: string
          signature_reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "request_delivery_proofs_attachment_id_fkey"
            columns: ["attachment_id"]
            isOneToOne: false
            referencedRelation: "request_attachments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_delivery_proofs_delivered_by_fkey"
            columns: ["delivered_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_delivery_proofs_otp_challenge_id_fkey"
            columns: ["otp_challenge_id"]
            isOneToOne: false
            referencedRelation: "request_delivery_otp_challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_delivery_proofs_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
        ]
      }
      request_events: {
        Row: {
          actor_id: string | null
          actor_kind: string
          created_at: string
          event_type: string
          id: string
          message: string | null
          metadata: Json
          request_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_kind: string
          created_at?: string
          event_type: string
          id?: string
          message?: string | null
          metadata?: Json
          request_id: string
        }
        Update: {
          actor_id?: string | null
          actor_kind?: string
          created_at?: string
          event_type?: string
          id?: string
          message?: string | null
          metadata?: Json
          request_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "request_events_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
        ]
      }
      request_items: {
        Row: {
          accept_alternative: boolean
          approved_quantity: number | null
          asset_id: string | null
          consumable_id: string | null
          created_at: string
          delivered_quantity: number
          id: string
          item_kind: string
          needs_purchase: boolean
          notes: string | null
          preferred_company_id: string | null
          preferred_model: string | null
          quantity: number
          request_id: string
          requested_category: string | null
          requested_description: string | null
          requested_kind: string
          returned_quantity: number
          total_price: number | null
          unit_price: number | null
        }
        Insert: {
          accept_alternative?: boolean
          approved_quantity?: number | null
          asset_id?: string | null
          consumable_id?: string | null
          created_at?: string
          delivered_quantity?: number
          id?: string
          item_kind: string
          needs_purchase?: boolean
          notes?: string | null
          preferred_company_id?: string | null
          preferred_model?: string | null
          quantity?: number
          request_id: string
          requested_category?: string | null
          requested_description?: string | null
          requested_kind?: string
          returned_quantity?: number
          total_price?: number | null
          unit_price?: number | null
        }
        Update: {
          accept_alternative?: boolean
          approved_quantity?: number | null
          asset_id?: string | null
          consumable_id?: string | null
          created_at?: string
          delivered_quantity?: number
          id?: string
          item_kind?: string
          needs_purchase?: boolean
          notes?: string | null
          preferred_company_id?: string | null
          preferred_model?: string | null
          quantity?: number
          request_id?: string
          requested_category?: string | null
          requested_description?: string | null
          requested_kind?: string
          returned_quantity?: number
          total_price?: number | null
          unit_price?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "request_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "custody_current_anomalies"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "request_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "financial_asset_data_quality"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "request_items_consumable_id_fkey"
            columns: ["consumable_id"]
            isOneToOne: false
            referencedRelation: "consumables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_items_preferred_company_id_fkey"
            columns: ["preferred_company_id"]
            isOneToOne: false
            referencedRelation: "companies"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "request_items_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
        ]
      }
      request_operation_results: {
        Row: {
          actor_id: string
          created_at: string
          operation_id: string
          operation_type: string
          request_id: string | null
          result: Json
        }
        Insert: {
          actor_id: string
          created_at?: string
          operation_id: string
          operation_type: string
          request_id?: string | null
          result: Json
        }
        Update: {
          actor_id?: string
          created_at?: string
          operation_id?: string
          operation_type?: string
          request_id?: string | null
          result?: Json
        }
        Relationships: [
          {
            foreignKeyName: "request_operation_results_request_id_fkey"
            columns: ["request_id"]
            isOneToOne: false
            referencedRelation: "requests"
            referencedColumns: ["id"]
          },
        ]
      }
      request_sequences: {
        Row: {
          last_seq: number
          year: number
        }
        Insert: {
          last_seq?: number
          year: number
        }
        Update: {
          last_seq?: number
          year?: number
        }
        Relationships: []
      }
      requests: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          beneficiary_employee_id: string | null
          beneficiary_type: string
          contact_email_snapshot: string | null
          contact_phone_snapshot: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          customer_name_snapshot: string | null
          delivered_at: string | null
          delivered_by: string | null
          delivery_proof_id: string | null
          id: string
          internal_notes: string | null
          last_amendment_id: string | null
          notes: string | null
          pickup_date: string | null
          portal_approval_requested_at: string | null
          portal_approval_requested_by: string | null
          portal_approval_status: string
          portal_approved_at: string | null
          portal_approved_by: string | null
          portal_rejected_at: string | null
          portal_rejected_by: string | null
          portal_rejection_reason: string | null
          prepared_at: string | null
          prepared_by: string | null
          project_city: string | null
          project_name: string | null
          rejected_at: string | null
          rejected_by: string | null
          rejection_reason: string | null
          request_number: string
          request_source: string
          request_type: string
          responsible_employee_id: string | null
          return_date: string | null
          returned_at: string | null
          risk_level_snapshot: string | null
          risk_reason_snapshot: string | null
          scope_version: number
          second_approval_reason: string | null
          second_approved_at: string | null
          second_approved_by: string | null
          status: string
          submitted_by: string | null
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          beneficiary_employee_id?: string | null
          beneficiary_type?: string
          contact_email_snapshot?: string | null
          contact_phone_snapshot?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          customer_name_snapshot?: string | null
          delivered_at?: string | null
          delivered_by?: string | null
          delivery_proof_id?: string | null
          id?: string
          internal_notes?: string | null
          last_amendment_id?: string | null
          notes?: string | null
          pickup_date?: string | null
          portal_approval_requested_at?: string | null
          portal_approval_requested_by?: string | null
          portal_approval_status?: string
          portal_approved_at?: string | null
          portal_approved_by?: string | null
          portal_rejected_at?: string | null
          portal_rejected_by?: string | null
          portal_rejection_reason?: string | null
          prepared_at?: string | null
          prepared_by?: string | null
          project_city?: string | null
          project_name?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          request_number: string
          request_source?: string
          request_type?: string
          responsible_employee_id?: string | null
          return_date?: string | null
          returned_at?: string | null
          risk_level_snapshot?: string | null
          risk_reason_snapshot?: string | null
          scope_version?: number
          second_approval_reason?: string | null
          second_approved_at?: string | null
          second_approved_by?: string | null
          status?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          beneficiary_employee_id?: string | null
          beneficiary_type?: string
          contact_email_snapshot?: string | null
          contact_phone_snapshot?: string | null
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          customer_name_snapshot?: string | null
          delivered_at?: string | null
          delivered_by?: string | null
          delivery_proof_id?: string | null
          id?: string
          internal_notes?: string | null
          last_amendment_id?: string | null
          notes?: string | null
          pickup_date?: string | null
          portal_approval_requested_at?: string | null
          portal_approval_requested_by?: string | null
          portal_approval_status?: string
          portal_approved_at?: string | null
          portal_approved_by?: string | null
          portal_rejected_at?: string | null
          portal_rejected_by?: string | null
          portal_rejection_reason?: string | null
          prepared_at?: string | null
          prepared_by?: string | null
          project_city?: string | null
          project_name?: string | null
          rejected_at?: string | null
          rejected_by?: string | null
          rejection_reason?: string | null
          request_number?: string
          request_source?: string
          request_type?: string
          responsible_employee_id?: string | null
          return_date?: string | null
          returned_at?: string | null
          risk_level_snapshot?: string | null
          risk_reason_snapshot?: string | null
          scope_version?: number
          second_approval_reason?: string | null
          second_approved_at?: string | null
          second_approved_by?: string | null
          status?: string
          submitted_by?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "requests_beneficiary_employee_id_fkey"
            columns: ["beneficiary_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_customer_id_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_delivered_by_fkey"
            columns: ["delivered_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_delivery_proof_fk"
            columns: ["delivery_proof_id"]
            isOneToOne: false
            referencedRelation: "request_delivery_proofs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_last_amendment_id_fkey"
            columns: ["last_amendment_id"]
            isOneToOne: false
            referencedRelation: "request_amendments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_prepared_by_fkey"
            columns: ["prepared_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_responsible_employee_id_fkey"
            columns: ["responsible_employee_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "requests_second_approved_by_fkey"
            columns: ["second_approved_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          permission_id: string
          role_id: string
        }
        Insert: {
          permission_id: string
          role_id: string
        }
        Update: {
          permission_id?: string
          role_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_role_id_fkey"
            columns: ["role_id"]
            isOneToOne: false
            referencedRelation: "roles"
            referencedColumns: ["id"]
          },
        ]
      }
      roles: {
        Row: {
          created_at: string
          description: string | null
          id: string
          is_system: boolean
          key: string
          name: string
          name_ar: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          key: string
          name: string
          name_ar?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string | null
          id?: string
          is_system?: boolean
          key?: string
          name?: string
          name_ar?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      scan_logs: {
        Row: {
          asset_id: string | null
          consumable_id: string | null
          created_at: string
          error_code: string | null
          id: string
          item_kind: string | null
          location_id: string | null
          matched_by: string | null
          notes: string | null
          performed_by: string | null
          result: string
          scan_mode: string
          scanned_value: string
        }
        Insert: {
          asset_id?: string | null
          consumable_id?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          item_kind?: string | null
          location_id?: string | null
          matched_by?: string | null
          notes?: string | null
          performed_by?: string | null
          result: string
          scan_mode: string
          scanned_value: string
        }
        Update: {
          asset_id?: string | null
          consumable_id?: string | null
          created_at?: string
          error_code?: string | null
          id?: string
          item_kind?: string | null
          location_id?: string | null
          matched_by?: string | null
          notes?: string | null
          performed_by?: string | null
          result?: string
          scan_mode?: string
          scanned_value?: string
        }
        Relationships: [
          {
            foreignKeyName: "scan_logs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_logs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "custody_current_anomalies"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scan_logs_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "financial_asset_data_quality"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "scan_logs_consumable_id_fkey"
            columns: ["consumable_id"]
            isOneToOne: false
            referencedRelation: "consumables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "scan_logs_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
        ]
      }
      sod_operation_policies: {
        Row: {
          external_dependency: string | null
          operation_type: string
          required_control: string
          risk_level: string
          second_approval_required: boolean
          updated_at: string
        }
        Insert: {
          external_dependency?: string | null
          operation_type: string
          required_control: string
          risk_level: string
          second_approval_required?: boolean
          updated_at?: string
        }
        Update: {
          external_dependency?: string | null
          operation_type?: string
          required_control?: string
          risk_level?: string
          second_approval_required?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      stocktake_events: {
        Row: {
          actor_id: string | null
          actor_type: string
          after_data: Json | null
          before_data: Json | null
          created_at: string
          event_type: string
          id: number
          item_id: string | null
          operation_id: string | null
          reason: string | null
          source: string
          stocktake_id: string
        }
        Insert: {
          actor_id?: string | null
          actor_type?: string
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          event_type: string
          id?: never
          item_id?: string | null
          operation_id?: string | null
          reason?: string | null
          source?: string
          stocktake_id: string
        }
        Update: {
          actor_id?: string | null
          actor_type?: string
          after_data?: Json | null
          before_data?: Json | null
          created_at?: string
          event_type?: string
          id?: never
          item_id?: string | null
          operation_id?: string | null
          reason?: string | null
          source?: string
          stocktake_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stocktake_events_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "stocktake_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_events_stocktake_id_fkey"
            columns: ["stocktake_id"]
            isOneToOne: false
            referencedRelation: "stocktakes"
            referencedColumns: ["id"]
          },
        ]
      }
      stocktake_items: {
        Row: {
          adjustment_applied: boolean
          asset_id: string | null
          consumable_id: string | null
          count_round: number
          expected_location_id: string | null
          expected_status: Database["public"]["Enums"]["asset_status"] | null
          found: boolean | null
          id: string
          is_expected: boolean
          item_kind: string
          note: string | null
          observation_status: string | null
          observed_identifier: string | null
          observed_location_id: string | null
          recount_required: boolean
          scanned: boolean
          scanned_at: string | null
          scanned_by: string | null
          snapshot_asset_name: string | null
          snapshot_asset_tag: string | null
          snapshot_rfid_tag: string | null
          snapshot_serial_number: string | null
          stocktake_id: string
          variance_reason: string | null
        }
        Insert: {
          adjustment_applied?: boolean
          asset_id?: string | null
          consumable_id?: string | null
          count_round?: number
          expected_location_id?: string | null
          expected_status?: Database["public"]["Enums"]["asset_status"] | null
          found?: boolean | null
          id?: string
          is_expected?: boolean
          item_kind?: string
          note?: string | null
          observation_status?: string | null
          observed_identifier?: string | null
          observed_location_id?: string | null
          recount_required?: boolean
          scanned?: boolean
          scanned_at?: string | null
          scanned_by?: string | null
          snapshot_asset_name?: string | null
          snapshot_asset_tag?: string | null
          snapshot_rfid_tag?: string | null
          snapshot_serial_number?: string | null
          stocktake_id: string
          variance_reason?: string | null
        }
        Update: {
          adjustment_applied?: boolean
          asset_id?: string | null
          consumable_id?: string | null
          count_round?: number
          expected_location_id?: string | null
          expected_status?: Database["public"]["Enums"]["asset_status"] | null
          found?: boolean | null
          id?: string
          is_expected?: boolean
          item_kind?: string
          note?: string | null
          observation_status?: string | null
          observed_identifier?: string | null
          observed_location_id?: string | null
          recount_required?: boolean
          scanned?: boolean
          scanned_at?: string | null
          scanned_by?: string | null
          snapshot_asset_name?: string | null
          snapshot_asset_tag?: string | null
          snapshot_rfid_tag?: string | null
          snapshot_serial_number?: string | null
          stocktake_id?: string
          variance_reason?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stocktake_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "assets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "custody_current_anomalies"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "stocktake_items_asset_id_fkey"
            columns: ["asset_id"]
            isOneToOne: false
            referencedRelation: "financial_asset_data_quality"
            referencedColumns: ["asset_id"]
          },
          {
            foreignKeyName: "stocktake_items_consumable_id_fkey"
            columns: ["consumable_id"]
            isOneToOne: false
            referencedRelation: "consumables"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_items_expected_location_id_fkey"
            columns: ["expected_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_items_observed_location_id_fkey"
            columns: ["observed_location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_items_scanned_by_fkey"
            columns: ["scanned_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktake_items_stocktake_id_fkey"
            columns: ["stocktake_id"]
            isOneToOne: false
            referencedRelation: "stocktakes"
            referencedColumns: ["id"]
          },
        ]
      }
      stocktake_operations: {
        Row: {
          action: string
          actor_id: string | null
          created_at: string
          operation_id: string
          result: Json
          stocktake_id: string
        }
        Insert: {
          action: string
          actor_id?: string | null
          created_at?: string
          operation_id: string
          result: Json
          stocktake_id: string
        }
        Update: {
          action?: string
          actor_id?: string | null
          created_at?: string
          operation_id?: string
          result?: Json
          stocktake_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stocktake_operations_stocktake_id_fkey"
            columns: ["stocktake_id"]
            isOneToOne: false
            referencedRelation: "stocktakes"
            referencedColumns: ["id"]
          },
        ]
      }
      stocktakes: {
        Row: {
          blind_count: boolean
          code: string | null
          completed_at: string | null
          correction_of: string | null
          create_operation_id: string | null
          created_at: string
          created_by: string | null
          expected_count: number
          id: string
          location_id: string | null
          locked_at: string | null
          notes: string | null
          observed_count: number
          review_state: string
          reviewed_at: string | null
          reviewed_by: string | null
          snapshot_at: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["stocktake_status"]
          submitted_at: string | null
          title: string
          updated_at: string
          variance_count: number
        }
        Insert: {
          blind_count?: boolean
          code?: string | null
          completed_at?: string | null
          correction_of?: string | null
          create_operation_id?: string | null
          created_at?: string
          created_by?: string | null
          expected_count?: number
          id?: string
          location_id?: string | null
          locked_at?: string | null
          notes?: string | null
          observed_count?: number
          review_state?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          snapshot_at?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["stocktake_status"]
          submitted_at?: string | null
          title: string
          updated_at?: string
          variance_count?: number
        }
        Update: {
          blind_count?: boolean
          code?: string | null
          completed_at?: string | null
          correction_of?: string | null
          create_operation_id?: string | null
          created_at?: string
          created_by?: string | null
          expected_count?: number
          id?: string
          location_id?: string | null
          locked_at?: string | null
          notes?: string | null
          observed_count?: number
          review_state?: string
          reviewed_at?: string | null
          reviewed_by?: string | null
          snapshot_at?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["stocktake_status"]
          submitted_at?: string | null
          title?: string
          updated_at?: string
          variance_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "stocktakes_correction_of_fkey"
            columns: ["correction_of"]
            isOneToOne: false
            referencedRelation: "stocktakes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktakes_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktakes_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stocktakes_reviewed_by_fkey"
            columns: ["reviewed_by"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
      supplier_categories: {
        Row: {
          category_id: string
          created_at: string
          id: string
          supplier_id: string
        }
        Insert: {
          category_id: string
          created_at?: string
          id?: string
          supplier_id: string
        }
        Update: {
          category_id?: string
          created_at?: string
          id?: string
          supplier_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "supplier_categories_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "supplier_categories_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          address: string | null
          contact_person: string | null
          created_at: string
          email: string | null
          id: string
          is_active: boolean
          name: string
          name_ar: string | null
          notes: string | null
          phone: string | null
          updated_at: string
        }
        Insert: {
          address?: string | null
          contact_person?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name: string
          name_ar?: string | null
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Update: {
          address?: string | null
          contact_person?: string | null
          created_at?: string
          email?: string | null
          id?: string
          is_active?: boolean
          name?: string
          name_ar?: string | null
          notes?: string | null
          phone?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      tag_sequences: {
        Row: {
          category_id: string
          last_seq: number
          year: number
        }
        Insert: {
          category_id: string
          last_seq?: number
          year: number
        }
        Update: {
          category_id?: string
          last_seq?: number
          year?: number
        }
        Relationships: [
          {
            foreignKeyName: "tag_sequences_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "categories"
            referencedColumns: ["id"]
          },
        ]
      }
      user_permissions: {
        Row: {
          allow: boolean
          permission_id: string
          user_id: string
        }
        Insert: {
          allow?: boolean
          permission_id: string
          user_id: string
        }
        Update: {
          allow?: boolean
          permission_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_permissions_permission_id_fkey"
            columns: ["permission_id"]
            isOneToOne: false
            referencedRelation: "permissions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "user_permissions_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "app_users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      custody_current_anomalies: {
        Row: {
          active_assignment_count: number | null
          anomaly_code: string | null
          asset_id: string | null
          asset_status: string | null
          asset_tag: string | null
          holder_employee_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "assets_assigned_to_employee_id_fkey"
            columns: ["holder_employee_id"]
            isOneToOne: false
            referencedRelation: "employees"
            referencedColumns: ["id"]
          },
        ]
      }
      financial_asset_data_quality: {
        Row: {
          asset_id: string | null
          asset_name: string | null
          asset_tag: string | null
          missing_fields: string[] | null
          updated_at: string | null
        }
        Insert: {
          asset_id?: string | null
          asset_name?: string | null
          asset_tag?: string | null
          missing_fields?: never
          updated_at?: string | null
        }
        Update: {
          asset_id?: string | null
          asset_name?: string | null
          asset_tag?: string | null
          missing_fields?: never
          updated_at?: string | null
        }
        Relationships: []
      }
    }
    Functions: {
      _audit_actor_context: { Args: { p_row?: Json }; Returns: Json }
      _audit_capability_denial: {
        Args: {
          p_entity_id: string
          p_entity_type: string
          p_event_type: string
          p_reason: string
        }
        Returns: undefined
      }
      _audit_sanitize: { Args: { p_value: Json }; Returns: Json }
      _audit_write: {
        Args: {
          p_actor_row?: Json
          p_after_state: Json
          p_before_state: Json
          p_entity_id: string
          p_entity_type: string
          p_event_type: string
          p_metadata?: Json
          p_outcome: string
          p_reason: string
          p_request_id: string
          p_source: string
          p_system_principal?: string
        }
        Returns: string
      }
      _auth_current_aal: { Args: never; Returns: string }
      _auth_last_method_at: { Args: never; Returns: string }
      _crq_filter: {
        Args: { p_filters: Json }
        Returns: {
          approved_at: string | null
          approved_by: string | null
          beneficiary_employee_id: string | null
          beneficiary_type: string
          contact_email_snapshot: string | null
          contact_phone_snapshot: string | null
          created_at: string
          created_by: string | null
          customer_id: string | null
          customer_name_snapshot: string | null
          delivered_at: string | null
          delivered_by: string | null
          delivery_proof_id: string | null
          id: string
          internal_notes: string | null
          last_amendment_id: string | null
          notes: string | null
          pickup_date: string | null
          portal_approval_requested_at: string | null
          portal_approval_requested_by: string | null
          portal_approval_status: string
          portal_approved_at: string | null
          portal_approved_by: string | null
          portal_rejected_at: string | null
          portal_rejected_by: string | null
          portal_rejection_reason: string | null
          prepared_at: string | null
          prepared_by: string | null
          project_city: string | null
          project_name: string | null
          rejected_at: string | null
          rejected_by: string | null
          rejection_reason: string | null
          request_number: string
          request_source: string
          request_type: string
          responsible_employee_id: string | null
          return_date: string | null
          returned_at: string | null
          risk_level_snapshot: string | null
          risk_reason_snapshot: string | null
          scope_version: number
          second_approval_reason: string | null
          second_approved_at: string | null
          second_approved_by: string | null
          status: string
          submitted_by: string | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "requests"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      _custody_reconciliation_refresh: { Args: never; Returns: number }
      _portal_settings: {
        Args: { p_customer_id: string }
        Returns: {
          allow_attachments: boolean
          allow_custom_item_requests: boolean
          allow_custom_requests: boolean
          allow_maintenance_requests: boolean
          allow_purchase_requests: boolean
          allow_rental_requests: boolean
          created_at: string
          customer_id: string
          portal_enabled: boolean
          require_project_manager_approval: boolean
          updated_at: string
          updated_by: string | null
        }
        SetofOptions: {
          from: "*"
          to: "customer_portal_settings"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      _request_actor_kind: { Args: never; Returns: string }
      _request_add_event: {
        Args: {
          p_actor_kind: string
          p_event_type: string
          p_message?: string
          p_metadata?: Json
          p_request_id: string
        }
        Returns: undefined
      }
      _request_auto_provision: { Args: { p_id: string }; Returns: Json }
      _request_delivery_risk: { Args: { p_request_id: string }; Returns: Json }
      _registration_staff_claim: {
        Args: { p_email: string; p_invite_code: string; p_user_id: string }
        Returns: string
      }
      _request_release_reservations: {
        Args: { p_id: string; p_reason: string }
        Returns: number
      }
      _stocktake_can_manage: { Args: never; Returns: boolean }
      _stocktake_can_read: { Args: never; Returns: boolean }
      _stocktake_event: {
        Args: {
          p_after?: Json
          p_before?: Json
          p_event_type: string
          p_item_id?: string
          p_operation_id: string
          p_reason?: string
          p_stocktake_id: string
        }
        Returns: undefined
      }
      _stocktake_existing_operation: {
        Args: { p_action: string; p_operation_id: string }
        Returns: Json
      }
      _stocktake_record_operation: {
        Args: {
          p_action: string
          p_operation_id: string
          p_result: Json
          p_stocktake_id: string
        }
        Returns: Json
      }
      _stocktake_refresh_counts: {
        Args: { p_stocktake_id: string }
        Returns: undefined
      }
      action_alert_assign: {
        Args: { p_id: string; p_user: string }
        Returns: Json
      }
      action_alert_note: {
        Args: { p_id: string; p_note: string }
        Returns: Json
      }
      action_alert_operational_counts: { Args: never; Returns: Json }
      action_alert_start: { Args: { p_id: string }; Returns: Json }
      action_alerts_sync: { Args: { p_candidates: Json }; Returns: Json }
      admin_user_has_capability: {
        Args: { p_key: string; p_user: string }
        Returns: boolean
      }
      app_schema_compatibility: { Args: never; Returns: Json }
      app_user_role: { Args: never; Returns: string }
      approve_customer: {
        Args: { p_approve: boolean; p_customer_id: string }
        Returns: Json
      }
      approve_user: {
        Args: { p_role_key: string; p_user_id: string }
        Returns: Json
      }
      approve_employee_user: {
        Args: { p_employee_id: string; p_user_id: string }
        Returns: Json
      }
      scan_warehouse_exit: {
        Args: { p_asset_id: string; p_warehouse_id: string; p_destination_id: string; p_operation_id: string }
        Returns: Json
      }
      asset_assign: {
        Args: { p_asset_id: string; p_due_date?: string; p_employee_id: string }
        Returns: Json
      }
      asset_change_status: {
        Args: {
          p_asset_id: string
          p_note?: string
          p_to_status: Database["public"]["Enums"]["asset_status"]
        }
        Returns: Json
      }
      asset_create_atomic: { Args: { p_input: Json }; Returns: Json }
      asset_move_atomic: {
        Args: {
          p_asset_id: string
          p_to_department_id?: string
          p_to_location_id: string
        }
        Returns: Json
      }
      asset_return: {
        Args: { p_asset_id: string; p_condition?: string }
        Returns: Json
      }
      asset_set_serial: {
        Args: { p_asset_id: string; p_serial: string }
        Returns: Json
      }
      asset_set_serial_exempt: {
        Args: { p_asset_id: string; p_exempt: boolean; p_reason?: string }
        Returns: Json
      }
      asset_status_allowed: {
        Args: {
          p_new: Database["public"]["Enums"]["asset_status"]
          p_old: Database["public"]["Enums"]["asset_status"]
        }
        Returns: boolean
      }
      asset_update_atomic: {
        Args: { p_asset_id: string; p_input: Json }
        Returns: Json
      }
      assets_financial: {
        Args: { p_ids: string[] }
        Returns: {
          id: string
          purchase_cost: number
        }[]
      }
      attachment_object_registered: {
        Args: { p_name: string }
        Returns: boolean
      }
      audit_legacy_events: {
        Args: { p_before_id?: number; p_limit?: number }
        Returns: Json
      }
      audit_request_evidence: { Args: { p_request_id: string }; Returns: Json }
      auth_recent_reauthentication: {
        Args: { p_max_age_seconds?: number }
        Returns: boolean
      }
      auth_security_state: { Args: never; Returns: Json }
      automation_claim_outbox: {
        Args: { p_limit: number; p_lock_token: string }
        Returns: {
          attempt_count: number
          created_at: string
          error_code: string | null
          event_key: string
          event_type: string
          frozen_bcc: string[] | null
          frozen_cc: string[] | null
          frozen_from: string | null
          frozen_html: string | null
          frozen_reply_to: string | null
          frozen_subject: string | null
          frozen_text: string | null
          frozen_to: string[] | null
          id: string
          language: string
          lock_token: string | null
          locked_at: string | null
          logical_message_key: string
          max_attempts: number
          next_attempt_at: string
          payload: Json
          priority: number
          provider: string
          provider_message_id: string | null
          recipient_email: string
          recipient_ref: string | null
          recipient_type: string
          reference_id: string | null
          reference_type: string
          sanitized_error: string | null
          scheduled_for: string
          sent_at: string | null
          snapshot_frozen_at: string | null
          status: string
          template_key: string
          test_mode: boolean | null
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "automation_outbox"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      automation_complete_attempt: {
        Args: {
          p_error?: string
          p_error_code?: string
          p_lock_token: string
          p_next_attempt_at?: string
          p_outbox_id: string
          p_outcome: string
          p_provider_message_id?: string
        }
        Returns: string
      }
      automation_enqueue: {
        Args: {
          p_event_key: string
          p_event_type: string
          p_language: string
          p_logical_message_key: string
          p_payload: Json
          p_priority?: number
          p_recipient_email: string
          p_recipient_ref: string
          p_recipient_type: string
          p_reference_id: string
          p_reference_type: string
          p_scheduled_for?: string
          p_template_key: string
        }
        Returns: string
      }
      automation_finish_run: {
        Args: {
          p_claimed?: number
          p_delivery_unknown?: number
          p_duplicates?: number
          p_enqueued?: number
          p_error?: string
          p_failed?: number
          p_run_id: string
          p_scanned?: number
          p_sent?: number
          p_status: string
        }
        Returns: undefined
      }
      automation_freeze_outbox: {
        Args: {
          p_bcc: string[]
          p_cc: string[]
          p_from: string
          p_html: string
          p_lock_token: string
          p_outbox_id: string
          p_reply_to: string
          p_subject: string
          p_test_mode: boolean
          p_text: string
          p_to: string[]
        }
        Returns: {
          attempt_count: number
          created_at: string
          error_code: string | null
          event_key: string
          event_type: string
          frozen_bcc: string[] | null
          frozen_cc: string[] | null
          frozen_from: string | null
          frozen_html: string | null
          frozen_reply_to: string | null
          frozen_subject: string | null
          frozen_text: string | null
          frozen_to: string[] | null
          id: string
          language: string
          lock_token: string | null
          locked_at: string | null
          logical_message_key: string
          max_attempts: number
          next_attempt_at: string
          payload: Json
          priority: number
          provider: string
          provider_message_id: string | null
          recipient_email: string
          recipient_ref: string | null
          recipient_type: string
          reference_id: string | null
          reference_type: string
          sanitized_error: string | null
          scheduled_for: string
          sent_at: string | null
          snapshot_frozen_at: string | null
          status: string
          template_key: string
          test_mode: boolean | null
          updated_at: string
        }
        SetofOptions: {
          from: "*"
          to: "automation_outbox"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      automation_payload_has_financial_field: {
        Args: { p_value: Json }
        Returns: boolean
      }
      automation_reconcile_stuck: {
        Args: { p_locked_before: string }
        Returns: Json
      }
      automation_record_delivery_event: {
        Args: {
          p_event_at: string
          p_event_type: string
          p_payload?: Json
          p_provider: string
          p_provider_event_id: string
          p_provider_message_id: string
        }
        Returns: string
      }
      automation_record_health: {
        Args: {
          p_event_type: string
          p_health_key: string
          p_payload?: Json
          p_severity: string
        }
        Returns: string
      }
      automation_sanitize_error: { Args: { p_error: string }; Returns: string }
      automation_start_run: {
        Args: {
          p_job: string
          p_mode: string
          p_run_key: string
          p_worker_version: string
        }
        Returns: string
      }
      can_read_attachment_object: { Args: { p_name: string }; Returns: boolean }
      complete_attachment_scan: {
        Args: {
          p_bucket: string
          p_content_sha256?: string
          p_provider: string
          p_reason?: string
          p_storage_path: string
          p_verdict: string
        }
        Returns: Json
      }
      consumable_create_with_opening_stock: {
        Args: { p_input: Json }
        Returns: Json
      }
      consumable_stock_move: {
        Args: {
          p_consumable_id: string
          p_department_id?: string
          p_employee_id?: string
          p_invoice_date?: string
          p_invoice_number?: string
          p_quantity: number
          p_reason?: string
          p_supplier_id?: string
          p_type: string
          p_unit_cost?: number
        }
        Returns: number
      }
      consumable_stock_move_idempotent: {
        Args: {
          p_consumable_id: string
          p_department_id?: string
          p_employee_id?: string
          p_invoice_date?: string
          p_invoice_number?: string
          p_operation_id: string
          p_quantity: number
          p_reason?: string
          p_supplier_id?: string
          p_type: string
          p_unit_cost?: number
        }
        Returns: Json
      }
      consumable_txn_financial: {
        Args: { p_ids: string[] }
        Returns: {
          id: string
          total_cost: number
          unit_cost: number
        }[]
      }
      consumable_txn_financial_detail: {
        Args: { p_ids: string[] }
        Returns: {
          id: string
          invoice_date: string
          invoice_number: string
          total_cost: number
          unit_cost: number
        }[]
      }
      consumable_update_atomic: {
        Args: { p_consumable_id: string; p_input: Json }
        Returns: Json
      }
      consumables_financial: {
        Args: { p_ids: string[] }
        Returns: {
          id: string
          unit_cost: number
        }[]
      }
      create_customer_portal_invite: {
        Args: {
          p_customer_id: string
          p_max_uses?: number
          p_portal_role?: string
          p_valid_days?: number
        }
        Returns: Json
      }
      current_employee_id: { Args: never; Returns: string }
      current_user_has_capability: { Args: { p_key: string }; Returns: boolean }
      current_user_id: { Args: never; Returns: string }
      custody_asset_is_consistent: {
        Args: { p_asset_id: string }
        Returns: boolean
      }
      custody_reconciliation_list: { Args: never; Returns: Json }
      custody_reconciliation_refresh: { Args: never; Returns: Json }
      custody_reconciliation_update_case: {
        Args: {
          p_assigned_to?: string
          p_case_id: string
          p_evidence_ref?: string
          p_resolution_code?: string
          p_resolution_notes?: string
          p_status: string
        }
        Returns: Json
      }
      dashboard_operational_summary: { Args: never; Returns: Json }
      depreciation_financial: {
        Args: never
        Returns: {
          annual_rate: number
          id: string
          salvage_rate: number
        }[]
      }
      depreciation_rule_save_atomic: {
        Args: { p_input: Json; p_rule_id: string | null }
        Returns: Json
      }
      depreciation_rule_set_active: {
        Args: { p_is_active: boolean; p_rule_id: string }
        Returns: Json
      }
      employee_my_assets: { Args: never; Returns: Json }
      employee_my_request: { Args: { p_request_id: string }; Returns: Json }
      employee_my_requests: { Args: never; Returns: Json }
      employee_my_return_requests: { Args: never; Returns: Json }
      employee_reply_request_clarification: {
        Args: {
          p_message: string
          p_operation_id: string
          p_request_id: string
        }
        Returns: Json
      }
      employee_report_asset_issue: {
        Args: {
          p_asset_id: string
          p_description: string
          p_operation_id: string
        }
        Returns: Json
      }
      employee_request_asset_return: {
        Args: { p_asset_id: string; p_operation_id: string; p_reason: string }
        Returns: Json
      }
      financial_data_quality_list: {
        Args: { p_limit?: number; p_offset?: number }
        Returns: {
          asset_id: string
          asset_name: string
          asset_tag: string
          missing_fields: string[]
          updated_at: string
        }[]
      }
      financial_data_quality_summary: { Args: never; Returns: Json }
      get_customer_portal_settings: {
        Args: { p_customer_id: string }
        Returns: Json
      }
      get_customer_request_analytics: {
        Args: { p_filters?: Json }
        Returns: Json
      }
      get_customer_request_operational_report: {
        Args: { p_filters?: Json }
        Returns: Json
      }
      get_customer_request_timeseries: {
        Args: { p_filters?: Json }
        Returns: Json
      }
      has_capability: {
        Args: { p_key: string; p_user: string }
        Returns: boolean
      }
      import_inventory: { Args: { p_items: Json }; Returns: Json }
      is_approved: { Args: never; Returns: boolean }
      is_financial_viewer: { Args: never; Returns: boolean }
      is_portal_user: { Args: never; Returns: boolean }
      list_customer_portal_invites: {
        Args: { p_customer_id: string }
        Returns: {
          code: string
          created_at: string
          created_by: string | null
          customer_id: string
          expires_at: string
          id: string
          is_active: boolean
          max_uses: number
          portal_role: string
          used_count: number
        }[]
        SetofOptions: {
          from: "*"
          to: "customer_portal_invites"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      list_customer_portal_users: {
        Args: { p_customer_id: string }
        Returns: {
          contact_name: string
          created_at: string
          customer_id: string
          id: string
          invited_by: string | null
          is_active: boolean
          phone: string | null
          portal_role: string
          updated_at: string
        }[]
        SetofOptions: {
          from: "*"
          to: "customer_portal_users"
          isOneToOne: false
          isSetofReturn: true
        }
      }
      list_registration_requests: {
        Args: { p_status?: string }
        Returns: {
          approval_status: string
          approved_at: string
          assigned_role: string
          created_at: string
          department_id: string
          department_name: string
          email: string
          email_confirmed: boolean
          full_name: string
          id: string
          phone: string
          registration_note: string
          rejected_at: string
          rejection_reason: string
          requested_role: string
        }[]
      }
      maintenance_add_time_entry: {
        Args: {
          p_ended_at: string
          p_maintenance_id: string
          p_note: string
          p_operation_id: string
          p_started_at: string
        }
        Returns: Json
      }
      maintenance_confirm_handoff: {
        Args: { p_id: string; p_operation_id: string }
        Returns: Json
      }
      maintenance_assign_technician: {
        Args: { p_id: string; p_technician_id?: string }
        Returns: Json
      }
      maintenance_create_atomic: { Args: { p_input: Json }; Returns: Json }
      maintenance_escalate_overdue: { Args: never; Returns: number }
      maintenance_financial: {
        Args: { p_ids: string[] }
        Returns: {
          cost: number
          id: string
        }[]
      }
      maintenance_financial_detail: {
        Args: { p_ids: string[] }
        Returns: {
          cost: number
          id: string
          invoice_date: string
          invoice_number: string
        }[]
      }
      maintenance_financial_truth: {
        Args: { p_ids: string[] }
        Returns: {
          cost: number
          cost_recorded: boolean
          currency: string
          id: string
          invoice_date: string
          invoice_number: string
        }[]
      }
      maintenance_operational_summary: { Args: never; Returns: Json }
      maintenance_plan_part: {
        Args: {
          p_consumable_id: string
          p_description: string
          p_maintenance_id: string
          p_operation_id: string
          p_planned_quantity: number
        }
        Returns: Json
      }
      maintenance_update_atomic: {
        Args: { p_id: string; p_input: Json }
        Returns: Json
      }
      maintenance_update_safe: {
        Args: { p_id: string; p_input: Json; p_operation_id: string }
        Returns: Json
      }
      my_capabilities: { Args: never; Returns: string[] }
      next_asset_tag: { Args: { p_category_id: string }; Returns: string }
      next_purchase_request_number: { Args: never; Returns: string }
      next_request_number: { Args: never; Returns: string }
      portal_add_item: {
        Args: {
          p_accept_alternative: boolean
          p_category_key?: string
          p_needs_purchase: boolean
          p_preferred_company_id?: string
          p_preferred_model: string
          p_quantity: number
          p_request_id: string
          p_requested_category: string
          p_requested_description: string
          p_requested_kind: string
        }
        Returns: Json
      }
      portal_can_read_request_attachment: {
        Args: { p_name: string }
        Returns: boolean
      }
      portal_can_upload_request_attachment: {
        Args: { p_name: string }
        Returns: boolean
      }
      portal_create_request_atomic: {
        Args: { p_operation_id: string; p_input: Json }
        Returns: Json
      }
      portal_create_request: {
        Args: {
          p_contact_email: string
          p_contact_phone: string
          p_notes: string
          p_pickup_date: string
          p_project_city: string
          p_project_name: string
          p_request_type: string
          p_return_date: string
        }
        Returns: Json
      }
      portal_customer_id: { Args: never; Returns: string }
      portal_get_context: { Args: never; Returns: Json }
      portal_get_profile: {
        Args: never
        Returns: {
          city: string
          company_name: string
          contact_name: string
          phone: string
          portal_role: string
        }[]
      }
      portal_get_request: { Args: { p_request_id: string }; Returns: Json }
      portal_get_request_attachment_path: {
        Args: { p_attachment_id: string }
        Returns: Json
      }
      portal_get_request_dashboard: { Args: never; Returns: Json }
      portal_list_allowed_categories: { Args: never; Returns: Json }
      portal_list_allowed_companies: { Args: never; Returns: Json }
      portal_list_catalog: {
        Args: never
        Returns: {
          category_id: string
          category_name: string
          category_name_ar: string
          company_id: string
          company_name: string
          model_id: string
          model_name: string
        }[]
      }
      portal_list_consumables: {
        Args: never
        Returns: {
          category_id: string
          category_name: string
          category_name_ar: string
          consumable_id: string
          consumable_name: string
        }[]
      }
      portal_list_request_attachments: {
        Args: { p_request_id: string }
        Returns: Json
      }
      portal_list_requests: { Args: never; Returns: Json }
      portal_pm_approve_request: {
        Args: { p_request_id: string }
        Returns: Json
      }
      portal_pm_reject_request: {
        Args: { p_reason: string; p_request_id: string }
        Returns: Json
      }
      portal_register_request_attachment: {
        Args: {
          p_file_name: string
          p_request_id: string
          p_storage_path: string
        }
        Returns: Json
      }
      portal_remove_item: { Args: { p_item_id: string }; Returns: Json }
      portal_reply_clarification: {
        Args: { p_message: string; p_request_id: string }
        Returns: Json
      }
      portal_submit_request: { Args: { p_request_id: string }; Returns: Json }
      portal_update_profile: {
        Args: { p_city?: string; p_contact_name: string; p_phone: string }
        Returns: undefined
      }
      portal_user_role: { Args: never; Returns: string }
      procurement_record_external_document: {
        Args: {
          p_document_status: string
          p_document_type: string
          p_external_reference: string
          p_metadata: Json
          p_operation_id: string
          p_purchase_request_id: string
          p_purchase_request_item_id: string
          p_source_system: string
          p_stock_transaction_id: string
        }
        Returns: Json
      }
      public_asset_by_token: {
        Args: { p_token: string }
        Returns: {
          asset_tag: string
          category: string
          location: string
          name: string
          status: Database["public"]["Enums"]["asset_status"]
        }[]
      }
      purchase_request_item_receive: {
        Args: { p_item_id: string; p_qty: number }
        Returns: Json
      }
      purchase_request_item_receive_idempotent: {
        Args: { p_item_id: string; p_qty: number; p_operation_id: string }
        Returns: Json
      }
      purchase_request_items_financial: {
        Args: { p_pr_ids: string[] }
        Returns: {
          id: string
          unit_cost: number
        }[]
      }
      purchase_request_procurement_state: {
        Args: { p_purchase_request_id: string }
        Returns: Json
      }
      purchase_request_set_status: {
        Args: { p_id: string; p_to: string }
        Returns: Json
      }
      purchase_requests_create_from_shortages: {
        Args: { p_items: Json }
        Returns: Json
      }
      record_auth_security_event: {
        Args: { p_event_type: string; p_metadata?: Json }
        Returns: boolean
      }
      registration_invite_create_atomic: {
        Args: { p_input: Json }
        Returns: Json
      }
      registration_invite_set_active: {
        Args: { p_invite_id: string; p_is_active: boolean }
        Returns: Json
      }
      registration_invite_update_atomic: {
        Args: { p_input: Json; p_invite_id: string }
        Returns: Json
      }
      registration_settings_update_atomic: {
        Args: { p_input: Json }
        Returns: Json
      }
      registration_status: { Args: never; Returns: Json }
      reject_user: {
        Args: { p_reason?: string; p_user_id: string }
        Returns: Json
      }
      request_approve: { Args: { p_id: string }; Returns: Json }
      request_attachment_registered: {
        Args: { p_name: string }
        Returns: boolean
      }
      request_attachment_staff_can_read: {
        Args: { p_name: string }
        Returns: boolean
      }
      request_auto_provision: { Args: { p_id: string }; Returns: Json }
      request_cancel: { Args: { p_id: string }; Returns: Json }
      request_complete: { Args: { p_id: string }; Returns: Json }
      request_create_amendment: {
        Args: {
          p_operation_id: string
          p_patch: Json
          p_reason: string
          p_request_id: string
        }
        Returns: Json
      }
      request_create_employee_self: {
        Args: {
          p_items: Json
          p_notes: string
          p_pickup_date: string
          p_project_name: string
          p_return_date: string
          p_status: string
        }
        Returns: Json
      }
      request_create_idempotent: {
        Args: { p_input: Json; p_operation_id: string }
        Returns: Json
      }
      request_create_staff: {
        Args: {
          p_contact_phone: string
          p_customer_id: string
          p_customer_name: string
          p_internal_notes: string
          p_items: Json
          p_notes: string
          p_pickup_date: string
          p_project_city: string
          p_project_name: string
          p_request_type: string
          p_return_date: string
          p_status: string
        }
        Returns: Json
      }
      request_deliver: { Args: { p_id: string }; Returns: Json }
      request_deliver_with_proof: {
        Args: { p_id: string; p_operation_id: string; p_proof: Json }
        Returns: Json
      }
      request_delivery_activate_otp: {
        Args: {
          p_challenge_id: string
          p_code: string
          p_expires_at: string
          p_external_message_id: string
        }
        Returns: undefined
      }
      request_delivery_create_otp_challenge: {
        Args: {
          p_operation_id: string
          p_provider: string
          p_request_id: string
        }
        Returns: Json
      }
      request_delivery_requirements: {
        Args: { p_request_id: string }
        Returns: Json
      }
      request_delivery_verify_otp: {
        Args: { p_challenge_id: string; p_code: string }
        Returns: Json
      }
      request_execute_idempotent: {
        Args: {
          p_operation_id: string
          p_operation_type: string
          p_payload?: Json
          p_request_id: string
        }
        Returns: Json
      }
      request_filter_options: { Args: never; Returns: Json }
      request_inspect_return: {
        Args: { p_id: string; p_lines: Json }
        Returns: Json
      }
      request_item_convert_to_pr: {
        Args: { p_item_id: string; p_pr_id?: string }
        Returns: Json
      }
      request_item_fulfill: {
        Args: {
          p_asset_id?: string
          p_consumable_id?: string
          p_item_id: string
        }
        Returns: Json
      }
      request_item_unfulfill: { Args: { p_item_id: string }; Returns: Json }
      request_items_financial: {
        Args: { p_request_ids: string[] }
        Returns: {
          id: string
          request_id: string
          total_price: number
          unit_price: number
        }[]
      }
      request_mark_ready: { Args: { p_id: string }; Returns: Json }
      request_operation_result_lookup: {
        Args: { p_operation_id: string }
        Returns: Json
      }
      request_operational_counts: { Args: never; Returns: Json }
      request_ready_issue: { Args: { p_id: string }; Returns: string }
      request_reject: {
        Args: { p_id: string; p_reason?: string }
        Returns: Json
      }
      request_request_clarification: {
        Args: { p_id: string; p_message?: string }
        Returns: Json
      }
      request_return: { Args: { p_id: string }; Returns: Json }
      request_review_amendment: {
        Args: {
          p_amendment_id: string
          p_decision: string
          p_operation_id: string
          p_review_reason: string
        }
        Returns: Json
      }
      request_secondary_approve: {
        Args: { p_id: string; p_operation_id: string; p_reason: string }
        Returns: Json
      }
      request_set_responsible: {
        Args: { p_id: string; p_user_id: string }
        Returns: Json
      }
      request_shortage_fulfill_available: {
        Args: { p_id: string }
        Returns: Json
      }
      request_start_preparing: { Args: { p_id: string }; Returns: Json }
      request_status_allowed: {
        Args: { p_new: string; p_old: string }
        Returns: boolean
      }
      request_submit: { Args: { p_id: string }; Returns: Json }
      request_transition_allowed: {
        Args: { p_from: string; p_to: string }
        Returns: boolean
      }
      reset_user_pending: { Args: { p_user_id: string }; Returns: Json }
      revoke_customer_portal_invite: {
        Args: { p_invite_id: string }
        Returns: Json
      }
      set_customer_allowed_categories: {
        Args: { p_categories: Json; p_customer_id: string }
        Returns: Json
      }
      set_customer_allowed_companies: {
        Args: { p_company_ids: string[]; p_customer_id: string }
        Returns: Json
      }
      set_customer_portal_user_active: {
        Args: { p_active: boolean; p_user_id: string }
        Returns: Json
      }
      set_role_capability: {
        Args: { p_allowed: boolean; p_key: string; p_role_key: string }
        Returns: Json
      }
      set_user_capability: {
        Args: { p_key: string; p_state: string; p_user: string }
        Returns: Json
      }
      staff_register_request_attachment: {
        Args: {
          p_file_name: string
          p_request_id: string
          p_storage_path: string
          p_visible_to_customer?: boolean
        }
        Returns: Json
      }
      staff_register_request_attachment_v2: {
        Args: {
          p_classification: string
          p_file_name: string
          p_functional_type: string
          p_request_id: string
          p_storage_path: string
          p_visible_to_customer: boolean
        }
        Returns: Json
      }
      staff_set_request_attachment_visibility: {
        Args: { p_attachment_id: string; p_visible: boolean }
        Returns: Json
      }
      stocktake_apply_adjustments: {
        Args: { p_operation_id: string; p_stocktake_id: string }
        Returns: Json
      }
      stocktake_create: {
        Args: {
          p_correction_of?: string
          p_location_id: string
          p_operation_id: string
          p_scope_category_id?: string
          p_scope_kind?: string
          p_title: string
        }
        Returns: Json
      }
      stocktake_detail: { Args: { p_stocktake_id: string }; Returns: Json }
      stocktake_decide_item: {
        Args: {
          p_decision: string
          p_item_id: string
          p_note: string
          p_operation_id: string
          p_stocktake_id: string
        }
        Returns: Json
      }
      stocktake_list: { Args: never; Returns: Json }
      stocktake_recount_item: {
        Args: {
          p_item_id: string
          p_operation_id: string
          p_reason: string
          p_stocktake_id: string
        }
        Returns: Json
      }
      stocktake_review: {
        Args: {
          p_decision: string
          p_operation_id: string
          p_reason: string
          p_stocktake_id: string
        }
        Returns: Json
      }
      stocktake_scan: {
        Args: {
          p_identifier: string
          p_operation_id: string
          p_stocktake_id: string
        }
        Returns: Json
      }
      stocktake_set_variance_reason: {
        Args: {
          p_item_id: string
          p_operation_id: string
          p_reason: string
          p_stocktake_id: string
        }
        Returns: Json
      }
      stocktake_start: {
        Args: { p_operation_id: string; p_stocktake_id: string }
        Returns: Json
      }
      stocktake_submit: {
        Args: { p_operation_id: string; p_stocktake_id: string }
        Returns: Json
      }
      update_customer_portal_settings: {
        Args: {
          p_allow_attachments: boolean
          p_allow_custom: boolean
          p_allow_custom_item: boolean
          p_allow_maintenance: boolean
          p_allow_purchase: boolean
          p_allow_rental: boolean
          p_customer_id: string
          p_portal_enabled: boolean
          p_require_pm: boolean
        }
        Returns: Json
      }
      user_label: { Args: { uid: string }; Returns: string }
      user_labels: {
        Args: { p_ids: string[] }
        Returns: {
          id: string
          label: string
        }[]
      }
      validate_portal_invite: { Args: { p_code: string }; Returns: Json }
      validate_registration_invite: { Args: { p_code: string }; Returns: Json }
    }
    Enums: {
      asset_status:
        | "available"
        | "assigned"
        | "reserved"
        | "in_maintenance"
        | "lost"
        | "disposed"
        | "rented"
        | "sold"
      assignment_status: "active" | "returned"
      attachment_entity:
        | "asset"
        | "consumable"
        | "maintenance"
        | "employee"
        | "stocktake"
      consumable_txn_type: "in" | "out" | "adjust"
      maintenance_outcome: "repaired" | "replaced" | "no_fault"
      maintenance_status: "open" | "in_progress" | "completed" | "cancelled"
      maintenance_type: "preventive" | "corrective" | "inspection"
      management_type: "TRACKED" | "BULK" | "HYBRID"
      movement_type:
        | "create"
        | "assign"
        | "return"
        | "transfer"
        | "status_change"
        | "dispose"
      stocktake_status: "draft" | "in_progress" | "completed" | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      asset_status: [
        "available",
        "assigned",
        "reserved",
        "in_maintenance",
        "lost",
        "disposed",
        "rented",
        "sold",
      ],
      assignment_status: ["active", "returned"],
      attachment_entity: [
        "asset",
        "consumable",
        "maintenance",
        "employee",
        "stocktake",
      ],
      consumable_txn_type: ["in", "out", "adjust"],
      maintenance_outcome: ["repaired", "replaced", "no_fault"],
      maintenance_status: ["open", "in_progress", "completed", "cancelled"],
      maintenance_type: ["preventive", "corrective", "inspection"],
      management_type: ["TRACKED", "BULK", "HYBRID"],
      movement_type: [
        "create",
        "assign",
        "return",
        "transfer",
        "status_change",
        "dispose",
      ],
      stocktake_status: ["draft", "in_progress", "completed", "cancelled"],
    },
  },
} as const
