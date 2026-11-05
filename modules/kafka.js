import net from "net";
import { Kafka, logLevel } from "kafkajs";
import { z } from "zod";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "../lib/ssh-tunnel.js";
import { RingBuffer, closeTunnel, jsonResult, lazy, parseBooleanFlag } from "../lib/common.js";

const maxMessages = 10000;

function normalizeBroker(broker) {
  const trimmed = broker.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.includes(":") ? trimmed : `${trimmed}:9092`;
}

function parseBrokersFromEnv(env) {
  const { KAFKA_BROKERS, KAFKA_HOST, KAFKA_PORT = "9092" } = env;

  if (KAFKA_BROKERS?.trim()) {
    return KAFKA_BROKERS.split(",").map(normalizeBroker).filter(Boolean);
  }

  if (KAFKA_HOST?.trim()) {
    const port = parseInt(KAFKA_PORT, 10);
    if (Number.isNaN(port)) {
      throw new Error("KAFKA_PORT 不是有效數字");
    }
    return [`${KAFKA_HOST.trim()}:${port}`];
  }

  return [];
}

function parseArgs(args) {
  const config = {
    brokers: [],
    topics: [],
    groupId: `mcp-kafka-${Math.random().toString(16).slice(2, 8)}`,
    clientId: `mcp-kafka-client-${Math.random().toString(16).slice(2, 8)}`,
    fromBeginning: false,
    username: null,
    password: null,
    useSsl: false
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--brokers":
        config.brokers = args[++i].split(",").map(normalizeBroker).filter(Boolean);
        break;
      case "--topics":
        config.topics.push(...args[++i].split(",").map((t) => t.trim()).filter(Boolean));
        break;
      case "--group-id":
        config.groupId = args[++i];
        break;
      case "--client-id":
        config.clientId = args[++i];
        break;
      case "--from-beginning":
        config.fromBeginning = true;
        break;
      case "--username":
        config.username = args[++i];
        break;
      case "--password":
        config.password = args[++i];
        break;
      case "--ssl":
        config.useSsl = true;
        break;
    }
  }

  return config;
}

function applyEnvConfig(config, env) {
  if (config.brokers.length === 0) {
    config.brokers = parseBrokersFromEnv(env);
  }
  if (env.KAFKA_TOPICS?.trim()) {
    config.topics.push(...env.KAFKA_TOPICS.split(",").map((topic) => topic.trim()).filter(Boolean));
  }
  if (env.KAFKA_GROUP_ID?.trim()) {
    config.groupId = env.KAFKA_GROUP_ID.trim();
  }
  if (env.KAFKA_CLIENT_ID?.trim()) {
    config.clientId = env.KAFKA_CLIENT_ID.trim();
  }
  if (env.KAFKA_FROM_BEGINNING != null) {
    config.fromBeginning = parseBooleanFlag(env.KAFKA_FROM_BEGINNING, config.fromBeginning);
  }
  if (env.KAFKA_USERNAME?.trim()) {
    config.username = env.KAFKA_USERNAME.trim();
  }
  if (env.KAFKA_PASSWORD != null) {
    config.password = env.KAFKA_PASSWORD;
  }
  if (env.KAFKA_SSL != null) {
    config.useSsl = parseBooleanFlag(env.KAFKA_SSL, config.useSsl);
  }
  return config;
}

function parseBrokerEndpoint(broker) {
  const match = broker.match(/^(.*):(\d+)$/);
  if (!match) {
    throw new Error(`無效的 broker 位址: ${broker}`);
  }
  return { host: match[1], port: parseInt(match[2], 10) };
}

function brokerEndpointKey(host, port) {
  return `${host}:${port}`;
}

function buildK8sBrokerAliases(env, brokers, localBrokers) {
  const dnsSuffix = env.KAFKA_BROKER_DNS_SUFFIX?.trim();
  if (!dnsSuffix) {
    return new Map();
  }

  const namePrefix = env.KAFKA_BROKER_NAME_PREFIX?.trim() || "kafka";
  const aliases = new Map();

  for (let i = 0; i < brokers.length; i += 1) {
    const { port } = parseBrokerEndpoint(brokers[i]);
    const local = parseBrokerEndpoint(localBrokers[i]);
    aliases.set(brokerEndpointKey(`${namePrefix}-${i}.${dnsSuffix}`, port), local);
  }

  return aliases;
}

function createBrokerSocketFactory(brokerAddressMap) {
  return ({ host, port, onConnect }) => {
    const mapped = brokerAddressMap.get(brokerEndpointKey(host, port));
    const connectHost = mapped?.host ?? host;
    const connectPort = mapped?.port ?? port;

    if (mapped && (connectHost !== host || connectPort !== port)) {
      console.error(
        `[kafka] broker 位址重導: ${brokerEndpointKey(host, port)} -> ${brokerEndpointKey(connectHost, connectPort)}`
      );
    }

    return net.connect({ host: connectHost, port: connectPort }, onConnect);
  };
}

async function resolveBrokers(env, brokers, onTunnelClose) {
  const sshConfig = getSshConfigFromEnv(env, "KAFKA");

  if (!useSshTunnel(sshConfig)) {
    return { brokers, sshTunnel: false, remoteBrokers: brokers, brokerAddressMap: new Map(), tunnels: [] };
  }

  const localBrokers = [];
  const brokerAddressMap = new Map();
  const tunnels = [];

  for (const broker of brokers) {
    const { host, port } = parseBrokerEndpoint(broker);
    const tunnelTarget = await createSshForwardTunnel({ sshConfig, dstAddr: host, dstPort: port, onClose: onTunnelClose });
    tunnels.push(tunnelTarget);
    const localBroker = `${tunnelTarget.host}:${tunnelTarget.port}`;
    const localEndpoint = parseBrokerEndpoint(localBroker);

    localBrokers.push(localBroker);
    brokerAddressMap.set(broker, localEndpoint);
    brokerAddressMap.set(brokerEndpointKey(host, port), localEndpoint);

    console.error(`✅ Kafka SSH 通道已建立（jump hops: ${sshConfig.jumps.length} -> ${host}:${port} -> ${localBroker}）`);
  }

  for (const [alias, localEndpoint] of buildK8sBrokerAliases(env, brokers, localBrokers)) {
    brokerAddressMap.set(alias, localEndpoint);
  }

  return { brokers: localBrokers, sshTunnel: true, remoteBrokers: brokers, brokerAddressMap, tunnels };
}

// Note: in the gateway one Kafka client, consumer group and message buffer
// are shared by every session connected to this instance.
export default function create({ env, argv = [] }) {
  const config = applyEnvConfig(parseArgs(argv), env);

  const state = {
    producerConnected: false,
    consumerConnected: false,
    consumerRunning: false
  };
  const messageStore = new RingBuffer(maxMessages);

  const getCtx = lazy(async () => {
    if (config.brokers.length === 0) {
      throw new Error("必須提供 --brokers，或於 .env 設定 KAFKA_BROKERS / KAFKA_HOST");
    }

    // An SSH session dying makes the client unusable: tear everything down and let the next
    // tool call reconnect (fresh tunnels, re-subscribe, restart the consumer). A single broker
    // refusing the forwarded connection is not: kafkajs keeps using the other brokers.
    let ctx;
    let dropped = false;
    const onTunnelClose = ({ channelFailure }) => {
      if (dropped || channelFailure) return;
      dropped = true;
      getCtx.reset();
      if (ctx) disconnect(ctx);
    };
    const resolution = await resolveBrokers(env, config.brokers, onTunnelClose);
    config.remoteBrokers = resolution.remoteBrokers;

    const kafka = new Kafka({
      clientId: config.clientId,
      brokers: resolution.brokers,
      ssl: config.useSsl || undefined,
      sasl: config.username
        ? { mechanism: "plain", username: config.username, password: config.password ?? "" }
        : undefined,
      connectionTimeout: resolution.sshTunnel ? 30000 : 1000,
      requestTimeout: resolution.sshTunnel ? 60000 : 30000,
      socketFactory:
        resolution.brokerAddressMap.size > 0 ? createBrokerSocketFactory(resolution.brokerAddressMap) : undefined,
      logLevel: logLevel.ERROR
    });

    ctx = {
      producer: kafka.producer(),
      consumer: kafka.consumer({ groupId: config.groupId }),
      resolution
    };

    try {
      await ensureConnections(ctx);
      if (config.topics.length > 0) {
        for (const topic of config.topics) {
          await ctx.consumer.subscribe({ topic, fromBeginning: config.fromBeginning });
          console.error(`✅ 預設訂閱 topic=${topic} fromBeginning=${config.fromBeginning}`);
        }
        await startConsumerLoop(ctx);
      } else {
        console.error("ℹ️ 未指定預設 topic，可透過 kafka_subscribe 動態訂閱");
      }
    } catch (err) {
      await disconnect(ctx);
      throw err;
    }

    return ctx;
  });

  async function ensureConnections(ctx) {
    if (!state.producerConnected) {
      await ctx.producer.connect();
      state.producerConnected = true;
      console.error("✅ Kafka Producer 已連線");
    }
    if (!state.consumerConnected) {
      await ctx.consumer.connect();
      state.consumerConnected = true;
      console.error("✅ Kafka Consumer 已連線");
    }
  }

  async function disconnect(ctx) {
    await ctx.consumer.disconnect().catch(() => {});
    await ctx.producer.disconnect().catch(() => {});
    state.producerConnected = false;
    state.consumerConnected = false;
    state.consumerRunning = false;
    for (const tunnel of ctx.resolution.tunnels) {
      closeTunnel(tunnel);
    }
  }

  async function stopConsumerLoop(ctx) {
    if (!state.consumerRunning) return;
    try {
      await ctx.consumer.stop();
      state.consumerRunning = false;
      console.error("⏹️ Kafka Consumer 已停止");
    } catch (err) {
      console.error(`❌ 停止 Consumer 失敗: ${err.message}`);
    }
  }

  async function startConsumerLoop(ctx) {
    if (state.consumerRunning) return;
    state.consumerRunning = true;

    await ctx.consumer.run({
      eachMessage: async ({ topic, partition, message }) => {
        const record = {
          topic,
          partition,
          offset: message.offset,
          timestamp: new Date(Number(message.timestamp)).toISOString(),
          key: message.key?.toString() ?? null,
          value: message.value?.toString() ?? "",
          headers: message.headers
            ? Object.fromEntries(Object.entries(message.headers).map(([k, v]) => [k, v?.toString() ?? ""]))
            : {}
        };

        messageStore.push(record);
      }
    });

    console.error("▶️ Kafka Consumer 開始拉取消息");
  }

  return {
    info: { name: "kafka-tools", version: "1.0.0" },
    warmup: getCtx,

    async close() {
      const ctx = getCtx.current();
      if (ctx) {
        await disconnect(ctx);
      }
    },

    register(server) {
      server.tool(
        "kafka_status",
        {},
        async () => {
          const resolution = getCtx.current()?.resolution;
          return jsonResult({
            ...state,
            brokers: resolution?.brokers ?? config.brokers,
            remoteBrokers: config.remoteBrokers ?? config.brokers,
            sshTunnel: resolution?.sshTunnel ?? false,
            topics: config.topics,
            groupId: config.groupId,
            clientId: config.clientId,
            useSsl: config.useSsl,
            saslUser: config.username ?? undefined,
            messageCount: messageStore.length
          });
        }
      );

      server.tool(
        "kafka_publish",
        {
          topic: z.string(),
          message: z.string(),
          key: z.string().optional(),
          headers: z.record(z.string(), z.string()).optional(),
          partition: z.number().optional()
        },
        async ({ topic, message, key, headers = {}, partition }) => {
          try {
            const ctx = await getCtx();
            await ensureConnections(ctx);
            await ctx.producer.send({ topic, messages: [{ value: message, key, headers, partition }] });

            return {
              content: [
                { type: "text", text: `消息已送出 topic=${topic}${partition !== undefined ? ` partition=${partition}` : ""}` }
              ]
            };
          } catch (err) {
            return { content: [{ type: "text", text: `發布失敗: ${err.message}` }], isError: true };
          }
        }
      );

      server.tool(
        "kafka_subscribe",
        {
          topic: z.string(),
          fromBeginning: z.boolean().optional()
        },
        async ({ topic, fromBeginning = config.fromBeginning }) => {
          try {
            const ctx = await getCtx();
            await ensureConnections(ctx);

            if (config.topics.includes(topic)) {
              return { content: [{ type: "text", text: `已經訂閱 topic=${topic}` }] };
            }

            await stopConsumerLoop(ctx);
            config.topics.push(topic);
            await ctx.consumer.subscribe({ topics: config.topics, fromBeginning });
            console.error(`✅ 已訂閱 Kafka topic=${topic} fromBeginning=${fromBeginning}`);
            await startConsumerLoop(ctx);

            return { content: [{ type: "text", text: `成功訂閱 topic=${topic} fromBeginning=${fromBeginning}` }] };
          } catch (err) {
            return { content: [{ type: "text", text: `訂閱失敗: ${err.message}` }], isError: true };
          }
        }
      );

      server.tool(
        "kafka_get_messages",
        {
          limit: z.number().optional(),
          topic: z.string().optional(),
          partition: z.number().optional()
        },
        async ({ limit = 10, topic, partition }) => {
          const filtered = topic !== undefined || partition !== undefined;
          const messages = messageStore.latest(
            limit,
            filtered &&
              ((m) => (topic === undefined || m.topic === topic) && (partition === undefined || m.partition === partition))
          );
          return jsonResult(messages);
        }
      );

      server.tool(
        "kafka_clear_messages",
        {},
        async () => {
          const count = messageStore.clear();
          return { content: [{ type: "text", text: `已清空 ${count} 條緩存消息` }] };
        }
      );
    }
  };
}
