import { handleAuthRequest } from "@/lib/auth";

// RFC 8414 metadata of the authorization server, whose issuer is the site itself: endpoints, scopes, PKCE and
// client metadata documents.
export { handleAuthRequest as GET };
