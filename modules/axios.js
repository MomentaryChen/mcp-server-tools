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

// Accept headers as an object or a JSON string; a non-JSON or empty string means no headers.
function parseHeaders(headers) {
  if (typeof headers !== "string") {
    return headers || {};
  }
  try {
    const parsed = JSON.parse(headers);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// Every tool takes the same optional headers / body shapes. Strings stay accepted for
// existing callers that pass JSON text.
const headersSchema = z.union([z.string(), z.record(z.string(), z.any())]).optional();
const bodySchema = z.union([z.string(), z.record(z.string(), z.any()), z.array(z.any())]).optional();

export default function create() {
  return {
    info: { name: "axios-tools", version: "1.0.0" },

    register(server) {
      // GET
      server.tool(
        "call_api_get",
        {
          url: z.string(),
          headers: headersSchema
        },
        async ({ url, headers }) => asText(await apiRequest("get", url, null, parseHeaders(headers)))
      );

      // POST
      server.tool(
        "call_api_post",
        {
          url: z.string(),
          body: bodySchema,
          headers: headersSchema
        },
        async ({ url, body, headers }) => asText(await apiRequest("post", url, parseBody(body), parseHeaders(headers)))
      );

      // PUT / UPDATE
      server.tool(
        "call_api_put",
        {
          url: z.string(),
          body: bodySchema,
          headers: headersSchema
        },
        async ({ url, body, headers }) => asText(await apiRequest("put", url, parseBody(body), parseHeaders(headers)))
      );

      // DELETE
      server.tool(
        "call_api_delete",
        {
          url: z.string(),
          headers: headersSchema
        },
        async ({ url, headers }) => asText(await apiRequest("delete", url, null, parseHeaders(headers)))
      );
    }
  };
}
