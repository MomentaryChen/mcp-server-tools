# MCP Demo Server（中文版）

一組模型上下文協議（MCP）伺服器實作，涵蓋資料庫、檔案、HTTP API 與消息中介等常見整合場景。

> [English Documentation](README.md) | [中文文档](README_zh.md)

## 概述

本專案可直接接到 Cursor 或其他 MCP 相容客戶端：

- `server.js` - 基礎 hello-world MCP server
- `server-mysql.js` - MySQL 查詢與資料寫入工具
- `server-tdengine.js` - TDengine SQL 查詢與資料操作（REST）
- `server-mongodb.js` - MongoDB 查詢 / 新增 / 更新 / 刪除 / 列集合
- `server-read-files.js` - 檔案讀取工具
- `server-axios.js` - HTTP GET/POST/PUT/DELETE 工具
- `server-mqtt.js` - MQTT 訂閱/發布與動態主題管理
- `server-kafka.js` - Kafka 消費/發布與動態訂閱

## 環境需求

- Node.js `18+`
- npm

## 安裝

```bash
npm install
cp .env.example .env
```

如需切換不同環境設定檔，可用 `ENV_FILE`：

```bash
set ENV_FILE=.env.beta && node server-mysql.js
```

## 環境變數與設定

資料庫類伺服器皆透過 `dotenv` 載入設定：

- 預設讀取專案根目錄 `.env`
- 可用 `ENV_FILE` 指定其他路徑
- 參考模板：`.env.example`

另外支援 MySQL、MongoDB、TDengine、Kafka 的 SSH 跳板連線：

- `SSH_JUMPS`（全域跳板）
- `MYSQL_SSH_JUMPS`、`MONGO_SSH_JUMPS`、`TDENGINE_SSH_JUMPS`、`KAFKA_SSH_JUMPS`（服務專用）

## 工具清單

### `server.js`
- `say_hello`

### `server-mysql.js`（`mysql-tools`）
- `query_mysql`
- `insert_mysql`
- `update_mysql`
- `delete_mysql`

### `server-tdengine.js`（`tdengine-tools`）
- `query_tdengine`
- `insert_tdengine`
- `update_tdengine`
- `delete_tdengine`

### `server-mongodb.js`（`mongo_db-tools`）
- `query_mongo`
- `mongo_insert`
- `mongo_update`
- `mongo_delete`
- `list_mongo_collections`

### `server-read-files.js`（`file-tools`）
- `readFile`

### `server-axios.js`（`axios-tools`）
- `call_api_get`
- `call_api_post`
- `call_api_put`
- `call_api_delete`

### `server-mqtt.js`（`mqtt-tools`）
- `mqtt_status`
- `mqtt_get_messages`
- `mqtt_publish`
- `mqtt_subscribe`
- `mqtt_subscribe_batch`
- `mqtt_unsubscribe`
- `mqtt_clear_messages`

### `server-kafka.js`（`kafka-tools`）
- `kafka_status`
- `kafka_publish`
- `kafka_subscribe`
- `kafka_get_messages`
- `kafka_clear_messages`

#### Kafka 環境變數

| 變數 | 說明 |
|------|------|
| `KAFKA_BROKERS` | 多個 broker，逗號分隔（建議使用）。未寫 port 時預設 `9092`。 |
| `KAFKA_HOST` / `KAFKA_PORT` | 單一 bootstrap broker，可替代 `KAFKA_BROKERS`。 |
| `KAFKA_TOPICS` | 啟動時訂閱的 topic，逗號分隔（例如 `OC_EVENTS,OC_METRICS,OC_UPDATE`）。 |
| `KAFKA_GROUP_ID` | Consumer group id（選填）。 |
| `KAFKA_CLIENT_ID` | Kafka client id（選填）。 |
| `KAFKA_FROM_BEGINNING` | `true` / `false`，訂閱時是否從最早 offset 開始讀。 |
| `KAFKA_SSL` | 是否啟用 TLS（`true` / `false`）。 |
| `KAFKA_USERNAME` / `KAFKA_PASSWORD` | SASL/PLAIN 帳密（選填）。 |
| `KAFKA_SSH_JUMPS` | 連線 broker 的 SSH 跳板鏈（JSON 陣列，由外到內）。 |
| `KAFKA_BROKER_DNS_SUFFIX` | K8s headless service DNS 後綴，用於 broker 位址重導。 |
| `KAFKA_BROKER_NAME_PREFIX` | StatefulSet broker 名稱前綴（預設 `kafka`）。 |

#### Kafka + Kubernetes + SSH 說明

當 Kafka 跑在 K8s 內、MCP 跑在本機時：

1. `KAFKA_BROKERS` 請填可從跳板抵達的 Pod IP 或 broker 位址。
2. 使用 SSH tunnel 時，建議列出 **全部 broker**，且順序對應 `kafka-0` … `kafka-N`。
3. 設定 `KAFKA_BROKER_DNS_SUFFIX`，將 `advertised.listeners` 回傳的 `kafka-3.kafka-headless-service.default.svc.cluster.local` 等內部 DNS 重導至本機 SSH tunnel。
4. `kafka_get_messages` 只回傳 **訂閱後收到** 的訊息（記憶體緩存）。若要讀歷史訊息，請用 `kafka_subscribe` 並設 `fromBeginning: true`。

`.env.alpha` 範例：

```env
KAFKA_BROKERS=10.10.112.155,10.10.112.158,10.10.193.132,10.10.25.210,10.10.52.138
KAFKA_TOPICS=OC_EVENTS,OC_METRICS,OC_UPDATE
KAFKA_BROKER_DNS_SUFFIX=kafka-headless-service.default.svc.cluster.local
KAFKA_SSH_JUMPS=[{"host":"jump-1.example.com","port":22,"user":"ubuntu","privateKeyPath":"D:/keys/jump1"},{"host":"10.2.2.6","port":22,"user":"ubuntu","privateKeyPath":"D:/keys/jump2"}]
```

## 啟動範例

```bash
node server.js
node server-mysql.js
node server-tdengine.js
node server-mongodb.js
node server-read-files.js
node server-axios.js
node server-mqtt.js --host alpha --topics "/events/#"
node server-kafka.js --brokers localhost:9092 --topics OC_EVENTS,OC_METRICS
```

使用環境設定檔啟動：

```bash
set ENV_FILE=.env.alpha && node server-kafka.js
```

## Cursor MCP 設定範例

```json
{
  "mcpServers": {
    "mysql-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-mysql.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env" }
    },
    "tdengine-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-tdengine.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env" }
    },
    "mongo-db-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-mongodb.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env" }
    },
    "kafka-alpha-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-kafka.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env.alpha" }
    },
    "kafka-beta-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-kafka.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env.beta" }
    }
  }
}
```

## 主要相依套件

- `@modelcontextprotocol/sdk`
- `axios`
- `dotenv`
- `kafkajs`
- `mongodb`
- `mqtt`
- `mysql2`
- `tunnel-ssh`
- `zod`

## 安全建議

正式上線前建議至少完成：

1. 替換預設帳密並定期輪替秘密資訊。
2. 為 MCP 帳號套用最小權限原則。
3. 透過 `.env` 操作旗標限制高風險行為（例如停用 delete）。
4. 限制檔案系統可讀取範圍。
5. 在可行情況下啟用更嚴格 TLS / 憑證驗證。

## 授權

本專案以示範與學習用途提供（as-is）。
