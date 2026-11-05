import { z } from "zod";
import { apiRequest } from "../lib/http.js";
import { jsonResult as asText } from "../lib/common.js";

// Accept a JSON string or object body; fall back to { data: <string> } when not JSON.
function parseBody(body) {
  if (body === undefined || body === null) {
    return {};
  }
  if (typeof body !== "string") {
    return body;
  }
  const trimmedBody = body.trim();
  if (trimmedBody === "" || trimmedBody === "{}") {
    return {};
  }
  try {
    return JSON.parse(trimmedBody);
  } catch {
    return { data: body };
  }
}

export default function create() {
  return {
    info: { name: "axios-tools", version: "1.0.0" },

    register(server) {
      // GET
      server.tool(
        "call_api_get",
        {
          url: z.string(),
          headers: z.any().optional()
        },
        async ({ url, headers = {} }) => asText(await apiRequest("get", url, null, headers))
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
          const parsedBody = parseBody(body);
          const debugInfo = {
            receivedBody: body,
            bodyType: typeof body,
            parsedBody,
            parsedBodyType: typeof parsedBody
          };

          const result = await apiRequest("post", url, parsedBody, headers);
          return asText({
            ...result,
            debug: debugInfo,
            request: { url, body: parsedBody, headers }
          });
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
        async ({ url, body = {}, headers = {} }) =>
          asText(await apiRequest("put", url, parseBody(body), headers))
      );

      // DELETE
      server.tool(
        "call_api_delete",
        {
          url: z.string(),
          headers: z.any().optional()
        },
        async ({ url, headers = {} }) => asText(await apiRequest("delete", url, null, headers))
      );
    }
  };
}
