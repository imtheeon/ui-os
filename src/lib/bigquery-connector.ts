// Infrastructure only — do not import from agent-brain.ts or agent-actions.ts
/**
 * src/lib/bigquery-connector.ts
 *
 * Wraps @google-cloud/bigquery for org-scoped, credential-encrypted access to
 * customer BigQuery projects. Service account keys are stored encrypted
 * (AES-256-GCM) in bigquery_connections.service_account_key_encrypted and
 * decrypted only in-process using BIGQUERY_ENCRYPTION_KEY. This module is
 * imported exclusively by executor.ts — never by agent-brain.ts or
 * agent-actions.ts, which must never see raw or decrypted credentials.
 */
import { randomBytes, createCipheriv, createDecipheriv } from "crypto";
import { BigQuery } from "@google-cloud/bigquery";
import type { SupabaseClient } from "@supabase/supabase-js";

const ALGO = "aes-256-gcm";
const IV_LENGTH = 16;
const MAX_QUERY_ROWS = 10000;
const MAX_SCHEMA_SAMPLE_ROWS = 20;

export interface BigQueryConnectionRow {
  id: string;
  org_id: string;
  connection_name: string;
  gcp_project_id: string;
  service_account_key_encrypted: string;
  default_dataset_id: string;
  is_active: boolean;
  last_tested_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface BigQueryColumn {
  name: string;
  type: string;
  mode: string;
}

export interface BigQueryDataset {
  datasetId: string;
  location: string;
}

export interface BigQueryTable {
  tableId: string;
  datasetId: string;
  numRows: string;
  sizeBytes: string;
}

export interface BigQueryQueryResult {
  rows: Record<string, unknown>[];
  schema: BigQueryColumn[];
  rowCount: number;
  executionTimeMs: number;
  jobId: string;
}

export interface BigQuerySchemaResult {
  datasetId: string;
  tableId: string;
  columns: BigQueryColumn[];
  rowCount: number;
  sampleRows: Record<string, unknown>[];
}

function getEncryptionKey(): Buffer {
  const hex = process.env.BIGQUERY_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "[bigquery-connector] Missing required environment variable: BIGQUERY_ENCRYPTION_KEY"
    );
  }
  return Buffer.from(hex, "hex");
}

export class BigQueryConnector {
  constructor(private readonly supabaseClient: SupabaseClient) {}

  async getConnection(orgId: string, connectionId: string): Promise<BigQueryConnectionRow> {
    const { data, error } = await this.supabaseClient
      .from("bigquery_connections")
      .select("*")
      .eq("id", connectionId)
      .eq("org_id", orgId)
      .eq("is_active", true)
      .maybeSingle();
    if (error) {
      throw new Error(`[bigquery-connector] Failed to load connection: ${error.message}`);
    }
    if (!data) {
      throw new Error(
        `[bigquery-connector] No active BigQuery connection found for org=${orgId} connection=${connectionId}`
      );
    }
    return data as BigQueryConnectionRow;
  }

  private decryptServiceAccountKey(encrypted: string): Record<string, unknown> {
    const key = getEncryptionKey();
    const combined = Buffer.from(encrypted, "base64");
    const iv = combined.subarray(0, IV_LENGTH);
    const authTag = combined.subarray(combined.length - 16);
    const ciphertext = combined.subarray(IV_LENGTH, combined.length - 16);
    const decipher = createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return JSON.parse(plaintext.toString("utf8")) as Record<string, unknown>;
  }

  static encryptServiceAccountKey(plaintext: string): string {
    const key = getEncryptionKey();
    const iv = randomBytes(IV_LENGTH);
    const cipher = createCipheriv(ALGO, key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return Buffer.concat([iv, ciphertext, authTag]).toString("base64");
  }

  private async getClient(orgId: string, connectionId: string): Promise<{ client: BigQuery; connection: BigQueryConnectionRow }> {
    const connection = await this.getConnection(orgId, connectionId);
    const credentials = this.decryptServiceAccountKey(connection.service_account_key_encrypted);
    const client = new BigQuery({
      projectId: connection.gcp_project_id,
      credentials: credentials as Record<string, string>,
    });
    return { client, connection };
  }

  async listDatasets(orgId: string, connectionId: string): Promise<BigQueryDataset[]> {
    const { client } = await this.getClient(orgId, connectionId);
    const [datasets] = await client.getDatasets();
    return datasets.map((d) => ({
      datasetId: d.id ?? "",
      location: (d.metadata?.location as string) ?? "",
    }));
  }

  async listTables(orgId: string, connectionId: string, datasetId: string): Promise<BigQueryTable[]> {
    const { client } = await this.getClient(orgId, connectionId);
    const [tables] = await client.dataset(datasetId).getTables();
    const results: BigQueryTable[] = [];
    for (const t of tables) {
      const [metadata] = await t.getMetadata();
      results.push({
        tableId: t.id ?? "",
        datasetId,
        numRows: metadata?.numRows ?? "0",
        sizeBytes: metadata?.numBytes ?? "0",
      });
    }
    return results;
  }

  async getTableSchema(
    orgId: string,
    connectionId: string,
    datasetId: string,
    tableId: string
  ): Promise<BigQuerySchemaResult> {
    const { client } = await this.getClient(orgId, connectionId);
    const table = client.dataset(datasetId).table(tableId);
    const [metadata] = await table.getMetadata();
    const fields = (metadata?.schema?.fields ?? []) as Array<{ name: string; type: string; mode?: string }>;
    const columns: BigQueryColumn[] = fields.map((f) => ({
      name: f.name,
      type: f.type,
      mode: f.mode ?? "NULLABLE",
    }));
    const [rows] = await table.getRows({ maxResults: MAX_SCHEMA_SAMPLE_ROWS });
    return {
      datasetId,
      tableId,
      columns,
      rowCount: Number(metadata?.numRows ?? 0),
      sampleRows: (rows as Record<string, unknown>[]).slice(0, MAX_SCHEMA_SAMPLE_ROWS),
    };
  }

  async executeQuery(
    orgId: string,
    connectionId: string,
    sql: string,
    maxRows?: number
  ): Promise<BigQueryQueryResult> {
    const cappedMaxRows = Math.min(maxRows ?? MAX_QUERY_ROWS, MAX_QUERY_ROWS);
    const { client } = await this.getClient(orgId, connectionId);
    const startedAt = Date.now();
    try {
      const [job] = await client.createQueryJob({ query: sql, maxResults: cappedMaxRows });
      const [rows] = await job.getQueryResults({ maxResults: cappedMaxRows });
      const [metadata] = await job.getMetadata();
      const fields = (metadata?.schema?.fields ?? []) as Array<{ name: string; type: string; mode?: string }>;
      const schema: BigQueryColumn[] = fields.map((f) => ({
        name: f.name,
        type: f.type,
        mode: f.mode ?? "NULLABLE",
      }));
      return {
        rows: (rows as Record<string, unknown>[]).slice(0, cappedMaxRows),
        schema,
        rowCount: rows.length,
        executionTimeMs: Date.now() - startedAt,
        jobId: job.id ?? "",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[bigquery-connector] Query execution failed: ${message}`);
    }
  }

  async testConnection(orgId: string, connectionId: string): Promise<boolean> {
    try {
      await this.executeQuery(orgId, connectionId, "SELECT 1", 1);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[bigquery-connector] Connection test failed: ${message}`);
    }
  }
}

export function createBigQueryConnector(supabaseClient: SupabaseClient): BigQueryConnector {
  return new BigQueryConnector(supabaseClient);
}
