# MCP Demo Server（中文版）

一組模型上下文協議（MCP）伺服器實作，涵蓋資料庫、檔案、HTTP API、消息中介與本機 Outlook 信箱等常見整合場景。

> [English Documentation](README.md) | [中文文档](README_zh.md)

## 概述

本專案可直接接到 Cursor 或其他 MCP 相容客戶端：

- `servers/hello.js` - 基礎 hello-world MCP server
- `servers/mysql.js` - MySQL 查詢與資料寫入工具
- `servers/tdengine.js` - TDengine SQL 查詢與資料操作（REST）
- `servers/mongodb.js` - MongoDB 查詢 / 新增 / 更新 / 刪除 / 列集合
- `servers/files.js` - 檔案讀取工具
- `servers/axios.js` - HTTP GET/POST/PUT/DELETE 工具
- `servers/mqtt.js` - MQTT 訂閱/發布與動態主題管理
- `servers/kafka.js` - Kafka 消費/發布與動態訂閱
- `servers/outlook.js` - 唯讀讀取本機傳統版 Outlook 信箱（Windows）

## 環境需求

- Node.js `18+`
- npm
- 僅 `servers/outlook.js`：Windows，並安裝傳統版 Outlook（Microsoft 365 / Office 16）且已設定好信箱帳號

## 安裝

```bash
npm install
cp .env.example .env
```

如需切換不同環境設定檔，可用 `ENV_FILE`：

```bash
set ENV_FILE=.env.beta && node servers/mysql.js
```

## 環境變數與設定

資料庫類伺服器皆透過 `dotenv` 載入設定：

- 預設讀取專案根目錄 `.env`
- 可用 `ENV_FILE` 指定其他路徑
- 參考模板：`.env.example`

另外支援 MySQL、MongoDB、TDengine、Kafka 的 SSH 跳板連線：

- `SSH_JUMPS`（全域跳板）
- `MYSQL_SSH_JUMPS`、`MONGO_SSH_JUMPS`、`TDENGINE_SSH_JUMPS`、`KAFKA_SSH_JUMPS`（服務專用）

SSH tunnel 每 30 秒送 keepalive；tunnel 斷線（例如 NAT 閒置逾時）時會丟掉對應的連線池 / client，下一次呼叫 tool 自動重連，不需重啟 gateway。

`MYSQL_*_OPERATION`、`MONGO_*_OPERATION`、`TDENGINE_*_OPERATION=false` 的工具不會註冊，client 完全看不到（唯讀 instance 只會出現查詢工具）。

工具結果為不縮排的 JSON。`query_mysql` 回傳 `{ columns, rows, rowCount, truncated }`（每列為陣列，最多 `maxRows` 筆，預設 `MYSQL_MAX_ROWS` = 500）。`query_mongo` 可帶 `projection`、`sort`、`limit`（預設 50，上限 500）。

## 工具清單

### `servers/hello.js`
- `say_hello`

### `servers/mysql.js`（`mysql-tools`）
- `query_mysql`
- `insert_mysql`
- `update_mysql`
- `delete_mysql`

### `servers/tdengine.js`（`tdengine-tools`）
- `query_tdengine`
- `insert_tdengine`
- `update_tdengine`
- `delete_tdengine`

### `servers/mongodb.js`（`mongo_db-tools`）
- `query_mongo`
- `mongo_insert`
- `mongo_update`
- `mongo_delete`
- `list_mongo_collections`

### `servers/files.js`（`file-tools`）
- `readFile`

### `servers/axios.js`（`axios-tools`）
- `call_api_get`
- `call_api_post`
- `call_api_put`
- `call_api_delete`

### `servers/mqtt.js`（`mqtt-tools`）
- `mqtt_status`
- `mqtt_get_messages`
- `mqtt_publish`
- `mqtt_subscribe`
- `mqtt_subscribe_batch`
- `mqtt_unsubscribe`
- `mqtt_clear_messages`

### `servers/kafka.js`（`kafka-tools`）
- `kafka_status`
- `kafka_publish`
- `kafka_subscribe`
- `kafka_get_messages`
- `kafka_clear_messages`

### `servers/outlook.js`（`outlook-tools`）
- `outlook_status`
- `outlook_list_folders`
- `outlook_list_messages`
- `outlook_search_messages`
- `outlook_get_message`

唯讀。透過 PowerShell 執行 `scripts/outlook.ps1`，以 COM 連到本機**傳統版** Outlook，因此需要 Windows，且傳統版 Outlook 已設定好信箱帳號；新版 Outlook for Windows 沒有 COM API，無法使用。資料夾路徑以 `/` 分隔（例如 `Projects/Optim 6`），`inbox`、`sent`、`drafts`、`deleted`、`junk` 代表預設資料夾。郵件 id 為 list / search 回傳的 Outlook EntryID。

每個 instance 會常駐一個 PowerShell 程序（`outlook.ps1 serve`），每次呼叫不必重新啟動 PowerShell、重新連上 COM，整個信箱搜尋時的資料夾清單也會快取。程序在第一次呼叫時啟動，逾時或當掉後自動重啟，閒置超過 `OUTLOOK_IDLE_MS` 就結束。

搜尋：純 ASCII 關鍵字（英文字母、數字、空白）走 Windows Search 索引（`ci_startswith`，整個信箱搜尋比 `LIKE` 快約 10 倍）。它比對的是字首，所以字中間的子字串（例如 `suboptimal` 裡的 `optim`）找不到。含中日韓文字或標點（`-`、`.`、`@`）的關鍵字一律用精確的子字串 `LIKE` 比對，因為索引對中文大多比對不到。設定 `OUTLOOK_SEARCH_MODE=like` 可一律使用 `LIKE`。

| 變數 | 說明 |
|------|------|
| `OUTLOOK_POWERSHELL` | PowerShell 執行檔（預設 `powershell.exe`，也可用 `pwsh`） |
| `OUTLOOK_TIMEOUT_MS` | 單次呼叫逾時；逾時會重啟 PowerShell 程序（預設 `120000`） |
| `OUTLOOK_IDLE_MS` | 閒置超過此時間就結束 PowerShell 程序（預設 `600000`） |
| `OUTLOOK_SEARCH_MODE` | `auto`（純 ASCII 關鍵字走索引）或 `like`（一律子字串比對）（預設 `auto`） |
| `OUTLOOK_FOLDER_CACHE_SECONDS` | 整個信箱搜尋時資料夾清單的快取秒數（預設 `300`） |
| `OUTLOOK_MAX_BODY_CHARS` | `outlook_get_message` 預設回傳的內文長度（預設 `20000`） |

#### Outlook 工具參數

| 工具 | 參數 | 回傳 |
|------|------|------|
| `outlook_status` | — | Exchange 連線狀態、是否離線、帳號、信箱 |
| `outlook_list_folders` | `folder?`（起始資料夾，預設整個信箱）、`maxDepth?`（預設 10） | `[{ path, itemCount, unreadCount }]`（僅郵件資料夾） |
| `outlook_list_messages` | `folder?`（預設 `Inbox`）、`since?`、`until?`、`unreadOnly?`、`limit?`（1–200，預設 20） | 郵件摘要，新到舊 |
| `outlook_search_messages` | `query?`、`field?`（`all` / `subject` / `from` / `body`）、`folder?`、`includeSubfolders?`、`since?`、`until?`、`unreadOnly?`、`limit?` | 郵件摘要，新到舊 |
| `outlook_get_message` | `id`（EntryID）、`maxBodyChars?` | 摘要 + `to`、`cc`、`sentOn`、`conversationTopic`、`attachments`（檔名、大小）、`body`、`bodyTruncated` |

郵件摘要欄位：`id`、`folder`、`receivedTime`、`from`、`fromAddress`（SMTP 地址，公司內部 Exchange 寄件者也會轉成 SMTP）、`subject`、`unread`、`hasAttachments`、`categories`、`messageClass`。

- `since` / `until` 接受本機時區的 ISO 日期，例如 `2026-10-01` 或 `2026-10-01T09:00`。
- `query` 為不分大小寫的子字串比對（Outlook DASL `LIKE`）。
- `outlook_search_messages` 未指定 `folder` 時搜尋整個信箱（不含刪除的郵件、垃圾郵件）；指定單一資料夾會快很多。
- 名稱含 `/` 的資料夾會回傳為 `%2F`（例如 `Projects/PON%2FWAN`），可直接用這個路徑查詢。

呼叫範例：

```json
{ "tool": "outlook_list_messages", "arguments": { "folder": "inbox", "unreadOnly": true, "limit": 10 } }
{ "tool": "outlook_search_messages", "arguments": { "query": "Health Score", "field": "subject", "since": "2026-10-01" } }
{ "tool": "outlook_search_messages", "arguments": { "query": "ORC", "folder": "Projects/Optim 6", "includeSubfolders": true } }
{ "tool": "outlook_get_message", "arguments": { "id": "<list / search 回傳的 EntryID>", "maxBodyChars": 5000 } }
```

#### Outlook 疑難排解

- **`connectionMode` 為 `400` / `offline` 為 `true`**：傳統版 Outlook 與 Exchange 斷線或處於「離線工作」。仍可從本機快取（OST）讀取，但資料可能不是最新；請關閉「傳送/接收 → 離線工作」。
- **第一次呼叫較慢**：若 Outlook 尚未開啟，會先在背景啟動。
- **只找得到近期郵件**：快取模式只下載一段時間（例如 1 年），可在「檔案 → 帳戶設定 →（帳號）→ 下載過去 X 的電子郵件」調整。
- **只用新版 Outlook**：需安裝 / 開啟傳統版 Outlook 並加入帳號一次；兩個版本可同時開啟。

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
node servers/hello.js
node servers/mysql.js
node servers/tdengine.js
node servers/mongodb.js
node servers/files.js
node servers/axios.js
node servers/mqtt.js --host alpha --topics "/events/#"
node servers/kafka.js --brokers localhost:9092 --topics OC_EVENTS,OC_METRICS
node servers/outlook.js
```

使用環境設定檔啟動：

```bash
set ENV_FILE=.env.alpha && node servers/kafka.js
```

## Cursor MCP 設定範例

```json
{
  "mcpServers": {
    "mysql-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/servers/mysql.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env" }
    },
    "tdengine-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/servers/tdengine.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env" }
    },
    "mongo-db-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/servers/mongodb.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env" }
    },
    "outlook-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/serversoutlook.js"]
    },
    "kafka-alpha-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/servers/kafka.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env.alpha" }
    },
    "kafka-beta-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/servers/kafka.js"],
      "env": { "ENV_FILE": "D:/projects/mcp-demo-server/.env.beta" }
    }
  }
}
```

## Claude Code 註冊範例

```bash
claude mcp add outlook-tools --scope user -- node "D:\projects\mcp-demo-server\servers\outlook.js"
claude mcp add mysql-alpha-tools --scope user -e ENV_FILE=D:/projects/mcp-demo-server/.env.alpha -- node "D:\projects\mcp-demo-server\servers\mysql.js"
claude mcp list
```

## 共用 HTTP Gateway（Claude Code 建議用法）

用 stdio 時，每個 client 會各自 spawn 一份所有 server：23 個 server x N 個 Claude CLI 視窗 = 23N 個 node process。
`gateway.js` 只跑**一個**常駐 process，透過 MCP Streamable HTTP 提供所有 server：

```
Claude CLI #1 ─HTTP─┐
Claude CLI #2 ─HTTP─┼─> gateway.js（1 個 node process）── http://127.0.0.1:3800/<instance>/mcp
Claude CLI #3 ─HTTP─┘
```

- 每個 client 有自己的 MCP session；DB 連線池、SSH tunnel、broker 連線每個 instance 只建一次（第一次呼叫 tool 時才建），大家共用。
- Client 保持連線時 session 不會被清；client 斷線後閒置超過 `sessionIdleMinutes`（預設 30 分鐘）就回收。之後 client 再回來會收到 404 並自動重新建立 session。
- 只綁 `127.0.0.1`，並拒絕非本機的 `Host` header。
- MQTT / Kafka instance 的連線、訂閱清單與訊息暫存由所有 session 共用。
- Log：`logs/gateway.log`。狀態：`http://127.0.0.1:3800/health`。

設定：

```bash
cp gateway.config.example.json gateway.config.json   # 每個 instance 一筆：module、envFile、args
node gateway.js                                       # 前景測試
node scripts/gateway-smoke-test.js                    # 列出每個 instance 的 tools
```

開機（登入）自動啟動（Windows 工作排程器，無視窗、掛掉自動重啟）：

```powershell
powershell -ExecutionPolicy Bypass -File scripts\gateway-task.ps1 install   # 另有 start | stop | restart | status | uninstall
```

在 Claude Code 註冊（tool 名稱與 stdio 版相同）：

```bash
claude mcp add --transport http --scope user mysql-alpha-tools http://127.0.0.1:3800/mysql-alpha-tools/mcp
```

修改 `gateway.config.json` 或 `.env.*` 後，執行 `gateway-task.ps1 restart`。

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
6. `outlook-tools` 會把信箱內容提供給 MCP 客戶端，請只註冊到信任的客戶端。此 server 為唯讀，沒有寄信 / 移動 / 刪除功能。

## 授權

本專案以示範與學習用途提供（as-is）。
