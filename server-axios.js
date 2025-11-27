import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiRequest } from "./axios.js";

const server = new McpServer({
    name: "axios-tools",
    version: "1.0.0"
});

/* 🔥 define MCP tools */

// GET
server.tool(
    "call_api_get",
    {
        url: z.string(),
        headers: z.any().optional()
    },
    async ({ url, headers = {} }) => {
        const result = await apiRequest("get", url, null, headers);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
    }
);

// POST
server.tool(
    "call_api_post",
    {
        url: z.string(),
        body: z.string(),
        headers: z.string()
    },
    async ({ url, body, headers }) => {

        // 將 body 當作 string 處理，然後轉換為對象
        let parsedBody = body || {};
        
        // 如果 body 是字符串，嘗試解析為 JSON
        if (typeof body === 'string') {
            try {
                // 移除可能的空白字符
                const trimmedBody = body.trim();
                // 如果是空字符串，設為空對象
                if (trimmedBody === '' || trimmedBody === '{}') {
                    parsedBody = {};
                } else {
                    // 嘗試解析 JSON
                    parsedBody = JSON.parse(trimmedBody);
                }
            } catch (e) {
                // 如果解析失敗，嘗試作為普通字符串處理
                parsedBody = { data: body };
            }
        }
        
        // 如果 body 是 undefined 或 null，設為空對象
        if (body === undefined || body === null) {
            parsedBody = {};
        }
        
        // Debug info
        const debugInfo = {
            receivedBody: body,
            bodyType: typeof body,
            parsedBody: parsedBody,
            parsedBodyType: typeof parsedBody
        };
        
        const result = await apiRequest("post", url, parsedBody, headers);
        
        return {
            content: [{ 
                type: "text", 
                text: JSON.stringify({
                    ...result,
                    debug: debugInfo,
                    request: {
                        url,
                        body: parsedBody,
                        headers
                    }
                }, null, 2) 
            }]
        };
    }
);

// PUT / UPDATE
server.tool(
    "call_api_put",
    {
        url: z.string(),
        body: z.any().optional(),
        headers: z.any().optional()
    },
    async ({ url, body = {}, headers = {} }) => {
        // 將 body 當作 string 處理，然後轉換為對象
        let parsedBody = body;
        
        // 如果 body 是字符串，嘗試解析為 JSON
        if (typeof body === 'string') {
            try {
                const trimmedBody = body.trim();
                if (trimmedBody === '' || trimmedBody === '{}') {
                    parsedBody = {};
                } else {
                    parsedBody = JSON.parse(trimmedBody);
                }
            } catch (e) {
                parsedBody = { data: body };
            }
        }
        
        if (body === undefined || body === null) {
            parsedBody = {};
        }
        
        const result = await apiRequest("put", url, parsedBody, headers);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
    }
);

// DELETE
server.tool(
    "call_api_delete",
    {
        url: z.string(),
        headers: z.any().optional()
    },
    async ({ url, headers = {} }) => {
        const result = await apiRequest("delete", url, null, headers);
        return {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
    }
);

const transport = new StdioServerTransport();
await server.connect(transport);

console.log("✅ MCP Server 已啟動，axios-tools 可使用");