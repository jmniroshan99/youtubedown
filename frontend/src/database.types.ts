// Schema contract for the browser Data API. Server-only job mutations use FastAPI.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];
type Table<Row, Insert = Partial<Row>, Update = Partial<Insert>> = {
  Row: Row;
  Insert: Insert;
  Update: Update;
  Relationships: [];
};
type Profile = {
  id: string;
  display_name: string;
  created_at: string;
  updated_at: string;
};
type Preferences = {
  user_id: string;
  theme: "light" | "dark";
  language: "en" | "si";
  updated_at: string;
};
type DownloadRow = {
  id: string;
  user_id: string;
  source_url: string;
  title: string;
  platform: string;
  format_spec: Json;
  selected_format: string;
  status: string;
  progress: number | null;
  speed: number | null;
  eta: number | null;
  file_size: number | null;
  storage_path: string | null;
  error_code: string | null;
  idempotency_key: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  expires_at: string | null;
};
export type DatabaseSchema = {
  public: {
    Tables: {
      profiles: Table<
        Profile,
        {
          id: string;
          display_name?: string;
          created_at?: string;
          updated_at?: string;
        }
      >;
      user_settings: Table<
        Preferences,
        {
          user_id: string;
          theme?: "light" | "dark";
          language?: "en" | "si";
          updated_at?: string;
        }
      >;
      download_jobs: Table<DownloadRow>;
      download_job_events: Table<{
        id: number;
        job_id: string;
        user_id: string;
        stage: string;
        message: string;
        created_at: string;
      }>;
      video_providers: Table<{
        id: string;
        name: string;
        domains: string[];
        adapter_key: string;
        enabled: boolean;
        support_status: string;
        last_checked_at: string | null;
        created_at: string;
        updated_at: string;
      }>;
      user_daily_usage: Table<{
        user_id: string;
        day: string;
        job_count: number;
      }>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};
