import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { apiRequest } from "./scripts/axios.js";

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

        // Treat body as string first, then convert to an object.
        let parsedBody = body || {};
        
        // If body is a string, try parsing it as JSON.
        if (typeof body === 'string') {
            try {
                // Trim possible whitespace.
                const trimmedBody = body.trim();
                // Treat empty string as empty object.
                if (trimmedBody === '' || trimmedBody === '{}') {
                    parsedBody = {};
                } else {
                    // Attempt JSON parsing.
                    parsedBody = JSON.parse(trimmedBody);
                }
            } catch (e) {
                // Fall back to plain string payload if parsing fails.
                parsedBody = { data: body };
            }
        }
        
        // Treat undefined/null body as empty object.
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
        // Treat body as string first, then convert to an object.
        let parsedBody = body;
        
        // If body is a string, try parsing it as JSON.
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