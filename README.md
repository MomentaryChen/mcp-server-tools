# MCP Demo Server

A collection of Model Context Protocol (MCP) server implementations for databases, files, HTTP APIs, and message middleware.

> [中文文档](README_zh.md) | [English Documentation](README.md)

## Overview

This repository provides MCP servers you can plug into Cursor or any MCP-compatible client:

- `server.js` - Basic hello-world MCP server
- `server-mysql.js` - MySQL query and CRUD-like operations
- `server-tdengine.js` - TDengine SQL query and data operations via REST
- `server-mongodb.js` - MongoDB query/insert/update/delete/list collections
- `server-read-files.js` - File reading tool
- `server-axios.js` - HTTP GET/POST/PUT/DELETE tools
- `server-mqtt.js` - MQTT subscribe/publish with runtime topic management
- `server-kafka.js` - Kafka consume/publish with runtime subscriptions

## Requirements

- Node.js `18+`
- npm

## Installation

```bash
npm install
cp .env.example .env
```

Use a different env file when needed:

```bash
set ENV_FILE=.env.beta && node server-mysql.js
```

## Environment Configuration

All database servers load config via `dotenv`:

- Default: load `.env` in the project root
- Override: set `ENV_FILE` to another file path
- Template: see `.env.example`

The project supports optional SSH jump tunnels for MySQL, MongoDB, and TDengine using:

- `SSH_JUMPS` (global jumps)
- `MYSQL_SSH_JUMPS`, `MONGO_SSH_JUMPS`, `TDENGINE_SSH_JUMPS` (service-specific jumps)

## Tool Matrix

### `server.js`
- `say_hello`

### `server-mysql.js` (`mysql-tools`)
- `query_mysql`
- `insert_mysql`
- `update_mysql`
- `delete_mysql`

### `server-tdengine.js` (`tdengine-tools`)
- `query_tdengine`
- `insert_tdengine`
- `update_tdengine`
- `delete_tdengine`

### `server-mongodb.js` (`mongo_db-tools`)
- `query_mongo`
- `mongo_insert`
- `mongo_update`
- `mongo_delete`
- `list_mongo_collections`

### `server-read-files.js` (`file-tools`)
- `readFile`

### `server-axios.js` (`axios-tools`)
- `call_api_get`
- `call_api_post`
- `call_api_put`
- `call_api_delete`

### `server-mqtt.js` (`mqtt-tools`)
- `mqtt_status`
- `mqtt_get_messages`
- `mqtt_publish`
- `mqtt_subscribe`
- `mqtt_subscribe_batch`
- `mqtt_unsubscribe`
- `mqtt_clear_messages`

### `server-kafka.js` (`kafka-tools`)
- `kafka_status`
- `kafka_publish`
- `kafka_subscribe`
- `kafka_get_messages`
- `kafka_clear_messages`

## Run Servers

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

## Cursor MCP Config Example

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

## Main Dependencies

- `@modelcontextprotocol/sdk`
- `axios`
- `dotenv`
- `kafkajs`
- `mongodb`
- `mqtt`
- `mysql2`
- `tunnel-ssh`
- `zod`

## Security Notes

Before production use:

1. Replace default credentials and rotate secrets.
2. Restrict database privileges for MCP accounts.
3. Limit operation flags in `.env` (for example disable delete).
4. Restrict filesystem access scope.
5. Enable stronger TLS/certificate verification where applicable.

## License

Provided as-is for demonstration and learning purposes.
