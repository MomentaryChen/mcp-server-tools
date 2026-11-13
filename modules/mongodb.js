import { z } from "zod";
import { BSON, MongoClient } from "mongodb";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "../lib/ssh-tunnel.js";
import { closeTunnel, errorResult, jsonResult, lazy, parseBooleanFlag, positiveInt, textResult } from "../lib/common.js";

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 500;
const MAX_BATCH_INSERT = 1000;
const DEFAULT_MAX_RESPONSE_CHARS = 100000;
const DEFAULT_TIMEOUT_MS = 60000;

const EJSON_HINT = 'Extended JSON accepted, e.g. { "$date": "2026-01-01T00:00:00Z" }, { "$oid": "..." }.';

// Tool args arrive as plain JSON, so BSON types (Date, ObjectId, Long...) can only be expressed
// as Extended JSON. Relaxed mode keeps ordinary numbers as JS numbers.
export function fromEjson(value) {
  return value === undefined || value === null
    ? value
    : restoreRegexOperators(BSON.EJSON.deserialize(protectRegexOperators(value), { relaxed: true }));
}

// EJSON reads any object with a "$regex" key as a legacy regex literal and drops every other key,
// so { $regex: "a", $options: "i", $nin: ["x"] } would lose $nin. Hide $regex / $options from the
// parser when other keys sit beside them, then put them back as one regex value
// ({ $regex: /a/i, $nin: [...] } is valid MongoDB query syntax).
// Placeholder keys must not start with "$" (EJSON would parse them) or contain NUL (BSON rejects it).
const REGEX_KEY = "__mcp_regex__";
const OPTIONS_KEY = "__mcp_options__";

const isPlainObject = (v) => v !== null && typeof v === "object" && Object.getPrototypeOf(v) === Object.prototype;

function protectRegexOperators(value) {
  if (Array.isArray(value)) return value.map(protectRegexOperators);
  if (!isPlainObject(value)) return value;
  const keys = Object.keys(value);
  const hasSiblings = "$regex" in value && keys.some((k) => k !== "$regex" && k !== "$options");
  const out = {};
  for (const key of keys) {
    if (hasSiblings && key === "$regex") out[REGEX_KEY] = value[key];
    else if (hasSiblings && key === "$options") out[OPTIONS_KEY] = value[key];
    else out[key] = protectRegexOperators(value[key]);
  }
  return out;
}

function restoreRegexOperators(value) {
  if (Array.isArray(value)) return value.map(restoreRegexOperators);
  if (!isPlainObject(value)) return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === OPTIONS_KEY) continue;
    if (key === REGEX_KEY) {
      out.$regex = typeof child === "string" ? new BSON.BSONRegExp(child, value[OPTIONS_KEY] ?? "") : child;
    } else {
      out[key] = restoreRegexOperators(child);
    }
  }
  return out;
}

// Read documents from an (async) iterable until their JSON would pass maxChars. Returns the
// documents as a plain array when everything fit; otherwise stops reading and returns
// { documents, truncated: true, returnedCount, maxChars, hint }. The caller closes the cursor.
export async function collectWithinLimit(docs, maxChars) {
  const documents = [];
  let size = 2; // "[]"
  for await (const doc of docs) {
    const docSize = JSON.stringify(doc).length + (documents.length > 0 ? 1 : 0);
    if (size + docSize > maxChars) {
      return {
        documents,
        truncated: true,
        returnedCount: documents.length,
        maxChars,
        hint: "Result exceeded the size limit: use projection to return fewer fields, or a smaller limit."
      };
    }
    documents.push(doc);
    size += docSize;
  }
  return documents;
}

// updateMany/deleteMany with {} touch every document, so an empty filter is refused.
function isEmptyFilter(filter) {
  return !filter || typeof filter !== "object" || Object.keys(filter).length === 0;
}

// An update is used as-is when it is an aggregation pipeline (array) or an operator document
// (all keys start with "$", e.g. { $set, $unset, $inc }); a plain field document is wrapped in $set.
function toUpdateSpec(update) {
  if (Array.isArray(update)) return update;
  if (!update || typeof update !== "object") throw new Error("update 必須是物件或 pipeline 陣列");
  const keys = Object.keys(update);
  if (keys.length === 0) throw new Error("update 不可為空");
  const operatorKeys = keys.filter((k) => k.startsWith("$"));
  if (operatorKeys.length === keys.length) return update;
  if (operatorKeys.length > 0) throw new Error("update 不可混用 $ 運算子與一般欄位");
  return { $set: update };
}

export default function create({ env }) {
  const {
    MONGO_HOST = "127.0.0.1",
    MONGO_PORT = "27017",
    MONGO_USER,
    MONGO_PASSWORD,
    MONGO_DATABASE = "test",
    MONGO_AUTH_SOURCE,
    MONGO_AUTH_MECHANISM,
    MONGO_MAX_RESPONSE_CHARS,
    MONGO_TIMEOUT_MS,
    MONGO_QUERY_OPERATION = "true",
    MONGO_INSERT_OPERATION = "true",
    MONGO_UPDATE_OPERATION = "true",
    MONGO_DELETE_OPERATION = "true",
    MONGO_LIST_COLLECTIONS_OPERATION = "true"
  } = env;

  const operationAccess = {
    query: parseBooleanFlag(MONGO_QUERY_OPERATION, true),
    insert: parseBooleanFlag(MONGO_INSERT_OPERATION, true),
    update: parseBooleanFlag(MONGO_UPDATE_OPERATION, true),
    delete: parseBooleanFlag(MONGO_DELETE_OPERATION, true),
    listCollections: parseBooleanFlag(MONGO_LIST_COLLECTIONS_OPERATION, true)
  };

  const maxResponseChars = positiveInt(MONGO_MAX_RESPONSE_CHARS, DEFAULT_MAX_RESPONSE_CHARS);
  // Server-side limit (maxTimeMS) for reads (find / listCollections). Writes are not limited:
  // aborting a multi-document update / delete midway would leave it partly applied.
  const maxTimeMS = positiveInt(MONGO_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);

  function buildMongoClient(host, port) {
    const options = {};
    if (MONGO_USER?.trim()) {
      options.auth = {
        username: MONGO_USER,
        password: MONGO_PASSWORD || ""
      };
      options.authSource = MONGO_AUTH_SOURCE?.trim() || MONGO_DATABASE;
    }
    if (MONGO_AUTH_MECHANISM?.trim()) {
      options.authMechanism = MONGO_AUTH_MECHANISM;
    }
    // directConnection: through an SSH tunnel the client must talk to this one host and not
    // switch to replica-set member addresses that are unreachable from here.
    return new MongoClient(`mongodb://${host}:${port}`, {
      ...options,
      directConnection: true,
      serverSelectionTimeoutMS: 15000,
      maxPoolSize: 5
    });
  }

  // Drop a client whose SSH tunnel died; the next tool call builds a new tunnel and client.
  function discard(ctx) {
    getClient.reset();
    ctx.client?.close().catch(() => {});
    closeTunnel(ctx.target);
  }

  // Client (and SSH tunnel) are created on first use and shared by all sessions.
  const getClient = lazy(async () => {
    const mongoPort = parseInt(MONGO_PORT, 10);
    if (Number.isNaN(mongoPort)) {
      throw new Error("MONGO_PORT 不是有效數字，請檢查 .env 設定");
    }

    const sshConfig = getSshConfigFromEnv(env, "MONGO");
    const ctx = { target: { host: MONGO_HOST, port: mongoPort } };

    if (useSshTunnel(sshConfig)) {
      ctx.target = await createSshForwardTunnel({
        sshConfig,
        dstAddr: MONGO_HOST,
        dstPort: mongoPort,
        onClose: () => discard(ctx)
      });
      console.error(`✅ 已建立 Mongo SSH 通道（jump hops: ${sshConfig.jumps.length} -> ${MONGO_HOST}:${mongoPort}）`);
    }

    ctx.client = buildMongoClient(ctx.target.host, ctx.target.port);
    try {
      await ctx.client.connect();
    } catch (err) {
      await ctx.client.close().catch(() => {});
      closeTunnel(ctx.target);
      throw err;
    }
    console.error(`✅ MongoDB 已就緒（database: ${MONGO_DATABASE}）`);
    return ctx;
  });

  const dbFor = async (database) => (await getClient()).client.db(database || MONGO_DATABASE);

  return {
    info: { name: "mongo_db-tools", version: "1.0.0" },
    warmup: getClient,

    async close() {
      const ctx = getClient.current();
      if (ctx) {
        await ctx.client.close().catch(() => {});
        closeTunnel(ctx.target);
      }
    },

    register(server) {
      // Tools turned off with MONGO_*_OPERATION=false are not registered at all, so they
      // cost no context and the model never tries them.
      if (operationAccess.query) {
        server.tool(
          "query_mongo",
          "Find documents. Returns an array; if the documents' JSON would exceed the size limit, returns " +
            "{ documents, truncated: true, returnedCount, hint } with the documents that fit. " +
            `Use projection to return only the fields you need. ${EJSON_HINT}`,
          {
            collection: z.string(),
            query: z.any().optional(),
            projection: z.record(z.string(), z.any()).optional().describe("e.g. { name: 1, status: 1, _id: 0 }"),
            sort: z.record(z.string(), z.any()).optional().describe("e.g. { createdAt: -1 }"),
            limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional().describe(`default ${DEFAULT_QUERY_LIMIT}`),
            database: z.string().optional()
          },
          async ({ collection, query, projection, sort, limit = DEFAULT_QUERY_LIMIT, database }) => {
            let cursor;
            try {
              cursor = (await dbFor(database))
                .collection(collection)
                .find(fromEjson(query) || {}, { projection, maxTimeMS });
              if (sort) cursor = cursor.sort(sort);
              // Iterate instead of toArray(): stop fetching once the size limit is reached.
              return jsonResult(await collectWithinLimit(cursor.limit(limit), maxResponseChars));
            } catch (err) {
              return errorResult(`查詢失敗: ${err.message}`);
            } finally {
              await cursor?.close().catch(() => {});
            }
          }
        );
      }

      if (operationAccess.insert) {
        server.tool(
          "mongo_insert",
          `Insert one document (document) or a batch of up to ${MAX_BATCH_INSERT} (documents, ordered: stops at the first error). Pass exactly one of the two. ${EJSON_HINT}`,
          {
            collection: z.string(),
            document: z.record(z.string(), z.any()).optional(),
            documents: z.array(z.record(z.string(), z.any())).min(1).max(MAX_BATCH_INSERT).optional(),
            database: z.string().optional()
          },
          async ({ collection, document, documents, database }) => {
            if ((document === undefined) === (documents === undefined)) {
              return errorResult("插入失敗: document 與 documents 必須擇一提供");
            }
            try {
              const coll = (await dbFor(database)).collection(collection);
              if (documents) {
                const result = await coll.insertMany(documents.map(fromEjson), { ordered: true });
                return jsonResult({ insertedCount: result.insertedCount, insertedIds: Object.values(result.insertedIds) });
              }
              const result = await coll.insertOne(fromEjson(document));
              return textResult(`插入成功, id: ${result.insertedId}`);
            } catch (err) {
              return errorResult(`插入失敗: ${err.message}`);
            }
          }
        );
      }

      if (operationAccess.update) {
        server.tool(
          "mongo_update",
          "updateMany. update: a plain field document is wrapped in $set; an operator document " +
            "({ $set, $unset, $inc, ... }) or an aggregation pipeline array (e.g. [{ $set: { t: { $toDate: \"$t\" } } }]) " +
            `is used as-is. ${EJSON_HINT}`,
          {
            collection: z.string(),
            filter: z.record(z.string(), z.any()),
            update: z.any(),
            database: z.string().optional()
          },
          async ({ collection, filter, update, database }) => {
            if (isEmptyFilter(filter)) {
              return errorResult("更新失敗: filter 不可為空，避免誤改整個 collection");
            }
            try {
              const spec = toUpdateSpec(fromEjson(update));
              const result = await (await dbFor(database)).collection(collection).updateMany(fromEjson(filter), spec);
              return textResult(`更新成功, matched: ${result.matchedCount}, modified: ${result.modifiedCount}`);
            } catch (err) {
              return errorResult(`更新失敗: ${err.message}`);
            }
          }
        );
      }

      if (operationAccess.delete) {
        server.tool(
          "mongo_delete",
          `deleteMany. ${EJSON_HINT}`,
          {
            collection: z.string(),
            filter: z.record(z.string(), z.any()),
            database: z.string().optional()
          },
          async ({ collection, filter, database }) => {
            if (isEmptyFilter(filter)) {
              return errorResult("刪除失敗: filter 不可為空，避免誤刪整個 collection");
            }
            try {
              const result = await (await dbFor(database)).collection(collection).deleteMany(fromEjson(filter));
              return textResult(`刪除成功, deleted: ${result.deletedCount}`);
            } catch (err) {
              return errorResult(`刪除失敗: ${err.message}`);
            }
          }
        );
      }

      if (operationAccess.listCollections) {
        server.tool(
          "list_mongo_collections",
          "List collection names in a database (default: the configured MONGO_DATABASE).",
          { database: z.string().optional() },
          async ({ database }) => {
            try {
              const collections = await (await dbFor(database)).listCollections({}, { nameOnly: true, maxTimeMS }).toArray();
              return jsonResult(collections.map((col) => col.name));
            } catch (err) {
              return errorResult(`查詢失敗: ${err.message}`);
            }
          }
        );
      }
    }
  };
}
