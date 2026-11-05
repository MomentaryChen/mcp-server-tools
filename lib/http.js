import axios from "axios";

// Shared client: keep-alive connection reuse across tool calls.
const client = axios.create({ timeout: 30000 });

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
