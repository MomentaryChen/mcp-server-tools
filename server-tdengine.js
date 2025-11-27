import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// 🏁 TDengine REST API 連線設定
const TDENGINE_CONFIG = {
  host: "127.0.0.1",
  port: 6041, // REST API 預設端口
  user: "root",
  password: "taosdata"
};

// TDengine REST API 查詢函數
async function queryTDengine(sql) {
  const url = `http://${TDENGINE_CONFIG.host}:${TDENGINE_CONFIG.port}/rest/sql`;
  const auth = Buffer.from(`${TDENGINE_CONFIG.user}:${TDENGINE_CONFIG.password}`).toString('base64');
  
  // 確保 sql 是字符串，處理可能的對象傳入情況
  let sqlString;
  if (typeof sql === 'string') {
    sqlString = sql;
  } else if (sql && typeof sql === 'object' && sql.sql) {
    // 如果傳入的是對象，嘗試提取 sql 屬性
    sqlString = sql.sql;
  } else {
    sqlString = String(sql);
  }
  
  // TDengine REST API 需要直接發送 SQL 字符串，Content-Type 為 text/plain
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'text/plain'
    },
    body: sqlString
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`TDengine query failed: ${response.status} ${response.statusText}\n${errorText}`);
  }

  const result = await response.json();
  return result;
}

const server = new McpServer({ name: "tdengine-tools", version: "1.0.0" });

// 🛠 Tool：SQL 查詢
server.tool(
  "query_tdengine",
  { sql: z.string() },
  async (params) => {
    try {
      // 調試：記錄接收到的參數
      console.error('Received params:', JSON.stringify(params));
      console.error('Params type:', typeof params);
      
      // 提取 sql 參數
      const sql = params?.sql || params;
      console.error('Extracted sql:', sql);
      console.error('SQL type:', typeof sql);
      
      const result = await queryTDengine(sql);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error: ${error.message}` }],
        isError: true
      };
    }
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

