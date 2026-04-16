import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import mqtt from "mqtt";
import fs from "fs";

// Parse command-line arguments.
function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    host: null,
    port: null, // Auto-select based on TLS setting by default.
    topics: [],
    username: null,
    password: null,
    clientId: `mcp-mqtt-${Math.random().toString(16).substr(2, 8)}`,
    useTls: true, // Enable TLS by default.
    caCert: null,
    clientCert: null,
    clientKey: null
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    switch (arg) {
      case "--host":
        config.host = args[++i];
        break;
      case "--port":
        config.port = parseInt(args[++i], 10);
        break;
      case "--topics":
        // Support multiple topics via comma-separated value or repeated --topics.
        const topics = args[++i].split(",").map(t => t.trim());
        config.topics.push(...topics);
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

  // Auto-select port based on TLS setting if no port is provided.
  if (config.port === null) {
    config.port = config.useTls ? 8883 : 1883;
  }

  return config;
}

const config = parseArgs();

// Validate required arguments.
if (!config.host) {
  console.error("错误: 必须提供 --host 参数");
  process.exit(1);
}

// topics is optional and can be subscribed dynamically via mqtt_subscribe.

// MQTT connection options.
const mqttOptions = {
  clientId: config.clientId,
  reconnectPeriod: 1000,
  connectTimeout: 30 * 1000,
  keepalive: 60
};

// Inject username and password if provided.
if (config.username) {
  mqttOptions.username = config.username;
}

if (config.password) {
  mqttOptions.password = config.password;
}

// TLS/SSL configuration.
if (config.useTls) {
  mqttOptions.rejectUnauthorized = false; // Disable certificate verification (like Python cert_reqs=ssl.CERT_NONE).
  
  // Load certificate files if provided.
  if (config.caCert) {
    try {
      mqttOptions.ca = fs.readFileSync(config.caCert);
    } catch (err) {
      console.error(`警告: 无法读取 CA 证书文件 ${config.caCert}: ${err.message}`);
    }
  }
  
  if (config.clientCert) {
    try {
      mqttOptions.cert = fs.readFileSync(config.clientCert);
    } catch (err) {
      console.error(`警告: 无法读取客户端证书文件 ${config.clientCert}: ${err.message}`);
    }
  }
  
  if (config.clientKey) {
    try {
      mqttOptions.key = fs.readFileSync(config.clientKey);
    } catch (err) {
      console.error(`警告: 无法读取客户端密钥文件 ${config.clientKey}: ${err.message}`);
    }
  }
}

// Store received messages.
const messageStore = [];
const maxMessages = 10000; // Keep up to 10000 messages to reduce overflow loss risk.

// Create MCP server.
const server = new McpServer({ name: "mqtt-tools", version: "1.0.0" });

// Connect to MQTT broker.
let mqttClient = null;
let isConnected = false;

async function connectMQTT() {
  return new Promise((resolve, reject) => {
    // Select protocol based on TLS setting.
    const protocol = config.useTls ? "mqtts" : "mqtt";
    const brokerUrl = `${protocol}://${config.host}:${config.port}`;
    const tlsStatus = config.useTls ? "TLS" : "Unencrypted";
    
    console.error(`正在连接到 MQTT Broker: ${brokerUrl} (${tlsStatus})`);
    
    if (config.useTls) {
      console.error("🔒 TLS/SSL 连接已启用（证书验证已禁用）");
    } else {
      console.error("🔓 使用未加密连接");
    }
    
    // Show authentication details if provided.
    if (config.username) {
      console.error(`🔐 认证用户名: ${config.username}`);
    }
    if (config.password) {
      console.error(`🔐 认证密码: ${'*'.repeat(Math.min(config.password.length, 10))}`);
    }
    
    mqttClient = mqtt.connect(brokerUrl, mqttOptions);

    mqttClient.on("connect", () => {
      isConnected = true;
      console.error(`✅ 已连接到 MQTT Broker: ${brokerUrl}`);
      
      // Subscribe to startup topics if any were provided.
      if (config.topics.length > 0) {
        config.topics.forEach(topic => {
          mqttClient.subscribe(topic, { qos: 1 }, (err) => {
            if (err) {
              console.error(`订阅主题失败 ${topic}:`, err);
            } else {
              console.error(`✅ 已订阅主题: ${topic}`);
            }
          });
        });
      } else {
        console.error("ℹ️  未指定初始订阅主题，可通过 mqtt_subscribe 工具动态订阅");
      }
      
      resolve();
    });

    mqttClient.on("error", (err) => {
      console.error("MQTT 连接错误:", err);
      isConnected = false;
      reject(err);
    });

    mqttClient.on("message", (topic, message, packet) => {
      const messageData = {
        topic,
        message: message.toString(),
        timestamp: new Date().toISOString(),
        qos: packet.qos,
        retain: packet.retain
      };
      
      // Store messages with bounded history.
      messageStore.push(messageData);
      if (messageStore.length > maxMessages) {
        messageStore.shift();
      }
      
      console.error(`📨 收到消息 [${topic}]: ${message.toString()}`);
    });

    mqttClient.on("reconnect", () => {
      console.error("正在重新连接 MQTT Broker...");
    });

    mqttClient.on("close", () => {
      isConnected = false;
      console.error("MQTT 连接已关闭");
    });

    mqttClient.on("offline", () => {
      isConnected = false;
      console.error("MQTT 客户端已离线");
    });
  });
}

// Tool 1: Get connection status.
server.tool(
  "mqtt_status",
  {},
  async () => {
    try {
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            connected: isConnected,
            host: config.host,
            port: config.port,
            useTls: config.useTls,
            subscribedTopics: config.topics,
            messageCount: messageStore.length
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `查询失败: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 2: Get latest messages.
server.tool(
  "mqtt_get_messages",
  {
    limit: z.number().optional(),
    topic: z.string().optional()
  },
  async ({ limit = 10, topic }) => {
    try {
      let messages = [...messageStore];
      
      // Filter by topic if provided.
      if (topic) {
        messages = messages.filter(msg => {
          // Support wildcard matching.
          const pattern = topic.replace(/\+/g, "[^/]+").replace(/#/g, ".*");
          const regex = new RegExp(`^${pattern}$`);
          return regex.test(msg.topic);
        });
      }
      
      // Limit number of returned messages.
      messages = messages.slice(-limit);
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(messages, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `获取消息失败: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 3: Publish message.
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
      if (!isConnected || !mqttClient) {
        return {
          content: [{ type: "text", text: "MQTT 客户端未连接" }],
          isError: true
        };
      }

      return new Promise((resolve) => {
        mqttClient.publish(topic, message, { qos, retain }, (err) => {
          if (err) {
            resolve({
              content: [{ type: "text", text: `发布失败: ${err.message}` }],
              isError: true
            });
          } else {
            resolve({
              content: [{
                type: "text",
                text: `消息已发布到主题: ${topic}`
              }]
            });
          }
        });
      });
    } catch (err) {
      return {
        content: [{ type: "text", text: `发布失败: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 4: Subscribe to a new topic (supports dynamic subscription).
server.tool(
  "mqtt_subscribe",
  {
    topic: z.string(),
    qos: z.number().min(0).max(2).optional()
  },
  async ({ topic, qos = 1 }) => {
    try {
      if (!isConnected || !mqttClient) {
        return {
          content: [{ type: "text", text: "MQTT 客户端未连接" }],
          isError: true
        };
      }

      // Check whether already subscribed.
      if (config.topics.includes(topic)) {
        return {
          content: [{
            type: "text",
            text: `主题 ${topic} 已经订阅`
          }]
        };
      }

      return new Promise((resolve) => {
        mqttClient.subscribe(topic, { qos }, (err, granted) => {
          if (err) {
            resolve({
              content: [{ type: "text", text: `订阅失败: ${err.message}` }],
              isError: true
            });
          } else {
            // Add to subscribed topic list.
            config.topics.push(topic);
            console.error(`✅ 动态订阅主题: ${topic} (QoS: ${qos})`);
            resolve({
              content: [{
                type: "text",
                text: `已成功订阅主题: ${topic} (QoS: ${qos})`
              }]
            });
          }
        });
      });
    } catch (err) {
      return {
        content: [{ type: "text", text: `订阅失败: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 5: Unsubscribe (supports dynamic unsubscription).
server.tool(
  "mqtt_unsubscribe",
  {
    topic: z.string()
  },
  async ({ topic }) => {
    try {
      if (!isConnected || !mqttClient) {
        return {
          content: [{ type: "text", text: "MQTT 客户端未连接" }],
          isError: true
        };
      }

      // Check whether currently subscribed.
      if (!config.topics.includes(topic)) {
        return {
          content: [{
            type: "text",
            text: `主题 ${topic} 未订阅，无需取消`
          }]
        };
      }

      return new Promise((resolve) => {
        mqttClient.unsubscribe(topic, (err) => {
          if (err) {
            resolve({
              content: [{ type: "text", text: `取消订阅失败: ${err.message}` }],
              isError: true
            });
          } else {
            const index = config.topics.indexOf(topic);
            if (index > -1) {
              config.topics.splice(index, 1);
            }
            console.error(`✅ 已取消订阅主题: ${topic}`);
            resolve({
              content: [{
                type: "text",
                text: `已成功取消订阅主题: ${topic}`
              }]
            });
          }
        });
      });
    } catch (err) {
      return {
        content: [{ type: "text", text: `取消订阅失败: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 6: Clear stored messages.
server.tool(
  "mqtt_clear_messages",
  {},
  async () => {
    try {
      const count = messageStore.length;
      messageStore.length = 0;
      return {
        content: [{
          type: "text",
          text: `已清空 ${count} 条消息`
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `清空失败: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Tool 7: Batch subscribe multiple topics.
server.tool(
  "mqtt_subscribe_batch",
  {
    topics: z.array(z.string()),
    qos: z.number().min(0).max(2).optional()
  },
  async ({ topics, qos = 1 }) => {
    try {
      if (!isConnected || !mqttClient) {
        return {
          content: [{ type: "text", text: "MQTT 客户端未连接" }],
          isError: true
        };
      }

      const results = [];
      const promises = topics.map(topic => {
        return new Promise((resolve) => {
          if (config.topics.includes(topic)) {
            resolve({ topic, success: false, message: "已订阅" });
            return;
          }

          mqttClient.subscribe(topic, { qos }, (err) => {
            if (err) {
              resolve({ topic, success: false, message: err.message });
            } else {
              config.topics.push(topic);
              console.error(`✅ 批量订阅主题: ${topic}`);
              resolve({ topic, success: true, message: "订阅成功" });
            }
          });
        });
      });

      const batchResults = await Promise.all(promises);
      const successCount = batchResults.filter(r => r.success).length;

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            total: topics.length,
            success: successCount,
            failed: topics.length - successCount,
            results: batchResults
          }, null, 2)
        }]
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `批量订阅失败: ${err.message}` }],
        isError: true
      };
    }
  }
);

// Connect to MQTT broker.
try {
  await connectMQTT();
} catch (err) {
  console.error("MQTT 连接失败:", err);
  process.exit(1);
}

// Connect to Cursor via stdin/stdout.
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("✅ MCP MQTT Server 已启动");

