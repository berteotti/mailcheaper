import { handleAuthRequest } from "@/lib/auth";

// Better Auth's routes: the Google callback, sessions, sign-out, and OAuth for MCP clients (authorize, token,
// revoke, the signing keys).
export { handleAuthRequest as GET, handleAuthRequest as POST };
