# MCP Demo Server（中文版）

一组模型上下文协议（MCP）服务器实现，展示了包括数据库查询和文件操作在内的各种功能。

> [English Documentation](README.md) | [中文文档](README_zh.md)

## 概述

本项目包含多个 MCP 服务器实现，可用于 Cursor 或其他兼容 MCP 的客户端：

- **基础演示服务器** (`server.js`) - 简单的 hello world 示例
- **MySQL 工具** (`server-mysql.js`) - 对 MySQL 数据库执行 SQL 查询
- **TDengine 工具** (`server-tdengine.js`) - 对 TDengine 时序数据库执行 SQL 查询
- **MongoDB 工具** (`server-mongodb.js`) - 查询、插入、更新、删除 MongoDB 集合中的文档
- **文件工具** (`server-read-files.js`) - 从文件系统读取文件

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
  password: "your_password",
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
  password: "taosdata"
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
const uri = "mongodb://username:password@127.0.0.1:27017";
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
├── package.json           # 项目依赖
├── README.md              # 英文文档（English）
└── README_zh.md           # 中文文档（Chinese）
```

## 功能特性

- ✅ 多个 MCP 服务器实现
- ✅ 数据库查询支持（MySQL、TDengine、MongoDB）
- ✅ MongoDB CRUD 操作（创建、读取、更新、删除）
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

