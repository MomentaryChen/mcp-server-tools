import { z } from "zod";
import { MongoClient } from "mongodb";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "../lib/ssh-tunnel.js";
import { closeTunnel, errorResult, jsonResult, lazy, parseBooleanFlag, textResult } from "../lib/common.js";

const DEFAULT_QUERY_LIMIT = 50;
const MAX_QUERY_LIMIT = 500;

export default function create({ env }) {
  const {
    MONGO_HOST = "127.0.0.1",
    MONGO_PORT = "27017",
    MONGO_USER,
    MONGO_PASSWORD,
    MONGO_DATABASE = "test",
    MONGO_AUTH_SOURCE,
    MONGO_AUTH_MECHANISM,
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
          "Find documents. Use projection to return only the fields you need.",
          {
            collection: z.string(),
            query: z.any().optional(),
            projection: z.record(z.string(), z.any()).optional().describe("e.g. { name: 1, status: 1, _id: 0 }"),
            sort: z.record(z.string(), z.any()).optional().describe("e.g. { createdAt: -1 }"),
            limit: z.number().int().min(1).max(MAX_QUERY_LIMIT).optional().describe(`default ${DEFAULT_QUERY_LIMIT}`),
            database: z.string().optional()
          },
          async ({ collection, query, projection, sort, limit = DEFAULT_QUERY_LIMIT, database }) => {
            try {
              let cursor = (await dbFor(database)).collection(collection).find(query || {}, { projection });
              if (sort) cursor = cursor.sort(sort);
              return jsonResult(await cursor.limit(limit).toArray());
            } catch (err) {
              return errorResult(`查詢失敗: ${err.message}`);
            }
          }
        );
      }

      if (operationAccess.insert) {
        server.tool(
          "mongo_insert",
          {
            collection: z.string(),
            document: z.any()
          },
          async ({ collection, document }) => {
            try {
              const result = await (await dbFor()).collection(collection).insertOne(document);
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
          {
            collection: z.string(),
            filter: z.any(),
            update: z.any()
          },
          async ({ collection, filter, update }) => {
            try {
              const result = await (await dbFor()).collection(collection).updateMany(filter, { $set: update });
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
          {
            collection: z.string(),
            filter: z.any()
          },
          async ({ collection, filter }) => {
            try {
              const result = await (await dbFor()).collection(collection).deleteMany(filter);
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
          { database: z.string().optional() },
          async ({ database }) => {
            try {
              const collections = await (await dbFor(database)).listCollections({}, { nameOnly: true }).toArray();
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
