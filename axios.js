import axios from "axios";

export async function apiRequest(method, url, data = null, headers = {}) {
    try {
        // Set default Content-Type to application/json if body is provided and no Content-Type header exists
        const requestHeaders = { ...headers };
        if (data && !requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
            requestHeaders['Content-Type'] = 'application/json';
        }
        
        const response = await axios({
            method,
            url,
            data,
            headers: requestHeaders,
            timeout: 30000
        });
        
        return {
            success: true,
            status: response.status,
            data: response.data
        };
    } catch (err) {
        return {
            success: false,
            error: err.message,
            status: err.response?.status,
            data: err.response?.data || err.message
        };
    }
}
