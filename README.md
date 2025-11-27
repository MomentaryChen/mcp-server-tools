# MCP Demo Server

A collection of Model Context Protocol (MCP) server implementations demonstrating various capabilities including database queries and file operations.

## Overview

This project contains multiple MCP server implementations that can be used with Cursor or other MCP-compatible clients:

- **Basic Demo Server** (`server.js`) - Simple hello world example
- **MySQL Tools** (`server-mysql.js`) - Execute SQL queries against MySQL databases
- **TDengine Tools** (`server-tdengine.js`) - Execute SQL queries against TDengine time-series databases
- **File Tools** (`server-read-files.js`) - Read files from the filesystem

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
  password: "your_password",
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
  password: "taosdata"
};
```

**Usage:**
```bash
node server-tdengine.js
```

**Available Tools:**
- `query_tdengine` - Execute SQL queries against TDengine database
  - Parameters: `sql` (string) - SQL query to execute

### 4. File Tools Server (`server-read-files.js`)

MCP server for reading files from the filesystem.

**Usage:**
```bash
node server-read-files.js
```

**Available Tools:**
- `readFile` - Read file contents from the filesystem
  - Parameters: `path` (string) - File path to read

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
    "file-tools": {
      "command": "node",
      "args": ["D:/projects/mcp-demo-server/server-read-files.js"]
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
├── server-read-files.js   # File reading tools
├── package.json           # Project dependencies
└── README.md              # This file
```

## Features

- ✅ Multiple MCP server implementations
- ✅ Database query support (MySQL, TDengine)
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
