import { handleMcpRequest } from "@/lib/mcp/server";

// The same MCP server as /mcp, for clients configured with an /api path.
export { handleMcpRequest as DELETE, handleMcpRequest as GET, handleMcpRequest as POST };
