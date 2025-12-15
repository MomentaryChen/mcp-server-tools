# MCP Demo Server

A collection of Model Context Protocol (MCP) server implementations demonstrating various capabilities including database queries and file operations.

> [中文文档](README_zh.md) | [English Documentation](README.md)

## A Note from the Author · MomentaryChen

These are practical, easy-to-use MCP connection tools designed to help you quickly integrate with databases, file systems, and messaging middleware for data processing and integration. Each tool comes with rich examples and straightforward interfaces, making them suitable for development, testing, or learning. If you find them helpful, please give a like—your support keeps me improving!

## Overview

This project contains multiple MCP server implementations that can be used with Cursor or other MCP-compatible clients:

- **Basic Demo Server** (`server.js`) - Simple hello world example
- **MySQL Tools** (`server-mysql.js`) - Execute SQL queries against MySQL databases
- **TDengine Tools** (`server-tdengine.js`) - Execute SQL queries against TDengine time-series databases
- **MongoDB Tools** (`server-mongodb.js`) - Query, insert, update, delete documents in MongoDB collections
- **File Tools** (`server-read-files.js`) - Read files from the filesystem
- **Axios Tools** (`server-axios.js`) - Make HTTP API requests (GET, POST, PUT, DELETE)
- **MQTT Tools** (`server-mqtt.js`) - Subscribe to and publish MQTT messages
- **Kafka Tools** (`server-kafka.js`) - Consume and publish Kafka messages

## Prerequisites

- Node.js (v18 or later)
- npm or yarn

## Installation

```bash
npm install
```

## Dependencies

- `@modelcontextprotocol/sdk` - MCP SDK for building servers
- `mysql2` - MySQL database driver
- `mongodb` - MongoDB database driver
- `axios` - HTTP client for API requests
- `mqtt` - MQTT client for message subscription and publishing
- `zod` - Schema validation
- `fs` - File system operations (built-in Node.js module)

## Server Configurations

### 1. Basic Demo Server (`server.js`)

A simple MCP server with a `say_hello` tool.

**Usage:**
```bash
node server.js
```

**Available Tools:**
- `say_hello` - Returns a greeting message with the provided name

### 2. MySQL Tools Server (`server-mysql.js`)

MCP server for executing SQL queries against MySQL databases.

**Configuration:**

Edit the database connection settings in `server-mysql.js`:

```javascript
const db = await mysql.createPool({
  host: "127.0.0.1",
  user: "root",
  password: "****",
  database: "your_database"
});
```

**Usage:**
```bash
node server-mysql.js
```

**Available Tools:**
- `query_mysql` - Execute SQL queries against MySQL database
  - Parameters: `sql` (string) - SQL query to execute

### 3. TDengine Tools Server (`server-tdengine.js`)

MCP server for executing SQL queries against TDengine time-series databases via REST API.

**Configuration:**

Edit the TDengine connection settings in `server-tdengine.js`:

```javascript
const TDENGINE_CONFIG = {
  host: "127.0.0.1",
  port: 6041, // REST API default port
  user: "root",
  password: "****"
};
```

**Usage:**
```bash
node server-tdengine.js
```

**Available Tools:**
- `query_tdengine` - Execute SQL queries against TDengine database
  - Parameters: `sql` (string) - SQL query to execute

### 4. MongoDB Tools Server (`server-mongodb.js`)

MCP server for querying and manipulating MongoDB databases.

**Configuration:**

Edit the MongoDB connection settings in `server-mongodb.js`:

```javascript
const uri = "mongodb://username:****@127.0.0.1:27017";
const client = new MongoClient(uri);
await client.connect();
const db = client.db("your_database_name");
```

**Usage:**
```bash
node server-mongodb.js
```

**Available Tools:**
- `query_mongo` - Query documents from a MongoDB collection
  - Parameters: 
    - `collection` (string) - Collection name
    - `query` (object, optional) - MongoDB query filter
- `mongo_insert` - Insert a document into a MongoDB collection
  - Parameters:
    - `collection` (string) - Collection name
    - `document` (object) - Document to insert
- `mongo_update` - Update documents in a MongoDB collection
  - Parameters:
    - `collection` (string) - Collection name
    - `filter` (object) - MongoDB filter to match documents
    - `update` (object) - Update operations
- `mongo_delete` - Delete documents from a MongoDB collection
  - Parameters:
    - `collection` (string) - Collection name
    - `filter` (object) - MongoDB filter to match documents
- `list_mongo_collections` - List all collections in the database
  - Parameters: None

### 5. File Tools Server (`server-read-files.js`)

MCP server for reading files from the filesystem.

**Usage:**
```bash
node server-read-files.js
```

**Available Tools:**
- `readFile` - Read file contents from the filesystem
  - Parameters: `path` (string) - File path to read

### 6. Axios Tools Server (`server-axios.js`)

MCP server for making HTTP API requests.

**Usage:**
```bash
node server-axios.js
```

**Available Tools:**
- `call_api_get` - Make HTTP GET requests
  - Parameters:
    - `url` (string) - API endpoint URL
    - `headers` (object, optional) - HTTP headers as key-value pairs
- `call_api_post` - Make HTTP POST requests
  - Parameters:
    - `url` (string) - API endpoint URL
    - `body` (string) - Request body (will be parsed as JSON if possible)
    - `headers` (string) - HTTP headers as JSON string
- `call_api_put` - Make HTTP PUT requests
  - Parameters:
    - `url` (string) - API endpoint URL
    - `body` (any, optional) - Request body
    - `headers` (object, optional) - HTTP headers as key-value pairs
- `call_api_delete` - Make HTTP DELETE requests
  - Parameters:
    - `url` (string) - API endpoint URL
    - `headers` (object, optional) - HTTP headers as key-value pairs

### 7. MQTT Tools Server (`server-mqtt.js`)

MCP server for subscribing to and publishing MQTT messages.

**Usage:**
```bash
node server-mqtt.js --host alpha --topics "/events/#"
```

**Command Line Arguments:**
- `--host` (required) - MQTT Broker host address
- `--port` (optional) - MQTT Broker port, defaults based on TLS setting (8883 for TLS, 1883 for non-TLS)
- `--topics` (optional) - Topics to subscribe on startup, supports multiple topics (comma-separated) or multiple `--topics` flags. If not provided, topics can be subscribed dynamically via `mqtt_subscribe` tool
- `--username` (optional) - MQTT username
- `--password` (optional) - MQTT password
- `--client-id` (optional) - MQTT client ID, auto-generated by default
- `--no-tls` (optional) - Disable TLS/SSL, use unencrypted connection
- `--ca-cert` (optional) - CA certificate file path (for TLS)
- `--client-cert` (optional) - Client certificate file path (for mutual TLS)
- `--client-key` (optional) - Client key file path (for mutual TLS)

**Usage Examples:**
```bash
# Basic subscription (subscribe on startup, TLS enabled by default, port 8883)
node server-mqtt.js --host alpha --topics "/events/#"

# With TLS and custom port
node server-mqtt.js --host alpha --port 8883 --topics "/events/#"

# Disable TLS, use unencrypted connection (port 1883)
node server-mqtt.js --host alpha --no-tls --topics "/events/#"

# Subscribe to multiple topics on startup
node server-mqtt.js --host alpha --topics "/events/#" --topics "/sensors/+/temperature"

# No initial subscriptions, manage subscriptions dynamically via tools
node server-mqtt.js --host alpha

# With authentication (TLS)
node server-mqtt.js --host alpha --port 8883 --topics "/events/#" --username user --password ****

# With authentication (non-TLS)
node server-mqtt.js --host alpha --port 1883 --no-tls --topics "/events/#" --username user --password ****

# With custom certificates (mutual TLS)
node server-mqtt.js --host alpha --ca-cert ca.crt --client-cert client.crt --client-key client.key --topics "/events/#"

# Custom client ID
node server-mqtt.js --host alpha --topics "/events/#" --client-id my-client-id
```

**TLS/SSL Configuration:**
- ✅ TLS/SSL enabled by default (port 8883)
- ✅ Certificate verification disabled by default (`rejectUnauthorized: false`), suitable for self-signed certificates
- ✅ Supports custom CA certificates, client certificates, and keys
- ✅ Use `--no-tls` option to disable TLS and use unencrypted connection (port 1883)

**Dynamic Subscription Features:**
- ✅ Support dynamic subscription of new topics at runtime via `mqtt_subscribe` tool
- ✅ Support dynamic unsubscription via `mqtt_unsubscribe` tool
- ✅ Support batch subscription of multiple topics
- ✅ Can start without `--topics` parameter and manage subscriptions completely via tools

**Available Tools:**
- `mqtt_status` - Get MQTT connection status and subscription information
  - Parameters: None
- `mqtt_get_messages` - Get received messages
  - Parameters:
    - `limit` (number, optional) - Limit number of messages to return, default 10
    - `topic` (string, optional) - Filter messages by topic, supports wildcards
- `mqtt_publish` - Publish message to specified topic
  - Parameters:
    - `topic` (string) - Target topic
    - `message` (string) - Message content
    - `qos` (number, optional) - Quality of Service level (0-2), default 0
    - `retain` (boolean, optional) - Whether to retain message, default false
- `mqtt_subscribe` - Dynamically subscribe to new topic (runtime subscription)
  - Parameters:
    - `topic` (string) - Topic to subscribe to
    - `qos` (number, optional) - Quality of Service level (0-2), default 0
  - Note: Can subscribe to new topics at runtime without restarting the server
- `mqtt_subscribe_batch` - Batch subscribe to multiple topics
  - Parameters:
    - `topics` (array) - Array of topics to subscribe to
    - `qos` (number, optional) - Quality of Service level (0-2), default 0
  - Note: Subscribe to multiple topics at once, returns subscription result for each topic
- `mqtt_unsubscribe` - Dynamically unsubscribe from topic (runtime unsubscription)
  - Parameters:
    - `topic` (string) - Topic to unsubscribe from
  - Note: Can unsubscribe at runtime without restarting the server
- `mqtt_clear_messages` - Clear message storage
  - Parameters: None

### 8. Kafka Tools Server (`server-kafka.js`)

MCP server for consuming and producing Kafka messages.

**Usage:**
```bash
node server-kafka.js --brokers localhost:9092 --topics demo-topic --group-id cursor-group --from-beginning
```

**Command Line Arguments:**
- `--brokers` (required) - Comma-separated broker list, e.g., `localhost:9092,localhost:9093`; if port is omitted, defaults to 9092
- `--topics` (optional) - Topics to subscribe on startup (comma-separated or multiple `--topics`). You can also subscribe at runtime using `kafka_subscribe`
- `--group-id` (optional) - Consumer group ID, auto-generated by default
- `--client-id` (optional) - Client ID, auto-generated by default
- `--from-beginning` (optional) - Read from earliest offset when subscribing, default false
- `--username` / `--password` (optional) - SASL/PLAIN username & password
- `--ssl` (optional) - Enable SSL/TLS connection

**Usage Examples:**
```bash
# Basic subscription from latest offset
node server-kafka.js --brokers localhost:9092 --topics demo-topic

# Read from earliest offset
node server-kafka.js --brokers localhost:9092 --topics demo-topic --from-beginning

# Subscribe to multiple topics on startup
node server-kafka.js --brokers localhost:9092 --topics topic1,topic2 --topics topic3

# Multiple brokers (high availability)
node server-kafka.js --brokers kafka1:9092,kafka2:9092,kafka3:9092 --topics demo-topic

# No initial topics, manage subscriptions dynamically via tools
node server-kafka.js --brokers localhost:9092

# SASL/PLAIN + TLS
node server-kafka.js --brokers kafka1:9093 --topics secure-topic --ssl --username user --password ****

# Custom consumer group and client ID
node server-kafka.js --brokers localhost:9092 --topics demo-topic --group-id my-group --client-id my-client
```

**Dynamic Subscription Features:**
- ✅ Support dynamic subscription of new topics at runtime via `kafka_subscribe` tool
- ✅ Support setting `fromBeginning` option for each topic individually
- ✅ Can start without `--topics` parameter and manage subscriptions completely via tools
- ✅ Messages stored in memory, maximum 10,000 messages retained

**Available Tools:**
- `kafka_status` - Show producer/consumer connection status and subscribed topics
  - Parameters: None
  - Returns: Connection status, broker list, subscribed topics, consumer group ID, client ID, SSL configuration, message count, etc.
- `kafka_publish` - Publish a message to a topic
  - Parameters:
    - `topic` (string) - Target topic
    - `message` (string) - Message payload
    - `key` (string, optional) - Message key
    - `headers` (record, optional) - Kafka headers (string key/value)
    - `partition` (number, optional) - Target partition
- `kafka_subscribe` - Subscribe to a new topic at runtime (dynamic subscription)
  - Parameters:
    - `topic` (string) - Topic to subscribe
    - `fromBeginning` (boolean, optional) - Read from earliest offset, defaults to the `--from-beginning` setting from startup
  - Note: Can subscribe to new topics at runtime without restarting the server. If consumer is running, it will automatically stop and resubscribe to all topics (including the new one)
- `kafka_get_messages` - Get recently consumed messages (in-memory buffer, max 10,000)
  - Parameters:
    - `limit` (number, optional) - Max items to return, default 10
    - `topic` (string, optional) - Filter by topic
    - `partition` (number, optional) - Filter by partition
  - Returns: Array of messages containing topic, partition, offset, timestamp, key, value, headers, etc.
- `kafka_clear_messages` - Clear cached messages
  - Parameters: None

## MCP Client Configuration

To use these servers with Cursor, add them to your MCP configuration file (typically `~/.cursor/mcp.json`):

### Example Configuration

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

**Note:** Update the file paths to match your actual project location.

## Project Structure

```
mcp-demo-server/
├── server.js              # Basic demo server
├── server-mysql.js        # MySQL database tools
├── server-tdengine.js     # TDengine database tools
├── server-mongodb.js      # MongoDB database tools
├── server-read-files.js   # File reading tools
├── server-axios.js        # HTTP API request tools
├── server-mqtt.js         # MQTT message subscription and publishing tools
├── server-kafka.js        # Kafka message consumption and publishing tools
├── package.json           # Project dependencies
├── README.md              # English documentation
└── README_zh.md           # Chinese documentation
```

## Features

- ✅ Multiple MCP server implementations
- ✅ Database query support (MySQL, TDengine, MongoDB)
- ✅ MongoDB CRUD operations (Create, Read, Update, Delete)
- ✅ HTTP API request support (GET, POST, PUT, DELETE) via Axios
- ✅ MQTT message subscription and publishing with dynamic topic management
- ✅ Kafka message consumption and publishing with runtime subscriptions
- ✅ TLS/SSL support for MQTT connections
- ✅ File system operations
- ✅ Schema validation using Zod
- ✅ Error handling and logging
- ✅ STDIO transport for MCP communication

## Security Notes

⚠️ **Important:** Before deploying to production:

1. Update default database credentials
2. Implement proper authentication and authorization
3. Add input validation and sanitization for SQL queries
4. Restrict file system access to safe directories
5. Use environment variables for sensitive configuration

## License

This project is provided as-is for demonstration purposes.
