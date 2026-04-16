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

另外支援 MySQL、MongoDB、TDengine 的 SSH 跳板連線：

- `SSH_JUMPS`（全域跳板）
- `MYSQL_SSH_JUMPS`、`MONGO_SSH_JUMPS`、`TDENGINE_SSH_JUMPS`（服務專用）

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

## 啟動範例

```bash
node server.js
node server-mysql.js
node server-tdengine.js
node server-mongodb.js
node server-read-files.js
node server-axios.js
node server-mqtt.js --host alpha --topics "/events/#"
node server-kafka.js --brokers localhost:9092 --topics demo-topic
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
