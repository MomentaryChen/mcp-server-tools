import axios from "axios";

// Shared client: keep-alive connection reuse across tool calls.
const client = axios.create({ timeout: 30000 });

export const DEFAULT_MAX_RESPONSE_CHARS = 100000;

// Cap the response body of an apiRequest() result at maxChars characters. A body over the
// limit is serialized (JSON for objects) and cut: data becomes that string prefix, with
// dataTruncated: true and dataLength (serialized length). Smaller bodies are left untouched.
export function capResponseData(result, maxChars = DEFAULT_MAX_RESPONSE_CHARS) {
  const { data } = result;
  if (data === undefined || data === null) {
    return result;
  }
  const serialized = typeof data === "string" ? data : JSON.stringify(data);
  if (serialized === undefined || serialized.length <= maxChars) {
    return result;
  }
  return { ...result, data: serialized.slice(0, maxChars), dataTruncated: true, dataLength: serialized.length };
}

export async function apiRequest(method, url, data = null, headers = {}) {
  try {
    // Default Content-Type to application/json when sending a body without one.
    const requestHeaders = { ...headers };
    if (data && !requestHeaders["Content-Type"] && !requestHeaders["content-type"]) {
      requestHeaders["Content-Type"] = "application/json";
    }

    const response = await client.request({ method, url, data, headers: requestHeaders });
    return { success: true, status: response.status, data: response.data };
  } catch (err) {
    return {
      success: false,
      error: err.message,
      status: err.response?.status,
      data: err.response?.data || err.message
    };
  }
}
