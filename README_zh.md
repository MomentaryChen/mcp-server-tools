# MCP Demo Server（中文版）

一组模型上下文协议（MCP）服务器实现，展示了包括数据库查询和文件操作在内的各种功能。

> [English Documentation](README.md) | [中文文档](README_zh.md)

## 作者想對大家說 MomentaryChen

這些是實用且易於上手的 MCP 協議連線工具，旨在幫助大家快速接入各類資料庫、檔案系統與消息中介等服務，方便進行資料處理與整合。每個工具皆配有豐富的範例和直觀的接口說明，適合開發、測試或學習使用。歡迎大家多加利用，若覺得還不錯，請幫忙點個贊支持，您的支持是我持續完善的動力！

## 概述

本项目包含多个 MCP 服务器实现，可用于 Cursor 或其他兼容 MCP 的客户端：

- **基础演示服务器** (`server.js`) - 简单的 hello world 示例
- **MySQL 工具** (`server-mysql.js`) - 对 MySQL 数据库执行 SQL 查询
- **TDengine 工具** (`server-tdengine.js`) - 对 TDengine 时序数据库执行 SQL 查询
- **MongoDB 工具** (`server-mongodb.js`) - 查询、插入、更新、删除 MongoDB 集合中的文档
- **文件工具** (`server-read-files.js`) - 从文件系统读取文件
- **Axios 工具** (`server-axios.js`) - 通过 HTTP API 执行 GET/POST/PUT/DELETE 请求
- **MQTT 工具** (`server-mqtt.js`) - 订阅和发布 MQTT 消息
- **Kafka 工具** (`server-kafka.js`) - 消费与发布 Kafka 消息

## 前置要求

- Node.js (v18 或更高版本)
- npm 或 yarn

## 安装

```bash
npm install
```

## 依赖项

- `@modelcontextprotocol/sdk` - 用于构建服务器的 MCP SDK
- `mysql2` - MySQL 数据库驱动
- `mongodb` - MongoDB 数据库驱动
- `axios` - HTTP 客户端
- `mqtt` - MQTT 客户端库
- `zod` - 模式验证
- `fs` - 文件系统操作（Node.js 内置模块）

## 服务器配置

### 1. 基础演示服务器 (`server.js`)

一个带有 `say_hello` 工具的简单 MCP 服务器。

**使用方法：**
```bash
node server.js
```

**可用工具：**
- `say_hello` - 返回带有提供名称的问候消息

### 2. MySQL 工具服务器 (`server-mysql.js`)

用于对 MySQL 数据库执行 SQL 查询的 MCP 服务器。

**配置：**

编辑 `server-mysql.js` 中的数据库连接设置：

```javascript
const db = await mysql.createPool({
  host: "127.0.0.1",
  user: "root",
  password: "****",
  database: "your_database"
});
```

**使用方法：**
```bash
node server-mysql.js
```

**可用工具：**
- `query_mysql` - 对 MySQL 数据库执行 SQL 查询
  - 参数：`sql` (string) - 要执行的 SQL 查询

### 3. TDengine 工具服务器 (`server-tdengine.js`)

通过 REST API 对 TDengine 时序数据库执行 SQL 查询的 MCP 服务器。

**配置：**

编辑 `server-tdengine.js` 中的 TDengine 连接设置：

```javascript
const TDENGINE_CONFIG = {
  host: "127.0.0.1",
  port: 6041, // REST API 默认端口
  user: "root",
  password: "****"
};
```

**使用方法：**
```bash
node server-tdengine.js
```

**可用工具：**
- `query_tdengine` - 对 TDengine 数据库执行 SQL 查询
  - 参数：`sql` (string) - 要执行的 SQL 查询

### 4. MongoDB 工具服务器 (`server-mongodb.js`)

用于查询和操作 MongoDB 数据库的 MCP 服务器。

**配置：**

编辑 `server-mongodb.js` 中的 MongoDB 连接设置：

```javascript
const uri = "mongodb://username:****@127.0.0.1:27017";
const client = new MongoClient(uri);
await client.connect();
const db = client.db("your_database_name");
```

**使用方法：**
```bash
node server-mongodb.js
```

**可用工具：**
- `query_mongo` - 从 MongoDB 集合查询文档
  - 参数：
    - `collection` (string) - 集合名称
    - `query` (object, 可选) - MongoDB 查询过滤器
- `mongo_insert` - 向 MongoDB 集合插入文档
  - 参数：
    - `collection` (string) - 集合名称
    - `document` (object) - 要插入的文档
- `mongo_update` - 更新 MongoDB 集合中的文档
  - 参数：
    - `collection` (string) - 集合名称
    - `filter` (object) - 用于匹配文档的 MongoDB 过滤器
    - `update` (object) - 更新操作
- `mongo_delete` - 从 MongoDB 集合删除文档
  - 参数：
    - `collection` (string) - 集合名称
    - `filter` (object) - 用于匹配文档的 MongoDB 过滤器
- `list_mongo_collections` - 列出数据库中的所有集合
  - 参数：无

### 5. 文件工具服务器 (`server-read-files.js`)

用于从文件系统读取文件的 MCP 服务器。

**使用方法：**
```bash
node server-read-files.js
```

**可用工具：**
- `readFile` - 从文件系统读取文件内容
  - 参数：`path` (string) - 要读取的文件路径

### 6. Axios 工具服务器 (`server-axios.js`)

用于通过 HTTP API 发送请求的 MCP 服务器。

**使用方法：**
```bash
node server-axios.js
```

**可用工具：**
- `call_api_get` - 发送 HTTP GET 请求
  - 参数：
    - `url` (string) - API 地址
    - `headers` (object, 可选) - HTTP 头
- `call_api_post` - 发送 HTTP POST 请求
  - 参数：
    - `url` (string) - API 地址
    - `body` (string) - 请求体（若可能会解析为 JSON）
    - `headers` (string) - HTTP 头（JSON 字符串）
- `call_api_put` - 发送 HTTP PUT 请求
  - 参数：
    - `url` (string) - API 地址
    - `body` (any, 可选) - 请求体
    - `headers` (object, 可选) - HTTP 头
- `call_api_delete` - 发送 HTTP DELETE 请求
  - 参数：
    - `url` (string) - API 地址
    - `headers` (object, 可选) - HTTP 头

### 7. MQTT 工具服务器 (`server-mqtt.js`)

用于订阅和发布 MQTT 消息的 MCP 服务器。

**使用方法：**
```bash
node server-mqtt.js --host alpha --topics "/events/#"
```

**命令行参数：**
- `--host` (必需) - MQTT Broker 主机地址
- `--port` (可选) - MQTT Broker 端口，默认根据 TLS 设置自动选择（8883 for TLS, 1883 for non-TLS）
- `--topics` (可选) - 启动时订阅的主题，支持多个主题（用逗号分隔）或多次使用 `--topics`。如果不提供，可以通过 `mqtt_subscribe` 工具动态订阅
- `--username` (可选) - MQTT 用户名
- `--password` (可选) - MQTT 密码
- `--client-id` (可选) - MQTT 客户端 ID，默认自动生成
- `--no-tls` (可选) - 禁用 TLS/SSL，使用未加密连接
- `--ca-cert` (可选) - CA 证书文件路径（用于 TLS）
- `--client-cert` (可选) - 客户端证书文件路径（用于双向 TLS）
- `--client-key` (可选) - 客户端密钥文件路径（用于双向 TLS）

**使用示例：**
```bash
# 基本订阅（启动时订阅，默认使用 TLS，端口 8883）
node server-mqtt.js --host alpha --topics "/events/#"

# 使用 TLS 并指定端口
node server-mqtt.js --host alpha --port 8883 --topics "/events/#"

# 禁用 TLS，使用未加密连接（端口 1883）
node server-mqtt.js --host alpha --no-tls --topics "/events/#"

# 订阅多个主题（启动时订阅）
node server-mqtt.js --host alpha --topics "/events/#" --topics "/sensors/+/temperature"

# 不订阅任何主题，完全通过工具动态订阅
node server-mqtt.js --host alpha

# 带认证的订阅（TLS）
node server-mqtt.js --host alpha --port 8883 --topics "/events/#" --username user --password ****

# 带认证的订阅（非 TLS）
node server-mqtt.js --host alpha --port 1883 --no-tls --topics "/events/#" --username user --password ****

# 使用自定义证书（双向 TLS）
node server-mqtt.js --host alpha --ca-cert ca.crt --client-cert client.crt --client-key client.key --topics "/events/#"

# 指定客户端 ID
node server-mqtt.js --host alpha --topics "/events/#" --client-id my-client-id
```

**TLS/SSL 配置说明：**
- ✅ 默认启用 TLS/SSL（端口 8883）
- ✅ 默认禁用证书验证（`rejectUnauthorized: false`），适用于自签名证书
- ✅ 支持自定义 CA 证书、客户端证书和密钥
- ✅ 使用 `--no-tls` 选项可禁用 TLS，使用未加密连接（端口 1883）

**动态订阅功能：**
- ✅ 支持在运行时通过 `mqtt_subscribe` 工具动态订阅新主题
- ✅ 支持通过 `mqtt_unsubscribe` 工具动态取消订阅
- ✅ 支持批量订阅多个主题
- ✅ 启动时可以不提供 `--topics` 参数，完全通过工具动态管理订阅

**可用工具：**
- `mqtt_status` - 获取 MQTT 连接状态和订阅信息
  - 参数：无
- `mqtt_get_messages` - 获取接收到的消息
  - 参数：
    - `limit` (number, 可选) - 返回消息数量限制，默认 10
    - `topic` (string, 可选) - 按主题过滤消息，支持通配符
- `mqtt_publish` - 发布消息到指定主题
  - 参数：
    - `topic` (string) - 目标主题
    - `message` (string) - 消息内容
    - `qos` (number, 可选) - 服务质量等级 (0-2)，默认 0
    - `retain` (boolean, 可选) - 是否保留消息，默认 false
- `mqtt_subscribe` - 动态订阅新主题（运行时订阅）
  - 参数：
    - `topic` (string) - 要订阅的主题
    - `qos` (number, 可选) - 服务质量等级 (0-2)，默认 0
  - 说明：可以在运行时动态订阅新主题，无需重启服务器
- `mqtt_subscribe_batch` - 批量订阅多个主题
  - 参数：
    - `topics` (array) - 要订阅的主题数组
    - `qos` (number, 可选) - 服务质量等级 (0-2)，默认 0
  - 说明：一次性订阅多个主题，返回每个主题的订阅结果
- `mqtt_unsubscribe` - 动态取消订阅主题（运行时取消订阅）
  - 参数：
    - `topic` (string) - 要取消订阅的主题
  - 说明：可以在运行时动态取消订阅，无需重启服务器
- `mqtt_clear_messages` - 清空消息存储
  - 参数：无

### 8. Kafka 工具服务器 (`server-kafka.js`)

用于消费和发布 Kafka 消息的 MCP 服务器。

**使用方法：**
```bash
node server-kafka.js --brokers localhost:9092 --topics demo-topic --group-id cursor-group --from-beginning
```

**命令行参数：**
- `--brokers` (必需) - 以逗号分隔的 broker 列表，例如 `localhost:9092,localhost:9093`；如果未写端口，默认使用 9092
- `--topics` (可选) - 启动时订阅的 topic，支持多个（逗号分隔或多次使用 `--topics`）。也可运行时用 `kafka_subscribe` 动态订阅
- `--group-id` (可选) - 消费者组 ID，默认自动生成
- `--client-id` (可选) - 客户端 ID，默认自动生成
- `--from-beginning` (可选) - 订阅时从最旧偏移读取，默认 false
- `--username` / `--password` (可选) - SASL/PLAIN 用户名与密码
- `--ssl` (可选) - 启用 SSL/TLS 连接

**使用示例：**
```bash
# 基本订阅，从最新偏移开始
node server-kafka.js --brokers localhost:9092 --topics demo-topic

# 从最旧偏移开始读取
node server-kafka.js --brokers localhost:9092 --topics demo-topic --from-beginning

# 订阅多个主题（启动时订阅）
node server-kafka.js --brokers localhost:9092 --topics topic1,topic2 --topics topic3

# 多个 broker（高可用）
node server-kafka.js --brokers kafka1:9092,kafka2:9092,kafka3:9092 --topics demo-topic

# 不指定主题，完全通过工具动态订阅
node server-kafka.js --brokers localhost:9092

# SASL/PLAIN + TLS
node server-kafka.js --brokers kafka1:9093 --topics secure-topic --ssl --username user --password ****

# 自定义消费者组和客户端 ID
node server-kafka.js --brokers localhost:9092 --topics demo-topic --group-id my-group --client-id my-client
```

**动态订阅功能：**
- ✅ 支持在运行时通过 `kafka_subscribe` 工具动态订阅新主题
- ✅ 支持为每个主题单独设置是否从最早偏移开始读取
- ✅ 启动时可以不提供 `--topics` 参数，完全通过工具动态管理订阅
- ✅ 消息存储在内存中，最多保留 10000 条消息

**可用工具：**
- `kafka_status` - 查询 producer/consumer 连接状态、订阅 topic 等信息
  - 参数：无
  - 返回：连接状态、broker 列表、订阅的主题、消费者组 ID、客户端 ID、SSL 配置、消息数量等
- `kafka_publish` - 发布消息到指定 topic
  - 参数：
    - `topic` (string) - 目标 topic
    - `message` (string) - 消息内容
    - `key` (string, 可选) - 消息 key
    - `headers` (record, 可选) - Kafka headers（字符串键值）
    - `partition` (number, 可选) - 目标分区
- `kafka_subscribe` - 运行时订阅新 topic（动态订阅）
  - 参数：
    - `topic` (string) - 要订阅的 topic
    - `fromBeginning` (boolean, 可选) - 是否从最旧偏移开始，默认使用启动时的 `--from-beginning` 设置
  - 说明：可以在运行时动态订阅新主题，无需重启服务器。如果消费者正在运行，会自动停止并重新订阅所有主题（包括新主题）
- `kafka_get_messages` - 获取最近的消费消息（内存缓存，最多 10000 条）
  - 参数：
    - `limit` (number, 可选) - 返回数量，默认 10
    - `topic` (string, 可选) - 按 topic 过滤
    - `partition` (number, 可选) - 按分区过滤
  - 返回：消息数组，包含 topic、partition、offset、timestamp、key、value、headers 等信息
- `kafka_clear_messages` - 清空消息缓存
  - 参数：无

## MCP 客户端配置

要在 Cursor 中使用这些服务器，请将它们添加到 MCP 配置文件（通常是 `~/.cursor/mcp.json`）：

### 配置示例

```json
{
  "mcpServers": {
    "demo": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server.js"]
    },
    "mysql-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-mysql.js"]
    },
    "tdengine-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-tdengine.js"]
    },
    "mongodb-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-mongodb.js"]
    },
    "file-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-read-files.js"]
    },
    "axios-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-axios.js"]
    },
    "mqtt-tools": {
      "command": "node",
      "args": [
        "D:/projects/mcp-demo-server/server-mqtt.js",
        "--host",
        "alpha",
        "--topics",
        "/events/#"
      ]
    },
    "kafka-tools": {
      "command": "node",
      "args": [
        "D:/projects/mcp-demo-server/server-kafka.js",
        "--brokers",
        "localhost:9092",
        "--topics",
        "demo-topic"
      ]
    }
  }
}
```

**注意：** 请更新文件路径以匹配您的实际项目位置。

## 项目结构

```
mcp-demo-server/
├── server.js              # 基础演示服务器
├── server-mysql.js        # MySQL 数据库工具
├── server-tdengine.js     # TDengine 数据库工具
├── server-mongodb.js      # MongoDB 数据库工具
├── server-read-files.js   # 文件读取工具
├── server-axios.js        # HTTP API 请求工具
├── server-mqtt.js         # MQTT 消息订阅和发布工具
├── server-kafka.js        # Kafka 消息消费与发布工具
├── package.json           # 项目依赖
├── README.md              # 英文文档（English）
└── README_zh.md           # 中文文档（Chinese）
```

## 功能特性

- ✅ 多个 MCP 服务器实现
- ✅ 数据库查询支持（MySQL、TDengine、MongoDB）
- ✅ MongoDB CRUD 操作（创建、读取、更新、删除）
- ✅ 通过 Axios 支持 HTTP API 请求（GET、POST、PUT、DELETE）
- ✅ MQTT 消息订阅、发布与动态主题管理
- ✅ Kafka 消息消费与发布，支持运行时订阅
- ✅ 支持 MQTT TLS/SSL 连接
- ✅ 文件系统操作
- ✅ 使用 Zod 进行模式验证
- ✅ 错误处理和日志记录
- ✅ 用于 MCP 通信的 STDIO 传输

## 安全注意事项

⚠️ **重要提示：** 在生产环境部署之前：

1. 更新默认数据库凭据
2. 实现适当的身份验证和授权
3. 为 SQL 查询添加输入验证和清理
4. 将文件系统访问限制到安全目录
5. 使用环境变量存储敏感配置

## 许可证

本项目按原样提供，仅用于演示目的。

