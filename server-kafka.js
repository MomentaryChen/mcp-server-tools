import { Kafka, logLevel } from "kafkajs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

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
          .map((b) => b.trim())
          .filter(Boolean)
          .map((b) => (b.includes(":") ? b : `${b}:9092`)); // 若未指定端口，補上 Kafka 預設 9092
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

const config = parseArgs();

if (config.brokers.length === 0) {
  console.error("❌ 必須提供 --brokers，例如：localhost:9092,localhost:9093");
  process.exit(1);
}

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

      // 如果消費者正在運行，需要先停止再重新訂閱所有 topics
      const wasRunning = consumerRunning;
      if (wasRunning) {
        await stopConsumerLoop();
      }

      // 添加新的 topic 到配置
      config.topics.push(topic);

      // 重新訂閱所有 topics（包括新的）
      await consumer.subscribe({
        topics: config.topics,
        fromBeginning
      });
      console.error(`✅ 已訂閱 Kafka topic=${topic} fromBeginning=${fromBeginning}`);

      // 重新啟動消費者
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

