import { z } from "zod";
import mqtt from "mqtt";
import fs from "fs";
import { RingBuffer, errorResult, jsonResult, lazy, textResult } from "../lib/common.js";

const maxMessages = 10000;

function parseArgs(args) {
  const config = {
    host: null,
    port: null, // Auto-select based on TLS setting by default.
    topics: [],
    username: null,
    password: null,
    clientId: `mcp-mqtt-${Math.random().toString(16).slice(2, 10)}`,
    useTls: true,
    caCert: null,
    clientCert: null,
    clientKey: null
  };

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--host":
        config.host = args[++i];
        break;
      case "--port":
        config.port = parseInt(args[++i], 10);
        break;
      case "--topics":
        config.topics.push(...args[++i].split(",").map((t) => t.trim()));
        break;
      case "--username":
        config.username = args[++i];
        break;
      case "--password":
        config.password = args[++i];
        break;
      case "--client-id":
        config.clientId = args[++i];
        break;
      case "--no-tls":
        config.useTls = false;
        break;
      case "--ca-cert":
        config.caCert = args[++i];
        break;
      case "--client-cert":
        config.clientCert = args[++i];
        break;
      case "--client-key":
        config.clientKey = args[++i];
        break;
    }
  }

  if (config.port === null) {
    config.port = config.useTls ? 8883 : 1883;
  }
  return config;
}

function readOptionalFile(filePath, label) {
  if (!filePath) return undefined;
  try {
    return fs.readFileSync(filePath);
  } catch (err) {
    console.error(`警告: 无法读取${label} ${filePath}: ${err.message}`);
    return undefined;
  }
}

function buildMqttOptions(config) {
  const options = {
    clientId: config.clientId,
    reconnectPeriod: 1000,
    connectTimeout: 30 * 1000,
    keepalive: 60
  };
  if (config.username) options.username = config.username;
  if (config.password) options.password = config.password;

  if (config.useTls) {
    options.rejectUnauthorized = false; // Certificate verification disabled (like Python cert_reqs=ssl.CERT_NONE).
    options.ca = readOptionalFile(config.caCert, " CA 证书文件");
    options.cert = readOptionalFile(config.clientCert, "客户端证书文件");
    options.key = readOptionalFile(config.clientKey, "客户端密钥文件");
  }
  return options;
}

// Compile an MQTT topic filter once: `+` = one level, trailing `#` = this level and below.
function compileTopicFilter(pattern) {
  const levels = pattern.split("/");
  const multi = levels.at(-1) === "#";
  if (multi) levels.pop();
  const body = levels
    .map((level) => (level === "+" ? "[^/]*" : level.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  const regex = new RegExp(`^${body}${multi ? (levels.length ? "(?:/.*)?" : ".*") : ""}$`);
  return (topic) => regex.test(topic);
}

// Note: in the gateway one MQTT connection, its subscriptions and the message
// buffer are shared by every session connected to this instance.
export default function create({ argv = [] }) {
  const config = parseArgs(argv);
  const messageStore = new RingBuffer(maxMessages);
  let isConnected = false;

  const getClient = lazy(
    () =>
      new Promise((resolve, reject) => {
        if (!config.host) {
          reject(new Error("必须提供 --host 参数"));
          return;
        }

        const brokerUrl = `${config.useTls ? "mqtts" : "mqtt"}://${config.host}:${config.port}`;
        console.error(`正在连接到 MQTT Broker: ${brokerUrl} (${config.useTls ? "TLS" : "Unencrypted"})`);

        const client = mqtt.connect(brokerUrl, buildMqttOptions(config));
        let settled = false;

        client.on("connect", () => {
          isConnected = true;
          console.error(`✅ 已连接到 MQTT Broker: ${brokerUrl}`);
          // (Re)subscribe to every known topic, also after a reconnect.
          if (config.topics.length > 0) {
            client.subscribe(config.topics, { qos: 1 }, (err) => {
              if (err) console.error(`订阅主题失败 ${config.topics.join(",")}:`, err.message);
            });
          }
          if (!settled) {
            settled = true;
            resolve(client);
          }
        });

        client.on("error", (err) => {
          console.error("MQTT 连接错误:", err.message);
          isConnected = false;
          if (!settled) {
            settled = true;
            client.end(true);
            reject(err);
          }
        });

        client.on("message", (topic, message, packet) => {
          messageStore.push({
            topic,
            message: message.toString(),
            timestamp: new Date().toISOString(),
            qos: packet.qos,
            retain: packet.retain
          });
        });

        client.on("reconnect", () => console.error("正在重新连接 MQTT Broker..."));
        client.on("close", () => {
          isConnected = false;
        });
        client.on("offline", () => {
          isConnected = false;
          console.error("MQTT 客户端已离线");
        });
      })
  );

  const notConnected = () => errorResult("MQTT 客户端未连接");
  const fail = (prefix, err) => errorResult(`${prefix}: ${err.message}`);

  // Connect on first use; returns null when the broker is unreachable.
  async function connectedClient() {
    const client = await getClient();
    return isConnected ? client : null;
  }

  function subscribe(client, topic, qos) {
    return new Promise((resolve, reject) => {
      client.subscribe(topic, { qos }, (err) => (err ? reject(err) : resolve()));
    });
  }

  return {
    info: { name: "mqtt-tools", version: "1.0.0" },
    warmup: getClient,

    async close() {
      getClient.current()?.end(true);
    },

    register(server) {
      server.tool(
        "mqtt_status",
        {},
        async () => {
          // Trigger the first connection so status reflects reality, but don't fail on it.
          await getClient().catch(() => {});
          return jsonResult({
            connected: isConnected,
            host: config.host,
            port: config.port,
            useTls: config.useTls,
            subscribedTopics: config.topics,
            messageCount: messageStore.length
          });
        }
      );

      server.tool(
        "mqtt_get_messages",
        {
          limit: z.number().optional(),
          topic: z.string().optional()
        },
        async ({ limit = 10, topic }) => {
          const matches = topic ? compileTopicFilter(topic) : null;
          return jsonResult(messageStore.latest(limit, matches && ((msg) => matches(msg.topic))));
        }
      );

      server.tool(
        "mqtt_publish",
        {
          topic: z.string(),
          message: z.string(),
          qos: z.number().min(0).max(2).optional(),
          retain: z.boolean().optional()
        },
        async ({ topic, message, qos = 0, retain = false }) => {
          try {
            const client = await connectedClient();
            if (!client) return notConnected();
            await new Promise((resolve, reject) =>
              client.publish(topic, message, { qos, retain }, (err) => (err ? reject(err) : resolve()))
            );
            return { content: [{ type: "text", text: `消息已发布到主题: ${topic}` }] };
          } catch (err) {
            return fail("发布失败", err);
          }
        }
      );

      server.tool(
        "mqtt_subscribe",
        {
          topic: z.string(),
          qos: z.number().min(0).max(2).optional()
        },
        async ({ topic, qos = 1 }) => {
          try {
            const client = await connectedClient();
            if (!client) return notConnected();
            if (config.topics.includes(topic)) {
              return { content: [{ type: "text", text: `主题 ${topic} 已经订阅` }] };
            }
            await subscribe(client, topic, qos);
            config.topics.push(topic);
            console.error(`✅ 动态订阅主题: ${topic} (QoS: ${qos})`);
            return { content: [{ type: "text", text: `已成功订阅主题: ${topic} (QoS: ${qos})` }] };
          } catch (err) {
            return fail("订阅失败", err);
          }
        }
      );

      server.tool(
        "mqtt_unsubscribe",
        {
          topic: z.string()
        },
        async ({ topic }) => {
          try {
            const client = await connectedClient();
            if (!client) return notConnected();
            if (!config.topics.includes(topic)) {
              return { content: [{ type: "text", text: `主题 ${topic} 未订阅，无需取消` }] };
            }
            await new Promise((resolve, reject) => client.unsubscribe(topic, (err) => (err ? reject(err) : resolve())));
            config.topics.splice(config.topics.indexOf(topic), 1);
            console.error(`✅ 已取消订阅主题: ${topic}`);
            return { content: [{ type: "text", text: `已成功取消订阅主题: ${topic}` }] };
          } catch (err) {
            return fail("取消订阅失败", err);
          }
        }
      );

      server.tool(
        "mqtt_clear_messages",
        {},
        async () => {
          return textResult(`已清空 ${messageStore.clear()} 条消息`);
        }
      );

      server.tool(
        "mqtt_subscribe_batch",
        {
          topics: z.array(z.string()),
          qos: z.number().min(0).max(2).optional()
        },
        async ({ topics, qos = 1 }) => {
          try {
            const client = await connectedClient();
            if (!client) return notConnected();

            const results = await Promise.all(
              topics.map(async (topic) => {
                if (config.topics.includes(topic)) {
                  return { topic, success: false, message: "已订阅" };
                }
                try {
                  await subscribe(client, topic, qos);
                  config.topics.push(topic);
                  return { topic, success: true, message: "订阅成功" };
                } catch (err) {
                  return { topic, success: false, message: err.message };
                }
              })
            );
            const successCount = results.filter((r) => r.success).length;

            return {
              content: [
                {
                  type: "text",
                  text: JSON.stringify(
                    { total: topics.length, success: successCount, failed: topics.length - successCount, results },
                    null,
                    2
                  )
                }
              ]
            };
          } catch (err) {
            return fail("批量订阅失败", err);
          }
        }
      );
    }
  };
}
