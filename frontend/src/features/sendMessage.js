import api from "../../utils/axios";

async function sendMessage(payload) {
  try {
    const response = await api.post("/api/agent/chat", payload);
    return {
      success: true,
      data: response.data,
      headers: response.headers,
    };
  } catch (error) {
    console.error("Message request error:", error);
    return {
      success: false,
      status: error.response?.status || 500,
      data: error.response?.data || null,
      headers: error.response?.headers || {},
      message: error.response?.data?.message || error.message || "Failed to send message",
    };
  }
}

export default sendMessage;
