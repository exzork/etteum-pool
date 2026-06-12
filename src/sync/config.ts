/**
 * Sync configuration loader.
 * Reads from environment variables or settings DB.
 */
import { randomUUID } from "crypto";
import { db } from "../db/index";
import { settings } from "../db/schema";
import { eq } from "drizzle-orm";
import type { SyncConfig } from "./types";

const SYNC_NODE_ID_KEY = "sync_node_id";

async function getOrCreateNodeId(): Promise<string> {
  const [row] = await db.select().from(settings).where(eq(settings.key, SYNC_NODE_ID_KEY));
  if (row?.value) return row.value;

  const nodeId = randomUUID().slice(0, 8);
  await db.insert(settings).values({ key: SYNC_NODE_ID_KEY, value: nodeId }).onConflictDoNothing();
  return nodeId;
}

export async function loadSyncConfig(): Promise<SyncConfig> {
  const enabled = process.env.SYNC_ENABLED === "true";
  const role = (process.env.SYNC_ROLE || "worker") as "master" | "worker";
  const syncKey = process.env.SYNC_KEY || "";
  const masterUrl = process.env.SYNC_MASTER_URL || "";
  const nodeId = await getOrCreateNodeId();

  return {
    enabled,
    role,
    syncKey,
    masterUrl: role === "worker" ? masterUrl : undefined,
    nodeId,
  };
}
