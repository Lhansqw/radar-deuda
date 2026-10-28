/**
 * Tipos de las tablas de la nube (supabase/migrations), en el formato que
 * espera @supabase/supabase-js para comprobar las consultas al compilar. Si
 * cambia una migración, hay que cambiar esto con ella.
 */

type ProjectKind = 'local' | 'github';
type Rating = 'A' | 'B' | 'C' | 'D' | 'E';

// Tipos (no interfaces): supabase-js exige que cada fila sea un Record<string, unknown>.
export type CloudProjectRow = {
  id: string;
  user_id: string;
  name: string;
  kind: ProjectKind;
  location: string;
  branch: string | null;
  created_at: string;
  deleted_at: string | null;
};

export type CloudAnalysisRow = {
  id: string;
  user_id: string;
  project_id: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  score: number;
  rating: Rating;
  debt_ratio: number;
  effort_minutes: number;
  findings: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  head: string | null;
  branch: string | null;
  report_gz: string;
  created_at: string;
};

export type Database = {
  public: {
    Tables: {
      projects: {
        Row: CloudProjectRow;
        // user_id lo pone la base de datos (auth.uid()); id y fechas tienen valor por defecto.
        Insert: Omit<CloudProjectRow, 'id' | 'user_id' | 'created_at' | 'deleted_at'> & { id?: string; user_id?: string; created_at?: string; deleted_at?: string | null };
        // Solo estas columnas tienen permiso de cambio (migración).
        Update: Partial<Pick<CloudProjectRow, 'name' | 'branch' | 'deleted_at'>>;
        Relationships: [];
      };
      analyses: {
        Row: CloudAnalysisRow;
        Insert: Omit<CloudAnalysisRow, 'user_id' | 'created_at'> & { user_id?: string; created_at?: string };
        Update: Partial<Pick<CloudAnalysisRow, 'report_gz'>>;
        Relationships: [{ foreignKeyName: 'analyses_project_id_fkey'; columns: ['project_id']; isOneToOne: false; referencedRelation: 'projects'; referencedColumns: ['id'] }];
      };
    };
    Views: { [_ in never]: never };
    Functions: { [_ in never]: never };
    Enums: { [_ in never]: never };
    CompositeTypes: { [_ in never]: never };
  };
};
