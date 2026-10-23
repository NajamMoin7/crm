/**
 * MongoDB connection shared by the Next.js server and CLI scripts.
 *
 * - MONGODB_URI set   → that cluster (e.g. MongoDB Atlas) — used online.
 * - MONGODB_URI unset → a local MongoDB started on demand (mongodb-memory-server),
 *   persisted to ./.data/mongo, running as a one-node replica set so multi-document
 *   transactions work exactly as on Atlas. Never used in production.
 *
 * A second process (a script while `npm run dev` runs) re-uses the local server
 * that is already listening instead of starting another one on the same files.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { MongoClient, type Db } from "mongodb";

export const DB_NAME = process.env.MONGODB_DB || "crm";
/** Override with CRM_DATA_DIR (e.g. a separate copy for tests); defaults to ./.data/mongo. */
export const DATA_DIR = process.env.CRM_DATA_DIR ? path.resolve(process.env.CRM_DATA_DIR) : path.join(process.cwd(), ".data", "mongo");
/** Local server port; give a separate CRM_DATA_DIR its own port (CRM_MONGO_PORT). */
export const LOCAL_PORT = Number(process.env.CRM_MONGO_PORT || 27318);
const REPLICA_SET = "crm-rs";

export const usingLocalMongo = () => !process.env.MONGODB_URI;

export type Connection = { client: MongoClient; db: Db; close: () => Promise<void> };

const clientOptions = { maxPoolSize: 5, serverSelectionTimeoutMS: 10_000 } as const;

export async function connectMongo(): Promise<Connection> {
  const uri = process.env.MONGODB_URI;
  if (uri) {
    const client = await MongoClient.connect(uri, clientOptions);
    return { client, db: client.db(DB_NAME), close: () => client.close() };
  }
  if (process.env.NODE_ENV === "production" && process.env.NETLIFY) {
    throw new Error("MONGODB_URI is not set. Add it under Site configuration → Environment variables.");
  }
  return connectLocal();
}

async function connectLocal(): Promise<Connection> {
  const localUri = `mongodb://127.0.0.1:${LOCAL_PORT}/?replicaSet=${REPLICA_SET}&directConnection=true`;
  // Already running (dev server or another script)? Use it.
  try {
    const client = await MongoClient.connect(localUri, { ...clientOptions, serverSelectionTimeoutMS: 1500 });
    return { client, db: client.db(DB_NAME), close: () => client.close() };
  } catch {
    /* not running yet — start it below */
  }
  const { MongoMemoryReplSet } = await import("mongodb-memory-server-core");
  mkdirSync(DATA_DIR, { recursive: true });
  const server = await MongoMemoryReplSet.create({
    replSet: { name: REPLICA_SET, count: 1, storageEngine: "wiredTiger" },
    instanceOpts: [{ dbPath: DATA_DIR, port: LOCAL_PORT }],
  });
  const client = await MongoClient.connect(localUri, clientOptions);
  return {
    client,
    db: client.db(DB_NAME),
    close: async () => {
      await client.close();
      await server.stop({ doCleanup: false });
    },
  };
}
