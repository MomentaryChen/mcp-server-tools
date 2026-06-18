import dotenv from "dotenv";
import net from "net";
import { Kafka, logLevel } from "kafkajs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createSshForwardTunnel, getSshConfigFromEnv, useSshTunnel } from "./scripts/ssh-tunnel.js";

dotenv.config({ path: process.env.ENV_FILE || ".env" });

function normalizeBroker(broker) {
  const trimmed = broker.trim();
  if (!trimmed) {
    return null;
  }
  return trimmed.includes(":") ? trimmed : `${trimmed}:9092`;
}

function parseBrokersFromEnv() {
  const { KAFKA_BROKERS, KAFKA_HOST, KAFKA_PORT = "9092" } = process.env;

  if (KAFKA_BROKERS?.trim()) {
    return KAFKA_BROKERS.split(",")
      .map(normalizeBroker)
      .filter(Boolean);
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

function parseBooleanFlag(value, defaultValue = false) {
  if (value == null || String(value).trim() === "") {
    return defaultValue;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "n", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseArgs() {
  const args = process.argv.slice(2);
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
    const arg = args[i];
    switch (arg) {
      case "--brokers":
        config.brokers = args[++i]
          .split(",")
          .map(normalizeBroker)
          .filter(Boolean);
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

function applyEnvConfig(config) {
  if (config.brokers.length === 0) {
    config.brokers = parseBrokersFromEnv();
  }

  if (process.env.KAFKA_TOPICS?.trim()) {
    config.topics.push(
      ...process.env.KAFKA_TOPICS.split(",")
        .map((topic) => topic.trim())
        .filter(Boolean)
    );
  }

  if (process.env.KAFKA_GROUP_ID?.trim()) {
    config.groupId = process.env.KAFKA_GROUP_ID.trim();
  }

  if (process.env.KAFKA_CLIENT_ID?.trim()) {
    config.clientId = process.env.KAFKA_CLIENT_ID.trim();
  }

  if (process.env.KAFKA_FROM_BEGINNING != null) {
    config.fromBeginning = parseBooleanFlag(process.env.KAFKA_FROM_BEGINNING, config.fromBeginning);
  }

  if (process.env.KAFKA_USERNAME?.trim()) {
    config.username = process.env.KAFKA_USERNAME.trim();
  }

  if (process.env.KAFKA_PASSWORD != null) {
    config.password = process.env.KAFKA_PASSWORD;
  }

  if (process.env.KAFKA_SSL != null) {
    config.useSsl = parseBooleanFlag(process.env.KAFKA_SSL, config.useSsl);
  }

  return config;
}

function parseBrokerEndpoint(broker) {
  const match = broker.match(/^(.*):(\d+)$/);
  if (!match) {
    throw new Error(`無效的 broker 位址: ${broker}`);
  }

  return {
    host: match[1],
    port: parseInt(match[2], 10)
  };
}

function brokerEndpointKey(host, port) {
  return `${host}:${port}`;
}

function buildK8sBrokerAliases(brokers, localBrokers) {
  const dnsSuffix = process.env.KAFKA_BROKER_DNS_SUFFIX?.trim();
  if (!dnsSuffix) {
    return new Map();
  }

  const namePrefix = process.env.KAFKA_BROKER_NAME_PREFIX?.trim() || "kafka";
  const aliases = new Map();

  for (let i = 0; i < brokers.length; i += 1) {
    const { port } = parseBrokerEndpoint(brokers[i]);
    const local = parseBrokerEndpoint(localBrokers[i]);
    const fqdn = `${namePrefix}-${i}.${dnsSuffix}`;
    aliases.set(brokerEndpointKey(fqdn, port), local);
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

async function resolveBrokers(brokers) {
  const sshConfig = getSshConfigFromEnv(process.env, "KAFKA");

  if (!useSshTunnel(sshConfig)) {
    return {
      brokers,
      sshTunnel: false,
      remoteBrokers: brokers,
      brokerAddressMap: new Map()
    };
  }

  const localBrokers = [];
  const brokerAddressMap = new Map();

  for (const broker of brokers) {
    const { host, port } = parseBrokerEndpoint(broker);
    const tunnelTarget = await createSshForwardTunnel({
      sshConfig,
      dstAddr: host,
      dstPort: port
    });
    const localBroker = `${tunnelTarget.host}:${tunnelTarget.port}`;
    const localEndpoint = parseBrokerEndpoint(localBroker);

    localBrokers.push(localBroker);
    brokerAddressMap.set(broker, localEndpoint);
    brokerAddressMap.set(brokerEndpointKey(host, port), localEndpoint);

    console.error(
      `✅ Kafka SSH 通道已建立（jump hops: ${sshConfig.jumps.length} -> ${host}:${port} -> ${localBroker}）`
    );
  }

  for (const [alias, localEndpoint] of buildK8sBrokerAliases(brokers, localBrokers)) {
    brokerAddressMap.set(alias, localEndpoint);
  }

  return {
    brokers: localBrokers,
    sshTunnel: true,
    remoteBrokers: brokers,
    localBrokers,
    brokerAddressMap
  };
}

const config = applyEnvConfig(parseArgs());

if (config.brokers.length === 0) {
  console.error("❌ 必須提供 --brokers，或於 .env 設定 KAFKA_BROKERS / KAFKA_HOST");
  process.exit(1);
}

const brokerResolution = await resolveBrokers(config.brokers);
config.brokers = brokerResolution.brokers;
config.remoteBrokers = brokerResolution.remoteBrokers;
config.localBrokers = brokerResolution.localBrokers ?? brokerResolution.brokers;
config.sshTunnel = brokerResolution.sshTunnel;

config.brokerAddressMap = brokerResolution.brokerAddressMap ?? new Map();

const kafka = new Kafka({
  clientId: config.clientId,
  brokers: config.brokers,
  ssl: config.useSsl || undefined,
  sasl: config.username
    ? {
        mechanism: "plain",
        username: config.username,
        password: config.password ?? ""
      }
    : undefined,
  connectionTimeout: config.sshTunnel ? 30000 : 1000,
  requestTimeout: config.sshTunnel ? 60000 : 30000,
  socketFactory:
    config.brokerAddressMap.size > 0
      ? createBrokerSocketFactory(config.brokerAddressMap)
      : undefined,
  logLevel: logLevel.ERROR
});

const producer = kafka.producer();
const consumer = kafka.consumer({ groupId: config.groupId });
let producerConnected = false;
let consumerConnected = false;
let consumerRunning = false;

const messageStore = [];
const maxMessages = 10000;

async function ensureConnections() {
  if (!producerConnected) {
    await producer.connect();
    producerConnected = true;
    console.error("✅ Kafka Producer 已連線");
  }

  if (!consumerConnected) {
    await consumer.connect();
    consumerConnected = true;
    console.error("✅ Kafka Consumer 已連線");
  }
}

async function stopConsumerLoop() {
  if (!consumerRunning) return;
  try {
    await consumer.stop();
    consumerRunning = false;
    console.error("⏹️ Kafka Consumer 已停止");
  } catch (err) {
    console.error(`❌ 停止 Consumer 失敗: ${err.message}`);
  }
}

async function startConsumerLoop() {
  if (consumerRunning) return;
  consumerRunning = true;

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      const record = {
        topic,
        partition,
        offset: message.offset,
        timestamp: new Date(Number(message.timestamp)).toISOString(),
        key: message.key?.toString() ?? null,
        value: message.value?.toString() ?? "",
        headers: message.headers
          ? Object.fromEntries(
              Object.entries(message.headers).map(([k, v]) => [k, v?.toString() ?? ""])
            )
          : {}
      };

      messageStore.push(record);
      if (messageStore.length > maxMessages) {
        messageStore.shift();
      }

      console.error(
        `📥 收到消息 topic=${topic} partition=${partition} offset=${record.offset} key=${record.key}`
      );
    }
  });

  console.error("▶️ Kafka Consumer 開始拉取消息");
}

const server = new McpServer({ name: "kafka-tools", version: "1.0.0" });

server.tool(
  "kafka_status",
  {},
  async () => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            producerConnected,
            consumerConnected,
            consumerRunning,
            brokers: config.brokers,
            remoteBrokers: config.remoteBrokers,
            sshTunnel: config.sshTunnel,
            topics: config.topics,
            groupId: config.groupId,
            clientId: config.clientId,
            useSsl: config.useSsl,
            saslUser: config.username ?? undefined,
            messageCount: messageStore.length
          },
          null,
          2
        )
      }
    ]
  })
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
      await ensureConnections();

      await producer.send({
        topic,
        messages: [
          {
            value: message,
            key,
            headers,
            partition
          }
        ]
      });

      return {
        content: [
          {
            type: "text",
            text: `消息已送出 topic=${topic}${partition !== undefined ? ` partition=${partition}` : ""}`
          }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `發布失敗: ${err.message}` }],
        isError: true
      };
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
      await ensureConnections();

      if (config.topics.includes(topic)) {
        return { content: [{ type: "text", text: `已經訂閱 topic=${topic}` }] };
      }

      const wasRunning = consumerRunning;
      if (wasRunning) {
        await stopConsumerLoop();
      }

      config.topics.push(topic);

      await consumer.subscribe({
        topics: config.topics,
        fromBeginning
      });
      console.error(`✅ 已訂閱 Kafka topic=${topic} fromBeginning=${fromBeginning}`);

      await startConsumerLoop();

      return {
        content: [{ type: "text", text: `成功訂閱 topic=${topic} fromBeginning=${fromBeginning}` }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `訂閱失敗: ${err.message}` }],
        isError: true
      };
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
    try {
      let messages = [...messageStore];

      if (topic) {
        messages = messages.filter((m) => m.topic === topic);
      }
      if (partition !== undefined) {
        messages = messages.filter((m) => m.partition === partition);
      }

      messages = messages.slice(-limit);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(messages, null, 2)
          }
        ]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `獲取消息失敗: ${err.message}` }],
        isError: true
      };
    }
  }
);

server.tool(
  "kafka_clear_messages",
  {},
  async () => {
    const count = messageStore.length;
    messageStore.length = 0;
    return {
      content: [{ type: "text", text: `已清空 ${count} 條緩存消息` }]
    };
  }
);

async function bootstrap() {
  try {
    await ensureConnections();

    if (config.topics.length > 0) {
      for (const topic of config.topics) {
        await consumer.subscribe({ topic, fromBeginning: config.fromBeginning });
        console.error(`✅ 預設訂閱 topic=${topic} fromBeginning=${config.fromBeginning}`);
      }
      await startConsumerLoop();
    } else {
      console.error("ℹ️ 未指定預設 topic，可透過 kafka_subscribe 動態訂閱");
    }

    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("✅ MCP Kafka Server 已啟動");
  } catch (err) {
    console.error("❌ Kafka 服務啟動失敗:", err);
    process.exit(1);
  }
}

await bootstrap();
